package share

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/store"
)

// stubLive TerminalLive 桩：可编程推送数据与额度语义
type stubLive struct {
	mu      sync.Mutex
	subs    int
	onSub   func(n int) error
	tail    []byte
	data    chan []byte
	done    chan struct{}
	ended   bool
	cols    uint16
	rows    uint16
	unwired []string
	// unfiltered 最近一次订阅携带的遮蔽模式（P-20261106-9：SSE 端点须按分享
	// 记录把 Unfiltered 透传给直播源）
	unfiltered []bool
	// sizeFn 可变尺寸源（P-20261107-4 resize 帧用例；nil = 固定 cols/rows）
	sizeFn func() (uint16, uint16)
	// nameFn 可变显示名源（P-20261118-9 rename 帧用例；nil = 固定 name）
	nameFn func() string
	name   string
}

func (s *stubLive) Subscribe(token, sessionID string, unfiltered bool) (LiveSubscription, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unfiltered = append(s.unfiltered, unfiltered)
	if s.onSub != nil {
		if err := s.onSub(s.subs); err != nil {
			return nil, err
		}
	}
	s.subs++
	data := s.data
	if data == nil {
		data = make(chan []byte)
	}
	done := s.done
	if done == nil {
		done = make(chan struct{})
	}
	return &stubSub{tail: s.tail, data: data, done: done, ended: s.ended, cols: s.cols, rows: s.rows, sizeFn: s.sizeFn, nameFn: s.nameFn, name: s.name, live: s}, nil
}

func (s *stubLive) Unwire(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unwired = append(s.unwired, token)
}

type stubSub struct {
	tail   []byte
	data   chan []byte
	done   chan struct{}
	ended  bool
	cols   uint16
	rows   uint16
	sizeFn func() (uint16, uint16)
	nameFn func() string
	name   string
	live   *stubLive
}

func (s *stubSub) Tail() []byte          { return s.tail }
func (s *stubSub) Live() <-chan []byte   { return s.data }
func (s *stubSub) Done() <-chan struct{} { return s.done }
func (s *stubSub) Ended() bool           { return s.ended }
func (s *stubSub) Size() (uint16, uint16) {
	if s.sizeFn != nil {
		return s.sizeFn()
	}
	return s.cols, s.rows
}
func (s *stubSub) Name() string {
	if s.nameFn != nil {
		return s.nameFn()
	}
	return s.name
}
func (s *stubSub) Release() {
	s.live.mu.Lock()
	s.live.subs--
	s.live.mu.Unlock()
}

// seedTerminalShare 内存桩记录：token→会话
func seedTerminalShare(t *testing.T, token, sessionID string) fakeShares {
	t.Helper()
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTerminal, TerminalID: sessionID,
		Name: "直播会话", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(store.TerminalLiveTTL),
	}}
	t.Cleanup(func() { delete(shares, token) })
	return shares
}

// ── stream 端点（SSE 帧语义） ──

func TestStreamFrames(t *testing.T) {
	shares := seedTerminalShare(t, fixedToken("stream"), "sess-1")
	data := make(chan []byte, 4)
	done := make(chan struct{})
	live := &stubLive{tail: []byte("masked-tail"), data: data, done: done, cols: 120, rows: 34}
	svc := NewService(shares, fakeRoots{}, nil).WithTerminalLive(live)

	req := httptest.NewRequest("GET", "/s/"+fixedToken("stream")+"/stream", nil)
	rec := httptest.NewRecorder()
	handlerDone := make(chan struct{})
	go func() {
		defer close(handlerDone)
		svc.Handler().ServeHTTP(rec, req)
	}()

	// 实时帧投递后关闭馈线（终结信号），handler 应自然收场
	data <- []byte("live-bytes")
	time.Sleep(50 * time.Millisecond)
	close(done)
	select {
	case <-handlerDone:
	case <-time.After(3 * time.Second):
		t.Fatal("stream handler did not return after feed end")
	}

	body := rec.Body.String()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}
	// hello：尺寸 + 未终结
	if !strings.Contains(body, `event: hello`+"\n"+`data: {"cols":120,"rows":34,"ended":false}`) {
		t.Fatalf("hello frame missing/wrong: %q", body)
	}
	// tail：base64 快照
	if want := base64.StdEncoding.EncodeToString([]byte("masked-tail")); !strings.Contains(body, "event: tail\ndata: "+want) {
		t.Fatalf("tail frame missing: %q", body)
	}
	// data：实时字节 base64
	if want := base64.StdEncoding.EncodeToString([]byte("live-bytes")); !strings.Contains(body, "event: data\ndata: "+want) {
		t.Fatalf("data frame missing: %q", body)
	}
	if !strings.Contains(body, "event: end\ndata: {}") {
		t.Fatalf("end frame missing: %q", body)
	}
}

// 主机尺寸跟随（P-20261107-4 渲染保真）：主人调整窗口后，新尺寸的 resize 帧
// 先于其后的数据帧送达（访客按新栅格渲染重绘）；尺寸未变不发、0 尺寸不发
func TestStreamResizeFrameBeforeData(t *testing.T) {
	shares := seedTerminalShare(t, fixedToken("resize"), "sess-rs")
	data := make(chan []byte, 4)
	done := make(chan struct{})
	var mu sync.Mutex
	cols, rows := uint16(100), uint16(30)
	live := &stubLive{data: data, done: done, sizeFn: func() (uint16, uint16) {
		mu.Lock()
		defer mu.Unlock()
		return cols, rows
	}}
	svc := NewService(shares, fakeRoots{}, nil).WithTerminalLive(live)

	req := httptest.NewRequest("GET", "/s/"+fixedToken("resize")+"/stream", nil)
	rec := httptest.NewRecorder()
	handlerDone := make(chan struct{})
	go func() {
		defer close(handlerDone)
		svc.Handler().ServeHTTP(rec, req)
	}()

	data <- []byte("same-size")
	time.Sleep(30 * time.Millisecond)
	mu.Lock()
	cols, rows = 0, 0 // 会话不可读：不下发 0 尺寸
	mu.Unlock()
	data <- []byte("zero-size")
	time.Sleep(30 * time.Millisecond)
	mu.Lock()
	cols, rows = 160, 48 // 主人调整窗口
	mu.Unlock()
	data <- []byte("after-resize")
	time.Sleep(50 * time.Millisecond)
	close(done)
	select {
	case <-handlerDone:
	case <-time.After(3 * time.Second):
		t.Fatal("stream handler did not return after feed end")
	}

	body := rec.Body.String()
	if !strings.Contains(body, `data: {"cols":100,"rows":30,"ended":false}`) {
		t.Fatalf("hello must carry the subscribe-time size: %q", body)
	}
	if n := strings.Count(body, "event: resize"); n != 1 {
		t.Fatalf("resize frames = %d, want exactly 1 (unchanged/zero sizes are not sent): %q", n, body)
	}
	resizeAt := strings.Index(body, "event: resize\ndata: {\"cols\":160,\"rows\":48}")
	afterAt := strings.Index(body, "event: data\ndata: "+base64.StdEncoding.EncodeToString([]byte("after-resize")))
	if resizeAt < 0 || afterAt < 0 || resizeAt > afterAt {
		t.Fatalf("resize frame must precede post-resize bytes (resize=%d data=%d): %q", resizeAt, afterAt, body)
	}
	if strings.Index(body, base64.StdEncoding.EncodeToString([]byte("same-size"))) > resizeAt {
		t.Fatalf("pre-resize bytes must not be preceded by the resize frame: %q", body)
	}
}

// 会话改名跟随（P-20261118-9）：主人侧改名后，rename 帧携带新名送达（与
// resize 同一 1s 对账 tick——syncName 挂 sizePoll，时延界与 resize 兜底轮询
// 同构；数据帧路径不附带 rename 对账，改名无输出时也随 tick 可达）；同名
// 不发、空名不发、含换行名的载荷必须单行（json.Marshal 强制转义，SSE 帧结构
// 恒完整）
func TestStreamRenameFrame(t *testing.T) {
	shares := seedTerminalShare(t, fixedToken("rename"), "sess-rn")
	data := make(chan []byte, 4)
	done := make(chan struct{})
	var mu sync.Mutex
	cur := "直播会话"
	live := &stubLive{data: data, done: done, nameFn: func() string {
		mu.Lock()
		defer mu.Unlock()
		return cur
	}}
	svc := NewService(shares, fakeRoots{}, nil).WithTerminalLive(live)

	req := httptest.NewRequest("GET", "/s/"+fixedToken("rename")+"/stream", nil)
	rec := httptest.NewRecorder()
	handlerDone := make(chan struct{})
	go func() {
		defer close(handlerDone)
		svc.Handler().ServeHTTP(rec, req)
	}()

	// rename 对账挂在 1s sizePoll tick（评审定案，与 syncSize 同 tick 同构）：
	// 每个变更态之间隔 >2 个 tick，帧序列逐态可达
	data <- []byte("same-name")
	time.Sleep(1300 * time.Millisecond)
	mu.Lock()
	cur = "" // 会话名不可读：不发
	mu.Unlock()
	time.Sleep(1300 * time.Millisecond)
	mu.Lock()
	cur = "改名会话" // 主人侧改名
	mu.Unlock()
	time.Sleep(1300 * time.Millisecond)
	mu.Lock()
	cur = "改名会话" // 同名：不再发
	mu.Unlock()
	time.Sleep(1300 * time.Millisecond)
	mu.Lock()
	cur = "带\n换行的名字" // 控制字符名：载荷必须转义单行
	mu.Unlock()
	time.Sleep(1300 * time.Millisecond)
	close(done)
	select {
	case <-handlerDone:
	case <-time.After(3 * time.Second):
		t.Fatal("stream handler did not return after feed end")
	}

	body := rec.Body.String()
	// hello 帧带订阅时刻名
	if !strings.Contains(body, `data: {"ended":false,"name":"直播会话"}`) {
		t.Fatalf("hello must carry subscribe-time name: %q", body)
	}
	// rename 恰两帧：空名与同名都不发
	if n := strings.Count(body, "event: rename"); n != 2 {
		t.Fatalf("rename frames = %d, want exactly 2 (empty/unchanged names are not sent): %q", n, body)
	}
	// 两帧按变更顺序到达：新名帧先于换行名帧
	newNameAt := strings.Index(body, `event: rename`+"\n"+`data: {"name":"改名会话"}`)
	nlNameAt := strings.Index(body, `data: {"name":"带\n换行的名字"}`)
	if newNameAt < 0 || nlNameAt < 0 || newNameAt > nlNameAt {
		t.Fatalf("rename frames must follow the change order (new=%d newline=%d): %q", newNameAt, nlNameAt, body)
	}
	// 换行名载荷单行：裸 \n 必不存在于该帧 data 行内（转义形态 \n 两字符）
	if !strings.Contains(body, `data: {"name":"带\n换行的名字"}`) {
		t.Fatalf("newline name must be escaped to a single SSE line: %q", body)
	}
	// 帧结构完整性：每个 data 行后都有空行收尾（裸换行撕裂会打破此形态）
	for _, frame := range strings.Split(body, "\n\n") {
		for _, line := range strings.Split(frame, "\n") {
			if strings.HasPrefix(line, "data: ") && strings.Contains(line[len("data: "):], "\n") {
				t.Fatalf("SSE data line torn by raw newline: %q", line)
			}
		}
	}
}

func TestStreamEndedImmediately(t *testing.T) {
	shares := seedTerminalShare(t, fixedToken("ended"), "sess-gone")
	doneCh := make(chan struct{})
	close(doneCh)
	live := &stubLive{done: doneCh, ended: true}
	svc := NewService(shares, fakeRoots{}, nil).WithTerminalLive(live)

	req := httptest.NewRequest("GET", "/s/"+fixedToken("ended")+"/stream", nil)
	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, req)
	body := rec.Body.String()
	if !strings.Contains(body, `"ended":true`) || !strings.Contains(body, "event: end") {
		t.Fatalf("ended stream frames wrong: %q", body)
	}
}

func TestStreamUnknownTokenAndWrongKind(t *testing.T) {
	svc := NewService(fakeShares{}, fakeRoots{}, nil)
	// 未知 token → 404
	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/s/zzzzzzzzzzzzzzzz/stream", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown token status = %d, want 404", rec.Code)
	}

	// 文件分享没有流语义 → 400 unrenderable
	tok := fixedToken("file")
	shares := fakeShares{tok: {
		Token: tok, ProjectID: "p1", Path: "docs", IsDir: true, CreatedAt: time.Now(),
	}}
	svc = NewService(shares, fakeRoots{byID: map[string]string{"p1": fixture(t)}}, nil)
	rec = httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/s/"+tok+"/stream", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("file share stream status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "not_renderable") {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

// 访客额度：单 token 并发 ≤ MaxGuestsPerToken（护栏在直播源，端点映射 429）
func TestStreamGuestLimit429(t *testing.T) {
	shares := seedTerminalShare(t, fixedToken("limit"), "sess-lim")
	// 桩无条件拒绝（模拟额度已满；真实的 ≤5 计数在 liveterm.Hub 单测覆盖）
	live := &stubLive{onSub: func(int) error { return fmt.Errorf("limit") }}
	svc := NewService(shares, fakeRoots{}, nil).WithTerminalLive(live)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/s/"+fixedToken("limit")+"/stream", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "guest_limit") {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

// 直播源未装配：降级为立即终结的流（不 5xx，访客页呈现「已结束」）
func TestStreamWithoutLiveSource(t *testing.T) {
	shares := seedTerminalShare(t, fixedToken("nolive"), "sess-nolive")
	svc := NewService(shares, fakeRoots{}, nil)
	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/s/"+fixedToken("nolive")+"/stream", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"ended":true`) {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

// ── 严格只读：访客面不存在输入端点 ──

func TestGuestNoInputEndpoints(t *testing.T) {
	shares := seedTerminalShare(t, fixedToken("ro"), "sess-ro")
	svc := NewService(shares, fakeRoots{}, nil)
	h := svc.Handler()

	// POST/PUT/PATCH 到 stream 与页面 → 405 + Allow: GET（catch-all 之前的
	// 守卫；分享口只读，写方法必须得到诚实的方法语义而非 404）
	for _, method := range []string{"POST", "PUT", "PATCH"} {
		for _, path := range []string{"/s/" + fixedToken("ro") + "/stream", "/s/" + fixedToken("ro")} {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader("x")))
			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s = %d, want 405", method, path, rec.Code)
			}
			if allow := rec.Header().Get("Allow"); allow != "GET" {
				t.Fatalf("%s %s Allow = %q, want GET", method, path, allow)
			}
		}
	}
}

// ── 访客直播页与资产 ──

func TestTerminalGuestPage(t *testing.T) {
	shares := seedTerminalShare(t, fixedToken("page"), "sess-page")
	svc := NewService(shares, fakeRoots{}, nil)
	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/s/"+fixedToken("page"), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, marker := range []string{
		"/assets/xterm.js", "/assets/addon-fit.js", "/assets/xterm.css",
		"/stream", "EventSource", "disableStdin: true",
		"maskBanner", "liveBadge", "endedBadge",
	} {
		if !strings.Contains(body, marker) {
			t.Fatalf("term page missing marker %q", marker)
		}
	}
	// 标题语义（P-20261118-9）：h1/标签页 = 纯分享名，无品牌前缀；泛称只作
	// 字典键存在（document.title 不再指向它）
	if !strings.Contains(body, "<title>直播会话</title>") {
		t.Fatalf("page title must be the bare share name: %q", body)
	}
	if strings.Contains(body, "<title>Codecombo ") {
		t.Fatalf("page title must not carry the brand prefix: %q", body)
	}
	if !strings.Contains(body, `<h1 id="pageTitle">直播会话</h1>`) {
		t.Fatalf("h1 must be the bare share name: %q", body)
	}
	if strings.Contains(body, `document.title = t('appTitle')`) {
		t.Fatalf("document.title must follow the share name, not the generic app title: %q", body)
	}
	if !strings.Contains(body, `"name":"直播会话"`) {
		t.Fatalf("boot state must carry the share name: %q", body)
	}
	// 滚动单面化面（P-20261123-2，取代 P-9 双滚动条收敛）：overset 标记/捕获相
	// 滚轮接管/外层滚动条归属/死槽收敛的注入件在页面在场
	for _, marker := range []string{
		"data-overset", "scWheelCapture", "scrollbar-gutter:stable",
		".xterm-scrollable-element > .scrollbar{display:none}",
	} {
		if !strings.Contains(body, marker) {
			t.Fatalf("term page missing scroll-convergence marker %q", marker)
		}
	}
	// 旧放行式路由退役（假放行：事件仍被 SmoothScrollableElement 消费）
	if strings.Contains(body, "scWheelRoute") {
		t.Fatalf("term page must not carry the retired wheel route: %q", body)
	}
	// foot-note 并入 footer 单行（P-20261118-9）：单行形态在场（roTip 左 /
	// powered 右），独立版权行不再存在
	if !strings.Contains(body, `class="footer foot-note"`) {
		t.Fatalf("foot-note must be merged into the footer single line: %q", body)
	}
}

func TestAssetServing(t *testing.T) {
	svc := NewService(fakeShares{}, fakeRoots{}, nil)
	h := svc.Handler()

	// 白名单三件可取，带不可变缓存头（覆写全局 no-store）
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/xterm.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("xterm.js status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("xterm.js content-type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("xterm.js cache-control = %q", cc)
	}
	if len(rec.Body.Bytes()) < 100<<10 {
		t.Fatalf("xterm.js too small: %d bytes", len(rec.Body.Bytes()))
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/addon-fit.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("addon-fit status = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/xterm.css", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("xterm.css status = %d", rec.Code)
	}

	// 白名单外一律品牌 404（穿越形态也不例外：%2e%2e 在段内解码后才成
	// ../——白名单按解码后名字精确匹配，永远不中）
	for _, name := range []string{"..%2fservice.go", "README.md", "anything-else.js", "sub%2fxterm.js"} {
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/"+name, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("asset %q status = %d, want 404", name, rec.Code)
		}
	}
}
