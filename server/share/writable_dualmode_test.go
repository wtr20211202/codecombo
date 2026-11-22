package share

// 双授权模式单测（P-20261121-1 统一收编纪律锁）：申请批准路径的 WS 全链、
// 单持有者语义、两开关独立（持权中关开放直入）、状态端点双字段——与
// writable_test.go 的开放直入单测互补

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/store"

	"github.com/gorilla/websocket"
)

// holdTestEnv 起一个「开放直入关 + 申请通道开」的终端直播子服务（hold 模式
// 单形态：WS 接入只看状态，键入资格随持权）
func holdTestEnv(t *testing.T, token string, sink *fakeWritableSink) (*httptest.Server, *Service) {
	t.Helper()
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-1",
		Name: "live", GuestInputOff: false, // 申请通道缺省开；Writable 缺省关
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithWritableSink(sink)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, svc
}

// TestWritableHoldModeFlow 申请批准路径 WS 全链（必改2 纪律锁）：接入
// mode=hold → 无持权键入帧拒收（input_denied + 不注入）→ 批准授予 →
// direct_state held(mine) 对账 → 持权键入注入 + touch 续期 → 一键收回 →
// direct_revoked + 连接主动断开（必改2）
func TestWritableHoldModeFlow(t *testing.T) {
	sink := &fakeWritableSink{}
	token := fixedToken("wrhold")
	srv, svc := holdTestEnv(t, token, sink)

	c := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v1")
	hello := c.nextFrame(t, 2*time.Second)
	if hello["type"] != "hello" || hello["mode"] != "hold" {
		t.Fatalf("hello = %v, want mode=hold", hello)
	}
	st := c.nextFrame(t, 2*time.Second)
	if st["type"] != "direct_state" || st["status"] != "none" {
		t.Fatalf("initial state = %v, want none", st)
	}
	// hold 连接不点亮 wtyping（徽标语义=可键入）且不落闸（owner 键盘不让位
	// ——连接在场但无持权）
	if g := sink.gateLog(); len(g) != 0 {
		t.Fatalf("gate log with hold-only conn = %v, want empty", g)
	}
	if svc.WritableState(token) != 0 {
		t.Fatal("wtyping projection must count open conns only")
	}

	// 无持权键入帧 → input_denied + 不注入
	if err := c.conn.WriteMessage(websocket.BinaryMessage, []byte("no-hold")); err != nil {
		t.Fatalf("send: %v", err)
	}
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "input_denied" {
		t.Fatalf("no-hold frame = %v, want input_denied", f)
	}
	time.Sleep(80 * time.Millisecond)
	if w := sink.wrote(); len(w) != 0 {
		t.Fatalf("no-hold frames must not inject, writes=%v", w)
	}

	// 批准授予（装配层入口）→ direct_state held(mine) 推送 + 闸置位（账本
	// direct 来源）
	svc.GrantDirect(token, "v1", "甲")
	st = c.nextFrame(t, 2*time.Second)
	if st["type"] != "direct_state" || st["status"] != "held" || st["mine"] != true {
		t.Fatalf("state after grant = %v, want held+mine", st)
	}
	if g := sink.gateLog(); len(g) != 1 || !g[0] {
		t.Fatalf("gate log after grant = %v, want [true]", g)
	}

	// 持权键入 → 注入
	if err := c.conn.WriteMessage(websocket.BinaryMessage, []byte("echo held\r")); err != nil {
		t.Fatalf("send held: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if w := sink.wrote(); len(w) == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if w := sink.wrote(); len(w) != 1 || w[0] != "sess-1\x00echo held\r" {
		t.Fatalf("held writes = %v", w)
	}
	// 注入即续期：键入后持权仍在滑动时效窗内
	if _, hold := svc.DirectState(token); hold == nil {
		t.Fatal("hold must survive typing (touch renews)")
	}

	// 一键收回 → direct_revoked + 连接断开 + 闸释放
	if _, ok := svc.RevokeDirect(token, "owner"); !ok {
		t.Fatal("revoke failed")
	}
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "direct_revoked" {
		t.Fatalf("revoke frame = %v, want direct_revoked", f)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if g := sink.gateLog(); len(g) >= 2 && !g[len(g)-1] {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if g := sink.gateLog(); len(g) < 2 || g[len(g)-1] {
		t.Fatalf("gate log after revoke = %v, want release", g)
	}
}

// TestWritableHoldTypingDeniedForOthers 单持有者语义：持权绑 visitorId——
// 换人连接的键入帧拒收（旧 POST 端点 403 的控制帧形态）；他人持权对非持权
// 访客可见（held mine=false）
func TestWritableHoldTypingDeniedForOthers(t *testing.T) {
	sink := &fakeWritableSink{}
	token := fixedToken("wrhold2")
	srv, svc := holdTestEnv(t, token, sink)
	svc.GrantDirect(token, "v1", "")

	c2 := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v2")
	if f := c2.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("frame = %v", f)
	}
	st := c2.nextFrame(t, 2*time.Second)
	if st["type"] != "direct_state" || st["status"] != "held" || st["mine"] != false {
		t.Fatalf("other visitor state = %v, want held mine=false", st)
	}
	if err := c2.conn.WriteMessage(websocket.BinaryMessage, []byte("intruder")); err != nil {
		t.Fatalf("send: %v", err)
	}
	if f := c2.nextFrame(t, 2*time.Second); f["type"] != "input_denied" {
		t.Fatalf("other-visitor frame = %v, want input_denied", f)
	}
	time.Sleep(80 * time.Millisecond)
	if w := sink.wrote(); len(w) != 0 {
		t.Fatalf("non-holder frames must not inject, writes=%v", w)
	}
}

// TestWritableHoldSurvivesWritableDown 两开关独立（用户定案）：持权中开关
// 翻转不伤持权——场景 = 申请批准路径持权在先（Writable 关），owner 开启
// 开放直入又关闭（必改9 组合场景「持权中关开放直入」）：开放连接断开
// （writable_off）、持权连接不受影响（键入仍注入、闸保持）。连接模式按
// 接入时点定格（字段翻转不断开既有连接）——先于开关开启接入的持权连接
// 保持 hold 模式
func TestWritableHoldSurvivesWritableDown(t *testing.T) {
	sink := &fakeWritableSink{}
	token := fixedToken("wrmix")
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-1",
		Name: "live", // Writable 关 + 申请通道缺省开：先走申请批准路径
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithWritableSink(sink)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	// 持权连接先在场（hold 模式），批准授予
	cHold := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v-hold")
	if f := cHold.nextFrame(t, 2*time.Second); f["type"] != "hello" || f["mode"] != "hold" {
		t.Fatalf("hold hello = %v", f)
	}
	if st := cHold.nextFrame(t, 2*time.Second); st["type"] != "direct_state" || st["status"] != "none" {
		t.Fatalf("hold initial state = %v", st)
	}
	svc.GrantDirect(token, "v-hold", "乙")
	if st := cHold.nextFrame(t, 2*time.Second); st["status"] != "held" {
		t.Fatalf("hold state after grant = %v", st)
	}
	if g := sink.gateLog(); len(g) != 1 || !g[0] {
		t.Fatalf("gate log after grant = %v, want [true]", g)
	}

	// owner 开启开放直入（记录翻转——既有持权连接不断开、保持 hold 模式），
	// 新访客接入即 open 模式
	shares[token].Writable = true
	cOpen := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v-open")
	if f := cOpen.nextFrame(t, 2*time.Second); f["type"] != "hello" || f["mode"] != "open" {
		t.Fatalf("open hello = %v", f)
	}
	// 第二来源（ws）入场：闸已由 direct 来源点亮，账本不翻转（合并账本语义
	// ——翻转只在零来源→有来源）
	if g := sink.gateLog(); len(g) != 1 {
		t.Fatalf("gate log after open conn = %v, want no flip", g)
	}

	// owner 关闭开放直入（all=false 选择性清场）
	if !svc.WritableDown(token, false) {
		t.Fatal("writable down = false")
	}
	if f := cOpen.nextFrame(t, 2*time.Second); f["type"] != "writable_off" {
		t.Fatalf("open conn frame = %v, want writable_off", f)
	}
	// 持权连接无 writable_off（授权物独立）；键入仍注入
	time.Sleep(80 * time.Millisecond)
	if err := cHold.conn.WriteMessage(websocket.BinaryMessage, []byte("still here\r")); err != nil {
		t.Fatalf("send after down: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if w := sink.wrote(); len(w) == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if w := sink.wrote(); len(w) != 1 {
		t.Fatalf("hold conn writes after writable down = %v", w)
	}
	// 闸保持（direct 来源仍在——不得误归还 owner 键盘给持权访客）
	if g := sink.gateLog(); len(g) != 1 {
		t.Fatalf("gate log after down = %v, want no release (hold source present)", g)
	}
	// 收回持权（direct 来源离场）→ 闸翻转释放
	if _, ok := svc.RevokeDirect(token, "owner"); !ok {
		t.Fatal("revoke failed")
	}
	if g := sink.gateLog(); len(g) != 2 || g[1] {
		t.Fatalf("gate log after revoke = %v, want [true,false]", g)
	}
}

// TestWritableStateEndpointDualMode 状态端点双字段（增量扩展）：writable=
// 开放直入开关、guestInput=申请通道在场（反向极性投影）；全关 = WS 404
func TestWritableStateEndpointDualMode(t *testing.T) {
	token := fixedToken("wrstate")
	// 全关（通道显式关 + 开放直入关）：两字段 false，WS 404
	srv, _ := guestTestEnv(t, token, true, nil)
	res, body := getJSON(t, srv.URL, "/s/"+token+"/writable/state")
	if res.StatusCode != http.StatusOK || body["writable"] != false || body["guestInput"] != false {
		t.Fatalf("all-off state = %d %v", res.StatusCode, body)
	}
	if _, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v1", nil); err == nil {
		t.Fatal("termws with both modes off must not upgrade")
	}
	// 申请通道开（缺省）+ 开放直入关：guestInput=true
	srv2, _ := guestTestEnv(t, fixedToken("wrstate2"), false, nil)
	tok2 := fixedToken("wrstate2")
	res, body = getJSON(t, srv2.URL, "/s/"+tok2+"/writable/state")
	if res.StatusCode != http.StatusOK || body["writable"] != false || body["guestInput"] != true {
		t.Fatalf("hold-only state = %d %v", res.StatusCode, body)
	}
}
