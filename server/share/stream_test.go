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
	return &stubSub{tail: s.tail, data: data, done: done, ended: s.ended, cols: s.cols, rows: s.rows, sizeFn: s.sizeFn, live: s}, nil
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
