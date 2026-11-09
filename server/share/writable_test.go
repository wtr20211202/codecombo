package share

import (
	"encoding/json"
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
	// 开关关闭：WS 端点恒 404（存在性不可探测，drop 族同款语义）；状态端
	// 如实回 false
	token := fixedToken("wrgate")
	srv, _, _ := writableTestEnv(t, token, false, sink)
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
	// WritableDown：上行连接收到 writable_off 并断开
	if !svc.WritableDown(token) {
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
	if svc.WritableDown(token) {
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
	c := &writableConn{token: token, sessionID: "sess-1", visitorID: "v-audit-12345", ip: "203.0.113.9"}
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
