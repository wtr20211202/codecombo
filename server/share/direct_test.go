package share

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/notification"
	"codecombo/server/store"
)

// 访客输入·申请批准路径（P-20261024-1 直通档，P-20261121-1 统一收编）纪律锁：
// 申请通道默认在场（GuestInputOff 反向极性——零值开/显式关）、单持有者握手
// （申请 10min 时效——P-20261121-2 由 60s 延长，申请到达有通知+广播双路感知/
// 批准换人）、持权绑 visitorId、10min 滑动时效（WS 键入帧续期）、键入统一走
// WS 上行桥（旧 POST 端点退役）、收回/过期主动断开该访客 WS、级联回收——
// 逐条可执行化

// guestTestEnv 起一个终端直播访客子服务（httptest；返回 Service 实例供持权
// 状态机与账本断言——状态机/账本与 HTTP 面必须同一实例）。guestInputOff =
// owner 是否显式关闭申请通道（反向极性字段；false=缺省在场）
func guestTestEnv(t *testing.T, token string, guestInputOff bool, sink *fakeWritableSink) (*httptest.Server, *Service) {
	t.Helper()
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-1",
		Name: "live", GuestInputOff: guestInputOff,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil)
	if sink != nil {
		svc = svc.WithWritableSink(sink)
	}
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

// TestGuestRequestChannelGate 申请通道门禁（反向极性字段的可执行锁）：
// 通道显式关（GuestInputOff=true）→ 申请端点恒 404（存在性不可探测）；缺省
// 零值（通道开）→ 端点在场。旧 direct/state 与 direct/input 两端点随统一
// 收编退役——路由已摘除，任何通道态都 404
func TestGuestRequestChannelGate(t *testing.T) {
	token := fixedToken("dircgate")
	// 通道显式关：申请 404
	srv, _ := guestTestEnv(t, token, true, nil)
	res, _ := postJSON(t, srv.URL, "/s/"+token+"/direct/request", `{"visitorId":"v1"}`)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("closed channel request = %d, want 404", res.StatusCode)
	}
	// 退役端点（路由已摘除）：GET direct/state 落全捕获 404；POST direct/
	// input 落路由面 405 第一层保证（POST/PUT 到 /s/* 无写端点路径都是 405，
	// service.go Handler 注记）——两形态都与「端点不在场」同观感
	srv2, _ := guestTestEnv(t, fixedToken("dirret"), false, nil)
	tok2 := fixedToken("dirret")
	if res, _ = getJSON(t, srv2.URL, "/s/"+tok2+"/direct/state?visitorId=v1"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("retired direct/state = %d, want 404", res.StatusCode)
	}
	if res, _ = postJSON(t, srv2.URL, "/s/"+tok2+"/direct/input", `{"visitorId":"v1","text":"hi"}`); res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("retired direct/input = %d, want 405", res.StatusCode)
	}
}

// TestDirectRequestFlow 申请-批准握手全路径（统一后键入面在 WS 桥——本测只
// 锁握手语义：申请登记/审批授予/单持有者换人/一键收回幂等）
func TestDirectRequestFlow(t *testing.T) {
	token := fixedToken("dirflow")
	srv, svc := guestTestEnv(t, token, false, &fakeWritableSink{})

	// 空 visitorId 申请 → 400
	res, _ := postJSON(t, srv.URL, "/s/"+token+"/direct/request", `{"visitorId":"  "}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty visitor = %d, want 400", res.StatusCode)
	}

	// 申请 → pending 登记（管理面 DirectState 投影可见）
	res, out := postJSON(t, srv.URL, "/s/"+token+"/direct/request", `{"visitorId":"v1","nickname":"测试员"}`)
	if res.StatusCode != 200 || out["status"] != "pending" {
		t.Fatalf("request = %d %v", res.StatusCode, out)
	}
	pending, hold := svc.DirectState(token)
	if pending == nil || pending.VisitorID != "v1" || hold != nil {
		t.Fatalf("state after request = %+v / %+v", pending, hold)
	}

	// 批准（装配层入口）→ 持权 + pending 清位
	h := svc.GrantDirect(token, "v1", "测试员")
	if h == nil || h.VisitorID != "v1" {
		t.Fatalf("grant = %+v", h)
	}
	pending, hold = svc.DirectState(token)
	if pending != nil || hold == nil || hold.VisitorID != "v1" {
		t.Fatalf("state after grant = %+v / %+v", pending, hold)
	}

	// 单持有者换人：重批 = 转移
	if svc.GrantDirect(token, "v2", "乙") == nil {
		t.Fatalf("re-grant failed")
	}
	_, hold = svc.DirectState(token)
	if hold == nil || hold.VisitorID != "v2" {
		t.Fatalf("re-grant hold = %+v", hold)
	}

	// 一键收回 → 幂等
	if _, ok := svc.RevokeDirect(token, "owner"); !ok {
		t.Fatalf("revoke must report an actual hold")
	}
	if _, ok := svc.RevokeDirect(token, "owner"); ok {
		t.Fatalf("revoke must be idempotent")
	}
	_, hold = svc.DirectState(token)
	if hold != nil {
		t.Fatalf("hold after revoke = %+v", hold)
	}
}

// TestDirectIdleExpiry 持权滑动时效：10min 无输入（WS 键入帧路径续期）自动
// 回收——惰性清扫 + released 快照（含 visitorID 供该访客 WS 主动断开）
func TestDirectIdleExpiry(t *testing.T) {
	token := fixedToken("direxp")
	_, svc := guestTestEnv(t, token, false, &fakeWritableSink{})
	svc.GrantDirect(token, "v1", "")

	// 持权在（LastInputAt=GrantedAt=now）→ held
	_, hold := svc.DirectState(token)
	if hold == nil {
		t.Fatalf("fresh hold missing")
	}
	// 时钟回拨 11min（LastInputAt 窗外）→ 惰性回收，快照带 visitorID
	svc.direct.mu.Lock()
	for k, h := range svc.direct.holds {
		h.LastInputAt = time.Now().Add(-11 * time.Minute)
		svc.direct.holds[k] = h
	}
	svc.direct.mu.Unlock()
	svc.flushReleasedHolds(nil)
	_, hold = svc.DirectState(token)
	if hold != nil {
		t.Fatalf("expired hold = %+v", hold)
	}
	// 触达惰性清扫（任一次查询）→ released 快照已被 drain，回调/断开路径
	// 无残留
	if rel := svc.direct.drainReleased(); len(rel) != 0 {
		t.Fatalf("released not drained: %+v", rel)
	}
	// 时效纪律锁：持权滑动时效=10min
	if DirectHoldIdleTTL != 10*time.Minute {
		t.Fatalf("DirectHoldIdleTTL = %s, want 10m", DirectHoldIdleTTL)
	}
}

// TestDirectRequestExpiry 申请时效：10min 不决自动过期（P-20261121-2 由 60s
// 延长的纪律锁；悬空申请会顶掉同 token 后到访客的申请位——仍保留时效）
func TestDirectRequestExpiry(t *testing.T) {
	token := fixedToken("dirreq")
	srv, svc := guestTestEnv(t, token, false, nil)
	_, _ = postJSON(t, srv.URL, "/s/"+token+"/direct/request", `{"visitorId":"v1"}`)
	if DirectRequestTTL != 10*time.Minute {
		t.Fatalf("DirectRequestTTL = %s, want 10m (P-20261121-2 ruling)", DirectRequestTTL)
	}
	// 时钟回拨 11min → 申请过期（时延长后过期面语义不变）
	svc.direct.mu.Lock()
	for k, r := range svc.direct.pending {
		r.At = time.Now().Add(-11 * time.Minute)
		svc.direct.pending[k] = r
	}
	svc.direct.mu.Unlock()
	pending, _ := svc.DirectState(token)
	if pending != nil {
		t.Fatalf("expired request = %+v", pending)
	}
	// 显式授予路径不受申请面影响（装配层判定后调用，恒成功）
	if svc.GrantDirect(token, "v1", "") == nil {
		t.Fatalf("grant after expiry should still work (explicit grant path)")
	}
}

// TestDirectRequestArrivalNotice（P-20261121-2 申请-必达）：申请登记成功 =
// 通知中心条目（批准/拒绝行内动作）+ ops 广播回调双路 owner 感知
func TestDirectRequestArrivalNotice(t *testing.T) {
	token := fixedToken("dirnote")
	srv, svc := guestTestEnv(t, token, false, nil)
	var ev DirectRequestEvent
	svc = svc.WithDirectRequestEvents(func(e DirectRequestEvent) { ev = e })
	// WithDirectRequestEvents 原地改字段返回同一实例——httptest handler 与
	// 本地 svc 指针同源，回调接线对子服务即时生效

	res, out := postJSON(t, srv.URL, "/s/"+token+"/direct/request", `{"visitorId":"v1","nickname":"测试员"}`)
	if res.StatusCode != 200 || out["status"] != "pending" {
		t.Fatalf("request = %d %v", res.StatusCode, out)
	}
	// 广播回调：token/昵称/摘要齐备（元数据口径——visitorId 全串不上广播面）
	if ev.Token != token || ev.Nick != "测试员" || ev.VisitorTail != "v1" {
		t.Fatalf("broadcast event = %+v", ev)
	}
	// 通知条目：模板键 + 双动作（批准主动作 payload=token、拒绝第二动作
	// payload=token——批准走缺省取唯一在途、拒绝复用收回端点清 pending）
	notes, _ := svc.notes.Drain()
	if len(notes) != 1 {
		t.Fatalf("notes = %d, want 1", len(notes))
	}
	n := notes[0]
	if n.TitleKey != "share.direct.notify.request.title" || n.BodyKey != "share.direct.notify.request.body" {
		t.Fatalf("note keys = %s / %s", n.TitleKey, n.BodyKey)
	}
	if n.Action != "shdirect-approve" || n.ActionPayload != token {
		t.Fatalf("note action = %s / %s", n.Action, n.ActionPayload)
	}
	if n.SecondAction != "shdirect-deny" || n.SecondActionPayload != token {
		t.Fatalf("note second action = %s / %s", n.SecondAction, n.SecondActionPayload)
	}
	if n.Category != notification.CategorySystem {
		t.Fatalf("note category = %v, want system (grant card same family)", n.Category)
	}
}

// TestDirectCascadeRelease 存活集外持权级联回收（撤销/过期/轮换清账管线）
func TestDirectCascadeRelease(t *testing.T) {
	token1, token2 := fixedToken("dircsc1"), fixedToken("dircsc2")
	shares := fakeShares{
		token1: {Token: token1, Kind: store.ShareKindTerminal, TerminalID: "s1"},
		token2: {Token: token2, Kind: store.ShareKindTerminal, TerminalID: "s2"},
	}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil)
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

// TestGateLedger 会话输入闸合并账本（必改3 纪律锁）：GrantDirect 登记
// "direct:" 来源、RevokeDirect 摘除——闸迁移只在首末来源翻转；同会话双来源
// （direct + ws 模拟）关其一不得误归还 owner 键盘
func TestGateLedger(t *testing.T) {
	token := fixedToken("dirgate2")
	sink := &fakeWritableSink{}
	_, svc := guestTestEnv(t, token, false, sink)

	svc.GrantDirect(token, "v1", "")
	if g := sink.gateLog(); len(g) != 1 || !g[0] {
		t.Fatalf("gate after grant = %v, want [true]", g)
	}
	// 第二来源（模拟 ws 来源在场）：direct 摘除后闸保持（另一模式在场访客
	// 不被误归还键盘）
	svc.gateAcquire("sess-1", "ws:"+token)
	if _, ok := svc.RevokeDirect(token, "owner"); !ok {
		t.Fatalf("revoke failed")
	}
	if g := sink.gateLog(); len(g) != 1 {
		t.Fatalf("gate after revoke with ws source present = %v, want no flip", g)
	}
	// 末个来源离场 → 闸释放
	svc.gateRelease("sess-1", "ws:"+token)
	if g := sink.gateLog(); len(g) != 2 || g[1] {
		t.Fatalf("gate after last source gone = %v, want [true,false]", g)
	}
	// 重复 release 幂等（无翻转无回调）
	svc.gateRelease("sess-1", "ws:"+token)
	if g := sink.gateLog(); len(g) != 2 {
		t.Fatalf("gate after dup release = %v, want unchanged", g)
	}
}
