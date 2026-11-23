package share

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gorilla/websocket"
)

// 可写分享（P-20261106-8）纪律锁：WS 上行桥的五重补偿控制逐条可执行化——
// 开关门禁（404 存在性不可探测）、Origin 同源、帧率双桶、粘贴 danger 审批
//（未批不注入）、断连即释放持权、级联清场

// fakeWritableSink WritableSink 测试替身（记录注入批次与闸迁移）
type fakeWritableSink struct {
	mu     sync.Mutex
	writes []string
	gates  map[string][]bool
	err    error
}

func (f *fakeWritableSink) WritableWrite(sessionID, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.writes = append(f.writes, sessionID+"\x00"+text)
	return nil
}

func (f *fakeWritableSink) wrote() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.writes...)
}

func (f *fakeWritableSink) SetWritableGate(sessionID string, held bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.gates == nil {
		f.gates = map[string][]bool{}
	}
	f.gates[sessionID] = append(f.gates[sessionID], held)
}

func (f *fakeWritableSink) gateLog() []bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bool(nil), f.gates["sess-1"]...)
}

// writableTestEnv 起一个开了可写位的终端直播访客子服务（httptest；直测
// hub 级语义，事件回调就地捕获）
func writableTestEnv(t *testing.T, token string, writable bool, sink *fakeWritableSink) (*httptest.Server, *Service, *[]any) {
	t.Helper()
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-1",
		Name: "live", Writable: writable,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithWritableSink(sink)
	var events []any
	var evMu sync.Mutex
	svc = svc.WithWritableEvents(func(ev WritableTypingEvent) {
		evMu.Lock()
		events = append(events, ev)
		evMu.Unlock()
	})
	svc = svc.WithWritableRiskCheck(func(text string) WritableRisk {
		// 与装配层 pasteRiskCheck 同构的最小桥（danger 判定同源模式表）
		if strings.Contains(text, "rm -rf") || strings.Contains(text, "reset --hard") {
			return WritableRisk{Danger: true, Summary: "risk patterns: high-risk"}
		}
		return WritableRisk{}
	})
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, svc, &events
}

// wsDial 助手：升级 + 交付读通道
type wsClient struct {
	conn   *websocket.Conn
	frames chan string
}

func wsDial(t *testing.T, url string) *wsClient {
	t.Helper()
	hdr := http.Header{}
	hdr.Set("Origin", url) // 同源（test server host 即 URL host）
	conn, _, err := websocket.DefaultDialer.Dial(url, hdr)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	c := &wsClient{conn: conn, frames: make(chan string, 16)}
	go func() {
		defer close(c.frames)
		for {
			typ, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if typ == websocket.TextMessage {
				select {
				case c.frames <- string(msg):
				default:
				}
			}
		}
	}()
	return c
}

func (c *wsClient) nextFrame(t *testing.T, within time.Duration) map[string]any {
	t.Helper()
	select {
	case f, ok := <-c.frames:
		if !ok {
			t.Fatal("ws closed before frame")
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(f), &m); err != nil {
			t.Fatalf("frame %q: %v", f, err)
		}
		return m
	case <-time.After(within):
		t.Fatal("timeout waiting for control frame")
		return nil
	}
}

func TestWSUpgraderSameOrigin(t *testing.T) {
	// 判据与 api/shared.SameOrigin 逐字对齐（升级器就地实现的一致性锚——
	// 两处漂移即红，见 writable.go wsUpgrader 注记）
	cases := []struct {
		origin, host string
	}{
		{"http://localhost:9999", "localhost:9999"}, // 同源放行
		{"", "localhost:9999"},                      // 缺失放行（非浏览器）
		{"http://evil.example.com", "localhost:9999"},
		{"http://localhost:9999.evil.com", "localhost:9999"},
	}
	for _, tc := range cases {
		r := httptest.NewRequest("GET", "http://"+tc.host+"/s/t/termws", nil)
		r.Header.Set("Origin", tc.origin)
		want := shared.SameOrigin(r)
		got := wsUpgrader.CheckOrigin(r)
		if got != want {
			t.Fatalf("origin=%q host=%q: got %v, want api/shared.SameOrigin=%v", tc.origin, tc.host, got, want)
		}
	}
}

func TestWritableToggleGate(t *testing.T) {
	sink := &fakeWritableSink{}
	// 双模式全关（Writable 关 + 申请通道显式关 GuestInputOff=true）：WS 端点
	// 恒 404（存在性不可探测，drop 族同款语义）；状态端如实回 false。
	// P-20261121-1 起单关 Writable 不再 404（申请通道缺省在场——hold 模式
	// 接入，双模式准入见 writable_dualmode_test.go）
	token := fixedToken("wrgate")
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-1",
		Name: "live", GuestInputOff: true, // 两开关全关
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithWritableSink(sink)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	res, body := getJSON(t, srv.URL, "/s/"+token+"/writable/state")
	if res.StatusCode != http.StatusOK || body["writable"] != false {
		t.Fatalf("state with writable off = %d %v", res.StatusCode, body)
	}
	// WS 升级请求 404：gorilla Dialer 收到非 101 握手即失败
	if _, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v1", nil); err == nil {
		t.Fatal("termws with writable off must not upgrade")
	}
}

func TestWritableWSFlow(t *testing.T) {
	sink := &fakeWritableSink{}
	token := fixedToken("wrflow")
	srv, svc, events := writableTestEnv(t, token, true, sink)

	c := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v1&nickname=alice")
	hello := c.nextFrame(t, 2*time.Second)
	if hello["type"] != "hello" {
		t.Fatalf("first frame = %v, want hello", hello)
	}
	// 首条连接：会话闸置位（owner 键盘让位）+ 输入中广播 active=true
	if g := sink.gateLog(); len(g) != 1 || !g[0] {
		t.Fatalf("gate log = %v, want [true]", g)
	}

	// 按键帧注入：字节原样写入 PTY
	if err := c.conn.WriteMessage(websocket.BinaryMessage, []byte("ls\r")); err != nil {
		t.Fatalf("send: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if w := sink.wrote(); len(w) == 1 && w[0] == "sess-1\x00ls\r" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if w := sink.wrote(); len(w) != 1 || w[0] != "sess-1\x00ls\r" {
		t.Fatalf("writes = %v", w)
	}

	// 危险粘贴：命中 danger → paste_review 帧 + 不注入
	if err := c.conn.WriteMessage(websocket.BinaryMessage, []byte("rm -rf /tmp/x\n")); err != nil {
		t.Fatalf("send paste: %v", err)
	}
	fr := c.nextFrame(t, 2*time.Second)
	if fr["type"] != "paste_review" || fr["id"] == "" {
		t.Fatalf("paste frame = %v", fr)
	}
	pid, _ := fr["id"].(string)
	time.Sleep(100 * time.Millisecond)
	if w := sink.wrote(); len(w) != 1 {
		t.Fatalf("danger paste must not inject before approval, writes=%v", w)
	}
	// 批准 → 注入当时提交的整块 + paste_approved 广播
	if !svc.ResolvePasteReview(token, pid, true) {
		t.Fatal("resolve approve = false")
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if w := sink.wrote(); len(w) == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if w := sink.wrote(); len(w) != 2 || w[1] != "sess-1\x00rm -rf /tmp/x\n" {
		t.Fatalf("approved paste writes = %v", w)
	}
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "paste_approved" {
		t.Fatalf("after approve frame = %v", f)
	}
	// 幂等：同一 pasteID 二次决策 → false（决策卡只能点一次）
	if svc.ResolvePasteReview(token, pid, false) {
		t.Fatal("second resolve must be false (already decided)")
	}

	// 断开：末条连接 → 闸解除 + 输入中广播 active=false
	_ = c.conn.Close()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if g := sink.gateLog(); len(g) >= 2 && !g[len(g)-1] {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if g := sink.gateLog(); len(g) < 2 || g[len(g)-1] {
		t.Fatalf("gate log = %v, want release on last disconnect", g)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(*events) >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	evs := *events
	if len(evs) < 2 {
		t.Fatalf("typing events = %d, want >=2", len(evs))
	}
	if ev, ok := evs[len(evs)-1].(WritableTypingEvent); !ok || ev.Active {
		t.Fatalf("last typing event = %+v, want active=false", evs[len(evs)-1])
	}
}

func TestWritablePasteDenyAndTTL(t *testing.T) {
	sink := &fakeWritableSink{}
	token := fixedToken("wrdeny")
	srv, svc, _ := writableTestEnv(t, token, true, sink)
	c := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v1")
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("frame = %v", f)
	}
	if err := c.conn.WriteMessage(websocket.BinaryMessage, []byte("rm -rf /tmp/y\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	fr := c.nextFrame(t, 2*time.Second)
	if fr["type"] != "paste_review" {
		t.Fatalf("frame = %v", fr)
	}
	pid, _ := fr["id"].(string)
	// 拒绝：不注入 + paste_denied 广播
	if !svc.ResolvePasteReview(token, pid, false) {
		t.Fatal("resolve deny = false")
	}
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "paste_denied" {
		t.Fatalf("after deny frame = %v", f)
	}
	time.Sleep(50 * time.Millisecond)
	if w := sink.wrote(); len(w) != 0 {
		t.Fatalf("denied paste must not inject, writes=%v", w)
	}

	// TTL：60s 不决自动拒绝（免 ticker 惰性清扫——下一次触达收口）
	if err := c.conn.WriteMessage(websocket.BinaryMessage, []byte("git reset --hard\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	fr = c.nextFrame(t, 2*time.Second)
	pid2, _ := fr["id"].(string)
	svc.writable.mu.Lock()
	for k, p := range svc.writable.pastes {
		p.At = time.Now().Add(-WritablePasteReviewTTL - time.Second)
		svc.writable.pastes[k] = p
	}
	svc.writable.mu.Unlock()
	if svc.ResolvePasteReview(token, pid2, true) {
		t.Fatal("expired paste must not be resolvable")
	}
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "paste_denied" {
		t.Fatalf("expired frame = %v", f)
	}
	time.Sleep(50 * time.Millisecond)
	if w := sink.wrote(); len(w) != 0 {
		t.Fatalf("expired paste must not inject, writes=%v", w)
	}
}

func TestWritableDownAndCascade(t *testing.T) {
	sink := &fakeWritableSink{}
	token := fixedToken("wrdown")
	other := fixedToken("wrdown2")
	shares := fakeShares{
		token: {Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-1", Name: "live", Writable: true},
		other: {Token: other, Kind: store.ShareKindTerminal, TerminalID: "sess-2", Name: "live2", Writable: true},
	}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithWritableSink(sink)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	c1 := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v1")
	if f := c1.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("frame = %v", f)
	}
	if svc.WritableState(token) != 1 {
		t.Fatal("state must report 1 visitor")
	}
	// WritableDown（owner 开关方向 all=false）：开放连接收到 writable_off 并断开
	if !svc.WritableDown(token, false) {
		t.Fatal("writable down = false")
	}
	if f := c1.nextFrame(t, 2*time.Second); f["type"] != "writable_off" {
		t.Fatalf("down frame = %v", f)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if svc.WritableState(token) == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if svc.WritableState(token) != 0 {
		t.Fatal("conns must be gone after WritableDown")
	}
	// 幂等：再 down 一次 = false
	if svc.WritableDown(token, false) {
		t.Fatal("second down must be false")
	}

	// 级联：keep 集外的 token 清场
	svc2 := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithWritableSink(sink)
	_ = svc2
	c2 := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v2")
	if f := c2.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("frame = %v", f)
	}
	// 另起一个新 Service 实例无法与同一 httptest 复用——级联语义以
	// CascadeWritableDown 的 keep 判据直测：
	if n := svc.CascadeWritableDown(map[string]bool{other: true}); n < 1 {
		t.Fatalf("cascade cleared %d, want >=1", n)
	}
	if svc.CascadeWritableDown(map[string]bool{other: true}) != 0 {
		t.Fatal("second cascade must clear nothing")
	}
}

func TestWritableAuditWindow(t *testing.T) {
	// 审计聚合：WS 帧粒度按键频次不逐帧成账——5s 窗口聚合成一条批次事件
	//（断开兜底另路），台账增速有界；Detail 只含字节数/visitorId 摘要/IP
	// 元数据，文本本体不入账
	sink := &fakeWritableSink{}
	token := fixedToken("wraudit")
	shares := fakeShares{token: {Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-1", Name: "live", Writable: true}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithWritableSink(sink)
	c := &writableConn{token: token, sessionID: "sess-1", visitorID: "v-audit-12345", ip: "203.0.113.9", open: true}
	now := time.Now()
	// 同窗口内两帧：不成账（余量在途）
	if !svc.injectWritable(nil, c, "abc", now) {
		t.Fatal("inject 1 must succeed")
	}
	if !svc.injectWritable(nil, c, "def", now.Add(2*time.Second)) {
		t.Fatal("inject 2 must succeed")
	}
	var events []store.AuditEvent
	n := svc.FlushViewAudits(func(e store.AuditEvent) { events = append(events, e) })
	if n != 0 {
		t.Fatalf("within window must not flush, got %d", n)
	}
	// 窗口（5s）到期的一帧：触发成账，聚合窗口锚定（首帧）以来的全部批次
	if !svc.injectWritable(nil, c, "ghi", now.Add(6*time.Second)) {
		t.Fatal("inject 3 must succeed")
	}
	n = svc.FlushViewAudits(func(e store.AuditEvent) { events = append(events, e) })
	if n != 1 {
		t.Fatalf("window expiry must flush one batch, got %d", n)
	}
	detail := events[0].Detail
	if !strings.Contains(detail, "9 bytes") || !strings.Contains(detail, "3 frames") {
		t.Fatalf("batch detail must aggregate window bytes/frames: %q", detail)
	}
	if !strings.Contains(detail, "v-audit-") || events[0].IP != "203.0.113.9" {
		t.Fatalf("batch event must carry visitor/ip metadata: %q ip=%q", detail, events[0].IP)
	}
	if strings.Contains(detail, "abc") || strings.Contains(detail, "ghi") {
		t.Fatalf("batch detail must not carry input text: %q", detail)
	}
	// 统一单键入批次事件（P-20261121-1 必改8）：Detail 带 mode 分档授权模式
	if !strings.Contains(detail, "mode=open") {
		t.Fatalf("batch detail must carry mode: %q", detail)
	}
	// 断开兜底：余量（无）不再成账
	svc.flushConnAudit(c, true)
	n = svc.FlushViewAudits(func(e store.AuditEvent) { events = append(events, e) })
	if n != 0 {
		t.Fatalf("drained remainder must be empty, got %d", n)
	}
}

func TestTokenBucketRate(t *testing.T) {
	// 桶语义：瞬发余量 + 持续速率（帧率闸的最小契约）
	now := time.Now()
	b := newTokenBucket(40, 120, now)
	for i := 0; i < 120; i++ {
		if !b.allow(now) {
			t.Fatalf("burst frame %d must pass", i)
		}
	}
	if b.allow(now) {
		t.Fatal("burst exhausted must reject")
	}
	// 1s 后补充 40 枚
	later := now.Add(time.Second)
	granted := 0
	for b.allow(later) {
		granted++
	}
	if granted != 40 {
		t.Fatalf("refill over 1s = %d, want 40", granted)
	}
	// 补充不越过 burst 上限
	muchLater := now.Add(time.Hour)
	for i := 0; i < 120; i++ {
		if !b.allow(muchLater) {
			t.Fatalf("burst must be capped at %d", 120)
		}
	}
	if b.allow(muchLater) {
		t.Fatal("over burst must reject")
	}
}

// TestTokenBucketByteRate 字节桶语义（P-20261122-18 ⑤）：字节单位取令牌、
// 不足不消耗（整帧丢弃语义的底座）、持续速率 + 突发上限同帧桶
func TestTokenBucketByteRate(t *testing.T) {
	now := time.Now()
	b := newTokenBucket(wsUpConnByteRate, wsUpConnByteBurst, now)
	if wsUpConnByteBurst != 2<<20 || wsUpConnByteRate != 1<<20 {
		t.Fatalf("byte bucket params = %d/%d, want 1MiB/s + 2MiB burst", wsUpConnByteRate, wsUpConnByteBurst)
	}
	// 突发 2MiB：两帧各 1MiB 放行（逐帧调用有副作用——不用 || 连写，
	// staticcheck SA4000 会把两次同参调用误报为重复表达式），第三帧拒绝
	for i := 0; i < 2; i++ {
		if !b.allowN(now, float64(1<<20)) {
			t.Fatalf("burst frame %d (1MiB) must pass within 2MiB burst", i)
		}
	}
	if b.allowN(now, float64(1<<20)) {
		t.Fatal("third 1MiB frame must be rejected (burst = 2MiB)")
	}
	// 拒绝不消耗令牌：1s 后恰补 1MiB，一帧放行、下一帧拒绝
	later := now.Add(time.Second)
	if !b.allowN(later, float64(1<<20)) {
		t.Fatal("1MiB refilled after 1s must pass")
	}
	if b.allowN(later, float64(1<<20)) {
		t.Fatal("second frame right after refill must be rejected")
	}
	// 小帧（按键）在补充后放行——字节折算不误伤正常键入
	if !b.allowN(later.Add(time.Second), 32) {
		t.Fatal("small key frame must pass after refill")
	}
	// 不足额请求整份不消耗：60 通过后，60 拒绝、40 仍可放行
	b2 := newTokenBucket(1, 100, now)
	if !b2.allowN(now, 60) {
		t.Fatal("60 of 100 must pass")
	}
	if b2.allowN(now, 60) {
		t.Fatal("60 over remaining 40 must reject")
	}
	if !b2.allowN(now, 40) {
		t.Fatal("rejected request must not consume tokens: 40 still available")
	}
}

// TestWritableBigFrameNoBridgeBreak 大文本单帧不再断桥（P-20261122-18 ⑤）：
// 旧 16KiB 读上限下 xterm.onData 的整块粘贴必被 gorilla 以 1009 关闭；1MiB
// 上限下 40KiB 帧正常注入，且连接继续可用（不是「收下后断」）
func TestWritableBigFrameNoBridgeBreak(t *testing.T) {
	sink := &fakeWritableSink{}
	token := fixedToken("wrbig")
	srv, _, _ := writableTestEnv(t, token, true, sink)
	c := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=vbig")
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("first frame = %v, want hello", f)
	}
	// 40KiB 纯文本（无换行/危险模式）：一帧 — 旧上限 16KiB 下这里就是断桥
	payload := strings.Repeat("a", 40<<10)
	if err := c.conn.WriteMessage(websocket.BinaryMessage, []byte(payload)); err != nil {
		t.Fatalf("send 40KiB frame: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if got := sink.wrote(); len(got) == 1 && strings.Contains(got[0], payload) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("40KiB frame not injected, wrote=%d", len(sink.wrote()))
		}
		time.Sleep(20 * time.Millisecond)
	}
	// 连接仍活：后续按键帧照常注入（无 1009 断桥/无 input_throttled）
	if err := c.conn.WriteMessage(websocket.BinaryMessage, []byte("x")); err != nil {
		t.Fatalf("send after big frame: %v", err)
	}
	deadline = time.Now().Add(3 * time.Second)
	for {
		if got := sink.wrote(); len(got) == 2 && strings.HasSuffix(got[1], "\x00x") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("connection unusable after big frame, wrote=%d", len(sink.wrote()))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestWritableFrameAboveReadLimitCloses 1MiB 读上限仍成立：超限帧由 gorilla
// 以 1009 关闭（上限是防线不是目标——不做客户端分片，见 wsUpFrameMaxBytes 注）。
// wsDial 的读 goroutine 是唯一读者（gorilla 单读约束），这里以「控制帧通道
// 关闭」观察服务端读循环退出（对端收到 1009 后返回，通道随之关闭）
func TestWritableFrameAboveReadLimitCloses(t *testing.T) {
	sink := &fakeWritableSink{}
	token := fixedToken("wrbigx")
	srv, _, _ := writableTestEnv(t, token, true, sink)
	c := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=vbigx")
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("first frame = %v, want hello", f)
	}
	_ = c.conn.WriteMessage(websocket.BinaryMessage, []byte(strings.Repeat("a", (1<<20)+1)))
	select {
	case _, ok := <-c.frames:
		if ok {
			// 超限帧不应产生任何控制帧（输入在预检前就被读上限截断）
			t.Fatal("over-limit frame must not yield control frames")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("over-limit frame must tear down the connection (1009)")
	}
	if got := sink.wrote(); len(got) != 0 {
		t.Fatalf("over-limit frame must not reach the sink, wrote=%d", len(got))
	}
}

// TestWritableByteBucketThrottles 字节桶与帧桶并行：2MiB 突发后第三帧
// 1MiB 整帧丢弃 + input_throttled，连接保持（不做部分注入）
func TestWritableByteBucketThrottles(t *testing.T) {
	sink := &fakeWritableSink{}
	token := fixedToken("wrbyte")
	srv, _, _ := writableTestEnv(t, token, true, sink)
	c := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=vbyte")
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("first frame = %v, want hello", f)
	}
	frame := []byte(strings.Repeat("b", 1<<20))
	for i := 0; i < 3; i++ {
		if err := c.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			t.Fatalf("send frame %d: %v", i, err)
		}
	}
	if f := c.nextFrame(t, 5*time.Second); f["type"] != "input_throttled" {
		t.Fatalf("third frame reply = %v, want input_throttled", f)
	}
	// 仅前两帧注入：触限帧整帧丢弃（无部分注入），审计也只见两批
	deadline := time.Now().Add(3 * time.Second)
	for len(sink.wrote()) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := sink.wrote(); len(got) != 2 {
		t.Fatalf("injected batches = %d, want 2 (throttled frame must be dropped whole)", len(got))
	}
}

func TestWritableWriterCap(t *testing.T) {
	// 并发输入护栏：单 token 上行连接上限 MaxWritersPerToken（多人混打允许
	// 在上限内、超出拒绝——修订点4定案的执行面）
	sink := &fakeWritableSink{}
	token := fixedToken("wrcap")
	srv, _, _ := writableTestEnv(t, token, true, sink)
	var clients []*wsClient
	for i := 0; i < MaxWritersPerToken; i++ {
		clients = append(clients, wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+
			"/s/"+token+"/termws?visitorId=v"+string(rune('a'+i))))
	}
	// 第 MaxWritersPerToken+1 条：升级成功但即刻被拒（denied 控制帧 + 关闭）
	extra := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=vx")
	f := extra.nextFrame(t, 2*time.Second)
	if f["type"] != "denied" {
		t.Fatalf("over-cap frame = %v, want denied", f)
	}
	// 已在场连接继续可用
	if err := clients[0].conn.WriteMessage(websocket.BinaryMessage, []byte("echo hi\r")); err != nil {
		t.Fatalf("send on existing conn: %v", err)
	}
}

// ── 视口反喂 resize（P-20261120-8）控制面承接纪律锁 ──
// 钳制域（评审必改3）/conn 级节流 ≥1s/token 合并窗 last-write-wins（必改4）/
// TmuxExternal 拒绝（必改4）/审计+事件双出账（必改5）/WritableDown 清合并窗。

// fakeWritableResizer WritableResizer 测试替身（记录应用值；deny 非空模拟装配层
// 准入拒绝原因："" 允许 / "external_session" / "owner_active"）
type fakeWritableResizer struct {
	mu      sync.Mutex
	applied []string // "cols x rows" 应用记录序
	deny    string
}

func (f *fakeWritableResizer) WritableResizeDenyReason(sessionID string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.deny
}

func (f *fakeWritableResizer) setDeny(reason string) {
	f.mu.Lock()
	f.deny = reason
	f.mu.Unlock()
}

func (f *fakeWritableResizer) WritableResize(sessionID string, cols, rows uint16) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.applied = append(f.applied, fmt.Sprintf("%dx%d", cols, rows))
	return nil
}

func (f *fakeWritableResizer) got() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.applied...)
}

// writableResizeEnv 起一个带 resizer/事件捕获的可写子服务（writableTestEnv
// 同构，补 P-20261120-8 两面装配）
func writableResizeEnv(t *testing.T, token string, resizer *fakeWritableResizer) (*httptest.Server, *Service, *fakeWritableSink, *[]WritableResizeEvent) {
	t.Helper()
	sink := &fakeWritableSink{}
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-1",
		Name: "live", Writable: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).
		WithWritableSink(sink).WithWritableResizer(resizer)
	var events []WritableResizeEvent
	svc = svc.WithWritableResizeEvents(func(ev WritableResizeEvent) { events = append(events, ev) })
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, svc, sink, &events
}

// waitApplied 轮询 resizer 应用记录直至出现期望值（合并窗 500ms + 回执异步）
func waitApplied(t *testing.T, r *fakeWritableResizer, want []string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if got := r.got(); len(got) >= len(want) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("resizer applied = %v, want %v", r.got(), want)
}

func TestWritableResizeApplyClampThrottleAudit(t *testing.T) {
	resizer := &fakeWritableResizer{}
	token := fixedToken("wrrsz1")
	srv, svc, _, events := writableResizeEnv(t, token, resizer)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/s/" + token + "/termws?visitorId=v1"
	c := wsDial(t, url)
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("first frame = %v, want hello", f)
	}

	sendResize := func(cols, rows int) {
		payload, _ := json.Marshal(map[string]any{"type": "resize", "cols": cols, "rows": rows})
		if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
			t.Fatalf("send resize: %v", err)
		}
	}

	// 合法值：合并窗后应用 + resize_applied 回执 + 事件出账
	sendResize(120, 40)
	if f := c.nextFrame(t, 3*time.Second); f["type"] != "resize_applied" || f["cols"] != float64(120) || f["rows"] != float64(40) {
		t.Fatalf("applied frame = %v", f)
	}
	waitApplied(t, resizer, []string{"120x40"})

	// 非法值钳制（评审必改3 + P-20261122-16 ⑤）：cols 下限钳 80（访客路径专属
	// ——手机视口算出 <80 列时前端不反喂，直连 WS 由服务端同域钳制兜底；主人
	// PUT 的 20 下限不走本路径）、rows=9999→300。conn 节流 1s 内不发第二帧，
	// 先等节流窗过
	time.Sleep(1_100 * time.Millisecond)
	sendResize(5, 9999)
	if f := c.nextFrame(t, 3*time.Second); f["type"] != "resize_applied" || f["cols"] != float64(80) || f["rows"] != float64(300) {
		t.Fatalf("clamped frame = %v", f)
	}
	waitApplied(t, resizer, []string{"120x40", "80x300"})

	// conn 级节流（≥1s）：节流窗内的第二帧整帧丢弃（连合并窗都不进——1.1s
	// 睡眠只放行了上面那一帧，这帧在其后 ~0ms 发出）
	sendResize(100, 30)
	time.Sleep(700 * time.Millisecond)
	if got := resizer.got(); len(got) != 2 {
		t.Fatalf("throttled frame must not apply, applied = %v", got)
	}

	// 协议误用容忍：非 resize 的 Text 帧忽略不关（连接仍活着）
	time.Sleep(1_100 * time.Millisecond)
	if err := c.conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"hello"}`)); err != nil {
		t.Fatalf("send stray text: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := c.conn.WriteMessage(websocket.PingMessage, []byte("x")); err != nil {
		t.Fatalf("conn must stay alive after stray text frame: %v", err)
	}

	// 审计入账（评审必改5，元数据口径）：share.writableResize 动作 + 尺寸与
	// visitor 摘要在 Detail
	var audits []store.AuditEvent
	n := svc.FlushViewAudits(func(e store.AuditEvent) { audits = append(audits, e) })
	_ = n
	found := false
	for _, a := range audits {
		if a.Action == store.AuditShareWritableResize && strings.Contains(a.Detail, "120x40") && strings.Contains(a.Detail, "v1") {
			found = true
		}
	}
	if !found {
		t.Fatalf("resize audit missing among %+v", audits)
	}
	// ops 事件（owner 侧最小可见性）
	if len(*events) == 0 {
		t.Fatal("writable resize events must fire on apply")
	}
	ev := (*events)[0]
	if ev.Cols != 120 || ev.Rows != 40 || ev.TerminalID != "sess-1" || ev.VisitorTail == "" {
		t.Fatalf("resize event = %+v", ev)
	}
}

func TestWritableResizeMergeWindowLastWriteWins(t *testing.T) {
	// 评审必改4：多访客并发 resize 的 token 合并窗——窗内两帧只应用最后上报
	// 值（last-write-wins），突刺收敛为单次改格；回执广播两连接都收
	resizer := &fakeWritableResizer{}
	token := fixedToken("wrrsz2")
	srv, svc, _, _ := writableResizeEnv(t, token, resizer)
	base := "ws" + strings.TrimPrefix(srv.URL, "http") + "/s/" + token + "/termws?visitorId="
	a := wsDial(t, base+"va")
	b := wsDial(t, base+"vb")
	for _, cl := range []*wsClient{a, b} {
		if f := cl.nextFrame(t, 2*time.Second); f["type"] != "hello" {
			t.Fatalf("first frame = %v, want hello", f)
		}
	}
	pa, _ := json.Marshal(map[string]any{"type": "resize", "cols": 100, "rows": 30})
	pb, _ := json.Marshal(map[string]any{"type": "resize", "cols": 200, "rows": 50})
	// 确定序：两帧走两条独立 TCP 连接，到达序不由发送序保证——先等 A 帧受理
	//（pending 可观测且值为 A），再发 B 帧并等 pending 翻成 B（定时器仍在窗内），
	// 此后合并窗到期必应用 B 值（last-write-wins 的确定性验证面）
	if err := a.conn.WriteMessage(websocket.TextMessage, pa); err != nil {
		t.Fatalf("send a: %v", err)
	}
	waitPending(t, svc, token, 100)
	if err := b.conn.WriteMessage(websocket.TextMessage, pb); err != nil {
		t.Fatalf("send b: %v", err)
	}
	waitPending(t, svc, token, 200)
	// 两连接都收同一枚应用回执（广播面）
	for name, cl := range map[string]*wsClient{"a": a, "b": b} {
		if f := cl.nextFrame(t, 3*time.Second); f["type"] != "resize_applied" || f["cols"] != float64(200) {
			t.Fatalf("conn %s applied frame = %v, want 200x50", name, f)
		}
	}
	waitApplied(t, resizer, []string{"200x50"})
	if got := resizer.got(); len(got) != 1 {
		t.Fatalf("merge window must coalesce to one apply, applied = %v", got)
	}
}

// waitPending 轮询合并窗 pending 直至出现期望列数（帧受理的确定性观测面）
func waitPending(t *testing.T, svc *Service, token string, cols uint16) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		svc.writable.mu.Lock()
		st := svc.writable.resizes[token]
		var got uint16
		if st != nil {
			got = st.cols
		}
		svc.writable.mu.Unlock()
		if got == cols {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("pending resize never reached cols=%d", cols)
}

func TestWritableResizeExternalDenied(t *testing.T) {
	// 评审必改4：TmuxExternal 外部接管会话禁用访客 resize——resize_denied 回执
	// （访客页据此停驱动回落保真），零应用
	resizer := &fakeWritableResizer{deny: "external_session"}
	token := fixedToken("wrrsz3")
	srv, _, _, _ := writableResizeEnv(t, token, resizer)
	c := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v1")
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("first frame = %v", f)
	}
	payload, _ := json.Marshal(map[string]any{"type": "resize", "cols": 120, "rows": 40})
	if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("send: %v", err)
	}
	if f := c.nextFrame(t, 3*time.Second); f["type"] != "resize_denied" || f["reason"] != "external_session" {
		t.Fatalf("denied frame = %v", f)
	}
	time.Sleep(200 * time.Millisecond)
	if got := resizer.got(); len(got) != 0 {
		t.Fatalf("denied resize must not apply, applied = %v", got)
	}
}

// TestWritableResizeOwnerActiveDeniedAtFire 合并窗到期前的准入复核（P-20261122-16
// ④ 二审必改②）：收帧时允许、窗内 owner 刚附着（AttachedClients 0→1）也必须在
// **应用前**拒绝——owner 的 xterm 不随 PTY 改格重排，窗内改格=主人视图整屏错位。
// 拒绝可恢复：owner 离开后同连接重发即正常应用（不是永久停驱动）
func TestWritableResizeOwnerActiveDeniedAtFire(t *testing.T) {
	resizer := &fakeWritableResizer{}
	token := fixedToken("wrrsz5")
	srv, svc, _, _ := writableResizeEnv(t, token, resizer)
	c := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v1")
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("first frame = %v", f)
	}
	send := func(cols, rows int) {
		payload, _ := json.Marshal(map[string]any{"type": "resize", "cols": cols, "rows": rows})
		if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
			t.Fatalf("send resize: %v", err)
		}
	}
	send(120, 40)
	// 帧已进合并窗（pending 可观测）后翻转准入：模拟窗内 owner 打开系统内终端
	waitPending(t, svc, token, 120)
	resizer.setDeny("owner_active")
	if f := c.nextFrame(t, 3*time.Second); f["type"] != "resize_denied" || f["reason"] != "owner_active" {
		t.Fatalf("denied frame = %v", f)
	}
	if got := resizer.got(); len(got) != 0 {
		t.Fatalf("owner-active deny must not apply, applied = %v", got)
	}
	// owner 离开（解除准入拒绝）后重发：conn 节流窗过后正常应用
	resizer.setDeny("")
	time.Sleep(1_100 * time.Millisecond)
	send(130, 42)
	if f := c.nextFrame(t, 3*time.Second); f["type"] != "resize_applied" || f["cols"] != float64(130) {
		t.Fatalf("applied-after-owner-left frame = %v", f)
	}
	waitApplied(t, resizer, []string{"130x42"})
}

func TestWritableResizeDownCancelsPending(t *testing.T) {
	// owner 杀开关清合并窗（WritableDown 四表清场）：pending 不越过开关时刻
	// 生效——窗内撤销即零应用
	resizer := &fakeWritableResizer{}
	token := fixedToken("wrrsz4")
	srv, svc, _, _ := writableResizeEnv(t, token, resizer)
	c := wsDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/s/"+token+"/termws?visitorId=v1")
	if f := c.nextFrame(t, 2*time.Second); f["type"] != "hello" {
		t.Fatalf("first frame = %v", f)
	}
	payload, _ := json.Marshal(map[string]any{"type": "resize", "cols": 150, "rows": 45})
	if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("send: %v", err)
	}
	// 等待帧已被读循环受理（pending 进合并窗可观测）——WriteMessage 只是投递，
	// 立刻 Down 会与读循环赛跑（Down 先清空表、帧后到，pending 照常成立）
	deadline := time.Now().Add(2 * time.Second)
	for {
		svc.writable.mu.Lock()
		_, pending := svc.writable.resizes[token]
		svc.writable.mu.Unlock()
		if pending {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("resize pending never entered the merge window")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !svc.WritableDown(token, true) {
		t.Fatal("writable down = false")
	}
	time.Sleep(900 * time.Millisecond) // 越过 500ms 合并窗
	if got := resizer.got(); len(got) != 0 {
		t.Fatalf("pending resize must be cancelled by WritableDown, applied = %v", got)
	}
}
