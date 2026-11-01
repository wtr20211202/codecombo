package share

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

// 直通输入档（P-20261024-1 第二档）纪律锁：单持有者握手（申请 60s 时效/
// 批准换人）、持权绑 visitorId、10min 滑动时效、agent 会话限定拒绝面、
// 4KB 上限、频控——四闸逐条可执行化

// fakeDirectSink DirectSink 测试替身（记录写入批次与闸迁移）
type fakeDirectSink struct {
	writes []string
	gates  map[string][]bool
	kind   string // DirectSessionInfo 返回的 kind；"" = 会话不存在
	err    error
}

func (f *fakeDirectSink) DirectWrite(sessionID, text string) error {
	if f.err != nil {
		return f.err
	}
	f.writes = append(f.writes, sessionID+"\x00"+text)
	return nil
}

func (f *fakeDirectSink) DirectSessionInfo(sessionID string) (string, bool) {
	if f.kind == "" {
		return "", false
	}
	return f.kind, true
}

func (f *fakeDirectSink) SetDirectGate(sessionID string, locked bool) {
	if f.gates == nil {
		f.gates = map[string][]bool{}
	}
	f.gates[sessionID] = append(f.gates[sessionID], locked)
}

// directTestEnv 起一个开了直通档的终端直播访客子服务（httptest；返回
// Service 实例供持权状态机断言——状态机与 HTTP 面必须同一实例）
func directTestEnv(t *testing.T, token string, on bool, sink *fakeDirectSink) (*httptest.Server, *Service) {
	t.Helper()
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-1",
		Name: "live", DirectInput: on,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithDirectSink(sink)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, svc
}

func postJSON(t *testing.T, base, path, body string) (*http.Response, map[string]any) {
	t.Helper()
	res, err := http.Post(base+path, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post %s: %v", path, err)
	}
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	res.Body.Close()
	return res, out
}

func getJSON(t *testing.T, base, path string) (*http.Response, map[string]any) {
	t.Helper()
	res, err := http.Get(base + path)
	if err != nil {
		t.Fatalf("get %s: %v", path, err)
	}
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	res.Body.Close()
	return res, out
}

func TestDirectToggleGate(t *testing.T) {
	sink := &fakeDirectSink{kind: "agent"}
	// 开关关闭：三端点恒 404（存在性不可探测）
	srv, _ := directTestEnv(t, fixedToken("dirgate"), false, sink)
	for _, c := range []struct{ method, path string }{
		{"POST", "/direct/request"},
		{"GET", "/direct/state?visitorId=v1"},
		{"POST", "/direct/input"},
	} {
		var res *http.Response
		if c.method == "POST" {
			res, _ = postJSON(t, srv.URL, "/s/"+fixedToken("dirgate")+c.path, `{"visitorId":"v1"}`)
		} else {
			res, _ = getJSON(t, srv.URL, "/s/"+fixedToken("dirgate")+c.path)
		}
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("%s %s = %d, want 404", c.method, c.path, res.StatusCode)
		}
	}
}

func TestDirectHandshakeAndInput(t *testing.T) {
	sink := &fakeDirectSink{kind: "agent"}
	token := fixedToken("dirflow")
	srv, svc := directTestEnv(t, token, true, sink)

	// 未持权直接输入 → 403 direct_denied
	res, _ := postJSON(t, srv.URL, "/s/"+token+"/direct/input", `{"visitorId":"v1","text":"hi"}`)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("input without grant = %d, want 403", res.StatusCode)
	}

	// 空visitorId 申请 → 400
	res, _ = postJSON(t, srv.URL, "/s/"+token+"/direct/request", `{"visitorId":"  "}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty visitor = %d, want 400", res.StatusCode)
	}

	// 申请 → pending（本 visitorId 可见）
	res, out := postJSON(t, srv.URL, "/s/"+token+"/direct/request", `{"visitorId":"v1","nickname":"测试员"}`)
	if res.StatusCode != 200 || out["status"] != "pending" {
		t.Fatalf("request = %d %v", res.StatusCode, out)
	}
	res, st := getJSON(t, srv.URL, "/s/"+token+"/direct/state?visitorId=v1")
	if res.StatusCode != 200 || st["status"] != "pending" {
		t.Fatalf("state after request = %d %v", res.StatusCode, st)
	}
	// 别的访客看不到「pending 是我的」
	_, st2 := getJSON(t, srv.URL, "/s/"+token+"/direct/state?visitorId=v2")
	if st2["status"] != "none" {
		t.Fatalf("other visitor sees pending as own: %v", st2)
	}

	// 批准（装配层入口）→ 持权
	hold := svc.GrantDirect(token, "v1", "测试员")
	if hold == nil || hold.VisitorID != "v1" {
		t.Fatalf("grant = %+v", hold)
	}
	_, st = getJSON(t, srv.URL, "/s/"+token+"/direct/state?visitorId=v1")
	if st["status"] != "held" || st["mine"] != true {
		t.Fatalf("state after grant = %v", st)
	}
	_, st = getJSON(t, srv.URL, "/s/"+token+"/direct/state?visitorId=v2")
	if st["status"] != "held" || st["mine"] != false {
		t.Fatalf("other visitor state after grant = %v", st)
	}

	// 输入批次（持权访客）→ 落 sink + 续期；换人 → 403
	res, out = postJSON(t, srv.URL, "/s/"+token+"/direct/input", `{"visitorId":"v1","text":"第 3 行报错了"}`)
	if res.StatusCode != 200 || out["ok"] != true {
		t.Fatalf("input = %d %v", res.StatusCode, out)
	}
	if len(sink.writes) != 1 || !strings.Contains(sink.writes[0], "sess-1") {
		t.Fatalf("sink writes = %v", sink.writes)
	}
	res, _ = postJSON(t, srv.URL, "/s/"+token+"/direct/input", `{"visitorId":"v2","text":"hi"}`)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("other visitor input = %d, want 403", res.StatusCode)
	}

	// 单持有者换人：重批 = 转移（v2 输入可达，v1 失权）
	if svc.GrantDirect(token, "v2", "乙") == nil {
		t.Fatalf("re-grant failed")
	}
	res, _ = postJSON(t, srv.URL, "/s/"+token+"/direct/input", `{"visitorId":"v1","text":"still?"}`)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("old holder input = %d, want 403", res.StatusCode)
	}
	res, _ = postJSON(t, srv.URL, "/s/"+token+"/direct/input", `{"visitorId":"v2","text":"new holder"}`)
	if res.StatusCode != 200 {
		t.Fatalf("new holder input = %d", res.StatusCode)
	}

	// 一键收回 → 双访客 403
	if _, ok := svc.RevokeDirect(token, "owner"); !ok {
		t.Fatalf("revoke must report an actual hold")
	}
	if _, ok := svc.RevokeDirect(token, "owner"); ok {
		t.Fatalf("revoke must be idempotent")
	}
	res, _ = postJSON(t, srv.URL, "/s/"+token+"/direct/input", `{"visitorId":"v2","text":"again"}`)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("input after revoke = %d, want 403", res.StatusCode)
	}
}

func TestDirectInputValidation(t *testing.T) {
	sink := &fakeDirectSink{kind: "agent"}
	token := fixedToken("dirval")
	srv, svc := directTestEnv(t, token, true, sink)
	svc.GrantDirect(token, "v1", "")

	// 空文本 400
	res, _ := postJSON(t, srv.URL, "/s/"+token+"/direct/input", `{"visitorId":"v1","text":"  \n "}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty input = %d, want 400", res.StatusCode)
	}
	// 超 4KB 400
	big := `{"visitorId":"v1","text":"` + strings.Repeat("字", MaxDirectInputBytes) + `"}`
	res, _ = postJSON(t, srv.URL, "/s/"+token+"/direct/input", big)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversize input = %d, want 400", res.StatusCode)
	}
	// 恰 4KB 内合法（CJK 3 字节/字 × 1000 = 3000 字节）
	ok := `{"visitorId":"v1","text":"` + strings.Repeat("字", 1000) + `"}`
	res, _ = postJSON(t, srv.URL, "/s/"+token+"/direct/input", ok)
	if res.StatusCode != 200 {
		t.Fatalf("valid input = %d", res.StatusCode)
	}
	// 会话消失 → 410 target_gone
	sink2 := &fakeDirectSink{kind: "agent", err: errors.New("session gone")}
	srv2, svc2 := directTestEnv(t, fixedToken("dirgone"), true, sink2)
	svc2.GrantDirect(fixedToken("dirgone"), "v1", "")
	res, _ = postJSON(t, srv2.URL, "/s/"+fixedToken("dirgone")+"/direct/input", `{"visitorId":"v1","text":"x"}`)
	if res.StatusCode != http.StatusGone {
		t.Fatalf("write failure = %d, want 410", res.StatusCode)
	}
}

func TestDirectIdleExpiry(t *testing.T) {
	sink := &fakeDirectSink{kind: "agent"}
	token := fixedToken("direxp")
	srv, svc := directTestEnv(t, token, true, sink)
	svc.GrantDirect(token, "v1", "")

	// 持权在（LastInputAt=GrantedAt=now）→ held
	_, st := getJSON(t, srv.URL, "/s/"+token+"/direct/state?visitorId=v1")
	if st["status"] != "held" {
		t.Fatalf("fresh hold = %v", st)
	}
	// 时钟回拨 11min（LastInputAt 窗外）→ 惰性回收 + released 回调转发
	svc.direct.mu.Lock()
	for k, h := range svc.direct.holds {
		h.LastInputAt = time.Now().Add(-11 * time.Minute)
		svc.direct.holds[k] = h
	}
	svc.direct.mu.Unlock()
	_, st = getJSON(t, srv.URL, "/s/"+token+"/direct/state?visitorId=v1")
	if st["status"] != "none" {
		t.Fatalf("expired hold = %v", st)
	}
	// 输入也 403
	res, _ := postJSON(t, srv.URL, "/s/"+token+"/direct/input", `{"visitorId":"v1","text":"late"}`)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("input after expiry = %d, want 403", res.StatusCode)
	}
}

func TestDirectRequestExpiry(t *testing.T) {
	sink := &fakeDirectSink{kind: "agent"}
	token := fixedToken("dirreq")
	srv, svc := directTestEnv(t, token, true, sink)
	_, _ = postJSON(t, srv.URL, "/s/"+token+"/direct/request", `{"visitorId":"v1"}`)
	// 时钟回拨 61s → 申请过期
	svc.direct.mu.Lock()
	for k, r := range svc.direct.pending {
		r.At = time.Now().Add(-61 * time.Second)
		svc.direct.pending[k] = r
	}
	svc.direct.mu.Unlock()
	_, st := getJSON(t, srv.URL, "/s/"+token+"/direct/state?visitorId=v1")
	if st["status"] != "none" {
		t.Fatalf("expired request state = %v", st)
	}
	// 无在途申请的批准 → nil（409 面在 api 层）
	if svc.GrantDirect(token, "v1", "") == nil {
		// GrantDirect 是显式授予（装配层判定后调用），不走申请面——恒成功
		t.Fatalf("grant after expiry should still work (explicit grant path)")
	}
}

func TestDirectCascadeRelease(t *testing.T) {
	sink := &fakeDirectSink{kind: "agent"}
	token1, token2 := fixedToken("dircsc1"), fixedToken("dircsc2")
	shares := fakeShares{
		token1: {Token: token1, Kind: store.ShareKindTerminal, TerminalID: "s1", DirectInput: true},
		token2: {Token: token2, Kind: store.ShareKindTerminal, TerminalID: "s2", DirectInput: true},
	}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithDirectSink(sink)
	var released []string
	svc = svc.WithDirectRelease(func(tok, sessionID, reason string) {
		released = append(released, sessionID+"/"+reason)
	})
	svc.GrantDirect(token1, "v1", "")
	svc.GrantDirect(token2, "v2", "")
	// 存活集只含 token1：token2 持权级联回收（cascade 缘由）
	if n := svc.CascadeRelease(map[string]bool{token1: true}); n != 1 {
		t.Fatalf("cascade = %d, want 1", n)
	}
	if len(released) != 1 || released[0] != "s2/cascade" {
		t.Fatalf("released = %v", released)
	}
	if _, hold := svc.DirectState(token2); hold != nil {
		t.Fatalf("token2 hold must be gone")
	}
}
