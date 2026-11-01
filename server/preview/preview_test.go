package preview

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// setupEngine 挂好 /preview/:port/*path 路由的独立 engine（不挂锁中间件——
// 锁语义由 middleware 包自身测试覆盖，这里聚焦反代行为本身）
func setupEngine(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Any("/preview/:port/*path", Handler)
	return r
}

// freePort 申请一个空闲回环端口后即刻释放（存在理论竞态，e2e/单测惯例可接受）
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	if err := l.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	return port
}

// doViaRealServer 经真实 http server（httptest.NewServer）打 engine。
// 不用 httptest.NewRecorder + ServeHTTP：ReverseProxy 走到 flush/upgrade
// 分支会对 writer 调 CloseNotify，gin 包装的 Recorder 无此方法直接 panic。
// 不跟随重定向：断言的是代理改写后的 Location 原始值（跟随会绕回代理成环）
func doViaRealServer(t *testing.T, r *gin.Engine, target string) *http.Response {
	t.Helper()
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	client := &http.Client{
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Get(srv.URL + target)
	if err != nil {
		t.Fatalf("GET %s: %v", target, err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestParsePort(t *testing.T) {
	cases := []struct {
		raw    string
		want   int
		wantOK bool
	}{
		{"5173", 5173, true},
		{"1024", 1024, true},   // 下界含
		{"65535", 65535, true}, // 上界含
		{"1023", 0, false},     // 特权端口拒绝
		{"80", 0, false},
		{"65536", 0, false},
		{"0", 0, false},
		{"abc", 0, false},
		{"", 0, false},
		{"0x1234", 0, false},
		{"5173 ", 0, false}, // 不容忍尾随空白
	}
	for _, tc := range cases {
		got, err := parsePort(tc.raw)
		if tc.wantOK {
			if err != nil || got != tc.want {
				t.Errorf("parsePort(%q) = %d, %v; want %d, nil", tc.raw, got, err, tc.want)
			}
			continue
		}
		if err == nil {
			t.Errorf("parsePort(%q) = %d, nil; want error", tc.raw, got)
		}
	}
}

func TestHandler_InvalidPortRejected(t *testing.T) {
	r := setupEngine(t)
	for _, port := range []string{"80", "1023", "65536", "abc"} {
		resp := doViaRealServer(t, r, "/preview/"+port+"/")
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("GET /preview/%s/ = %d; want 400", port, resp.StatusCode)
		}
	}
}

// TestHandler_ForwardsToLoopback 结构性回环断言：上游恒为 127.0.0.1（Host 头）、
// 前缀已剥、query 原样透传
func TestHandler_ForwardsToLoopback(t *testing.T) {
	r := setupEngine(t)
	var gotPath, gotQuery, gotHost string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotPath, gotQuery, gotHost = req.URL.Path, req.URL.RawQuery, req.Host
		fmt.Fprint(w, "upstream-ok")
	}))
	t.Cleanup(up.Close)
	port := up.Listener.Addr().(*net.TCPAddr).Port

	resp := doViaRealServer(t, r, fmt.Sprintf("/preview/%d/sub/page.html?x=1&y=2", port))
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "upstream-ok" {
		t.Fatalf("proxy = %d %q; want 200 upstream-ok", resp.StatusCode, body)
	}
	if gotPath != "/sub/page.html" {
		t.Errorf("upstream path = %q; want /sub/page.html（前缀已剥）", gotPath)
	}
	if gotQuery != "x=1&y=2" {
		t.Errorf("upstream query = %q; want x=1&y=2", gotQuery)
	}
	// 回环硬约束：上游看到的 Host 必须是 127.0.0.1:<port>，而非代理入口的来源 Host
	if gotHost != fmt.Sprintf("127.0.0.1:%d", port) {
		t.Errorf("upstream Host = %q; want 127.0.0.1:%d（仅回环）", gotHost, port)
	}
}

// TestHandler_StripsFrameHeaders 响应剥帧限制：X-Frame-Options 整头删除、
// CSP 仅摘 frame-ancestors 指令（其余防护指令保留）
func TestHandler_StripsFrameHeaders(t *testing.T) {
	r := setupEngine(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; frame-ancestors 'none'; script-src 'self'; FRAME-ANCESTORS 'self'")
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprint(w, "ok")
	}))
	t.Cleanup(up.Close)
	port := up.Listener.Addr().(*net.TCPAddr).Port

	resp := doViaRealServer(t, r, fmt.Sprintf("/preview/%d/", port))
	if got := resp.Header.Get("X-Frame-Options"); got != "" {
		t.Errorf("X-Frame-Options = %q; want deleted", got)
	}
	csp := resp.Header.Get("Content-Security-Policy")
	for _, want := range []string{"default-src 'self'", "script-src 'self'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP 丢失保留指令 %q: %q", want, csp)
		}
	}
	if strings.Contains(strings.ToLower(csp), "frame-ancestors") {
		t.Errorf("CSP 未摘除 frame-ancestors: %q", csp)
	}
}

func TestHandler_RewritesRelativeRedirect(t *testing.T) {
	r := setupEngine(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "/login/")
		w.WriteHeader(http.StatusMovedPermanently)
	}))
	t.Cleanup(up.Close)
	port := up.Listener.Addr().(*net.TCPAddr).Port

	resp := doViaRealServer(t, r, fmt.Sprintf("/preview/%d/app", port))
	if resp.StatusCode != http.StatusMovedPermanently {
		t.Fatalf("status = %d; want 301", resp.StatusCode)
	}
	want := fmt.Sprintf("/preview/%d/login/", port)
	if got := resp.Header.Get("Location"); got != want {
		t.Errorf("Location = %q; want %q（相对跳转补回预览前缀）", got, want)
	}
}

// TestHandler_PrefixedRedirectPassthrough 上游按 --base 对齐形态自行跳转
// （Location 已带预览前缀）时原样放行，避免补前缀成环
func TestHandler_PrefixedRedirectPassthrough(t *testing.T) {
	r := setupEngine(t)
	var port int
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == fmt.Sprintf("/preview/%d/login/", port) {
			fmt.Fprint(w, "after-redirect")
			return
		}
		w.Header().Set("Location", fmt.Sprintf("/preview/%d/login/", port))
		w.WriteHeader(http.StatusMovedPermanently)
	}))
	t.Cleanup(up.Close)
	port = up.Listener.Addr().(*net.TCPAddr).Port

	// 入口 /x 剥前缀后上游见 /x → 301 到已带前缀的 login/（放行不重写），
	// 浏览器跟随 /preview/<port>/login/ → 剥成 /login/ → 404 重试保留轮命中
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	resp, err := srv.Client().Get(srv.URL + fmt.Sprintf("/preview/%d/x", port))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "after-redirect" {
		t.Errorf("chain = %d %q; want 200 after-redirect", resp.StatusCode, body)
	}
}

// TestHandler_404RetryPreservesPath 双模式核心：上游只认保留前缀路径
// （vite --base 对齐形态）时，剥前缀轮 404 触发保留重试，GET 最终命中
func TestHandler_404RetryPreservesPath(t *testing.T) {
	r := setupEngine(t)
	var port int
	var hitPaths []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hitPaths = append(hitPaths, req.URL.Path)
		if !strings.HasPrefix(req.URL.Path, fmt.Sprintf("/preview/%d/", port)) {
			http.NotFound(w, req)
			return
		}
		fmt.Fprint(w, "base-aligned")
	}))
	t.Cleanup(up.Close)
	port = up.Listener.Addr().(*net.TCPAddr).Port

	resp := doViaRealServer(t, r, fmt.Sprintf("/preview/%d/app.js", port))
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "base-aligned" {
		t.Fatalf("retry = %d %q; want 200 base-aligned", resp.StatusCode, body)
	}
	want := []string{"/app.js", fmt.Sprintf("/preview/%d/app.js", port)}
	if len(hitPaths) != 2 || hitPaths[0] != want[0] || hitPaths[1] != want[1] {
		t.Errorf("upstream hit %v; want %v（先剥前缀 404，再保留重试）", hitPaths, want)
	}
}

// TestHandler_PostNotRetried 写方法不做 404 重试：副作用不可重复
func TestHandler_PostNotRetried(t *testing.T) {
	r := setupEngine(t)
	var hitPaths []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hitPaths = append(hitPaths, req.URL.Path)
		http.NotFound(w, req)
	}))
	t.Cleanup(up.Close)
	port := up.Listener.Addr().(*net.TCPAddr).Port

	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	resp, err := srv.Client().Post(srv.URL+fmt.Sprintf("/preview/%d/api", port), "text/plain", strings.NewReader("x"))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("POST status = %d; want 404", resp.StatusCode)
	}
	if len(hitPaths) != 1 || hitPaths[0] != "/api" {
		t.Errorf("upstream hit %v; want [/api]（写方法单轮）", hitPaths)
	}
}

// TestHandler_RootServerNoRetry 根路径形态（多数静态/后端 dev server）：
// 首轮即 200，不触发重试轮
func TestHandler_RootServerNoRetry(t *testing.T) {
	r := setupEngine(t)
	var hits int
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hits++
		if req.URL.Path == "/app.js" {
			fmt.Fprint(w, "root-ok")
			return
		}
		http.NotFound(w, req)
	}))
	t.Cleanup(up.Close)
	port := up.Listener.Addr().(*net.TCPAddr).Port

	resp := doViaRealServer(t, r, fmt.Sprintf("/preview/%d/app.js", port))
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "root-ok" {
		t.Fatalf("root = %d %q; want 200 root-ok", resp.StatusCode, body)
	}
	if hits != 1 {
		t.Errorf("upstream hits = %d; want 1（命中不重试）", hits)
	}
}

// TestHandler_Genuine404PassedThrough 两轮都 404：真实的 404 原样交还
func TestHandler_Genuine404PassedThrough(t *testing.T) {
	r := setupEngine(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	t.Cleanup(up.Close)
	port := up.Listener.Addr().(*net.TCPAddr).Port

	resp := doViaRealServer(t, r, fmt.Sprintf("/preview/%d/missing.txt", port))
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d; want 404", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "nope") {
		t.Errorf("body = %q; want 保留上游 404 文案", body)
	}
}

func TestHandler_UpstreamDownBadGateway(t *testing.T) {
	r := setupEngine(t)
	port := freePort(t) // 无监听：连接拒绝

	resp := doViaRealServer(t, r, fmt.Sprintf("/preview/%d/", port))
	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("status = %d; want 502", resp.StatusCode)
	}
}

// TestHandler_IPv6LoopbackFallback 双栈回环回退：上游只绑 ::1（Windows 上
// vite 的默认形态）时，IPv4 拒连后回退 IPv6 回环仍然可达——两侧均为结构性回环
func TestHandler_IPv6LoopbackFallback(t *testing.T) {
	r := setupEngine(t)
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "v6-upstream")
	}))
	// 只监听 IPv6 回环（与 httptest 默认的双栈/IPv4 形态区分开）
	l, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skipf("tcp6 loopback unavailable: %v", err)
	}
	up.Listener = l
	up.Start()
	t.Cleanup(up.Close)
	port := l.Addr().(*net.TCPAddr).Port

	resp := doViaRealServer(t, r, fmt.Sprintf("/preview/%d/", port))
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "v6-upstream" {
		t.Errorf("proxy via ::1 fallback = %d %q; want 200 v6-upstream", resp.StatusCode, body)
	}
}

// TestHandler_WebSocketRelay WS 透传：httputil.ReverseProxy 原生 upgrade 通道——
// 客户端 ↔ 代理 ↔ 上游 echo 服务双向消息往返（Vite HMR 同类链路）
func TestHandler_WebSocketRelay(t *testing.T) {
	upgrader := websocket.Upgrader{}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if err := conn.WriteMessage(mt, append([]byte("echo:"), msg...)); err != nil {
				return
			}
		}
	}))
	t.Cleanup(up.Close)
	port := up.Listener.Addr().(*net.TCPAddr).Port

	srv := httptest.NewServer(setupEngine(t))
	t.Cleanup(srv.Close)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + fmt.Sprintf("/preview/%d/ws", port)

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial via proxy: %v (resp %v)", err, resp)
	}
	t.Cleanup(func() { _ = conn.Close() })

	if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(msg) != "echo:ping" {
		t.Errorf("msg = %q; want echo:ping", msg)
	}
}

// TestHandler_ModeHintAfterResolve 语义记忆：GET 首请求经 404 试错解析出
// 保留前缀语义后，同端口下一请求直接走保留路径（单轮命中，不再双击）
func TestHandler_ModeHintAfterResolve(t *testing.T) {
	r := setupEngine(t)
	var port int
	var hits []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hits = append(hits, req.URL.Path)
		if !strings.HasPrefix(req.URL.Path, fmt.Sprintf("/preview/%d/", port)) {
			http.NotFound(w, req)
			return
		}
		fmt.Fprint(w, "aligned")
	}))
	t.Cleanup(up.Close)
	port = up.Listener.Addr().(*net.TCPAddr).Port
	t.Cleanup(func() { modeHints.Delete(port) })

	resp := doViaRealServer(t, r, fmt.Sprintf("/preview/%d/a.js", port))
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "aligned" {
		t.Fatalf("first = %q; want aligned（试错解析）", body)
	}
	resp = doViaRealServer(t, r, fmt.Sprintf("/preview/%d/b.js", port))
	body, _ = io.ReadAll(resp.Body)
	if string(body) != "aligned" {
		t.Fatalf("second = %q; want aligned", body)
	}
	// 第二次请求只应有一轮命中保留路径（首轮即对，无 404 试错轮）
	if len(hits) != 3 || hits[2] != fmt.Sprintf("/preview/%d/b.js", port) {
		t.Errorf("upstream hits = %v; want 前 2 轮试错 + 第 3 次单轮保留命中", hits)
	}
}
