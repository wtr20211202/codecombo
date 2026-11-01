package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// setupProxyTest 起一个假远程服务（记录收到的请求路径）+ 注入测试 store 并注册实例，
// 返回挂好代理路由的 gin engine 与假远程地址
// extraMiddleware 变参注入挂代理路由前的全局中间件（既有调用点零改动）
func setupProxyTest(t *testing.T, remote http.HandlerFunc, extraMiddleware ...gin.HandlerFunc) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	// GetProxyConfig 依赖全局 cfg——用隔离数据目录初始化，避免污染真实配置
	t.Setenv("CC_DATA_DIR", t.TempDir())
	_ = config.Load()

	remoteSrv := httptest.NewServer(remote)
	t.Cleanup(remoteSrv.Close)

	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	inst := store.Get().Instance.NewRemote("fake-remote", remoteSrv.URL, "")
	if err := store.Get().Instance.Save(inst); err != nil {
		t.Fatalf("save instance: %v", err)
	}

	r := gin.New()
	r.Use(extraMiddleware...)
	r.Any("/proxy/:instanceId/*path", ProxyHandler)
	return r, inst.ID
}

// TestProxyHandler_PrefixNormalization 双前缀回归：
// 前端拦截器发 /proxy/<id>/api/xxx（带 /api 前缀），代理归一化后远程应收到的
// 均为 /api/xxx——旧实现会拼出 /api/api/xxx 导致远程 404
func TestProxyHandler_PrefixNormalization(t *testing.T) {
	tests := []struct {
		name       string
		proxyPath  string // 请求本地代理的路径
		remoteWant string // 远程应收到的路径
	}{
		{"带 api 前缀（前端拦截器形式）", "/proxy/%s/api/projects", "/api/projects"},
		{"不带 api 前缀（相对路径形式）", "/proxy/%s/projects", "/api/projects"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotPath string
			r, instID := setupProxyTest(t, func(w http.ResponseWriter, req *http.Request) {
				gotPath = req.URL.Path
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"data":[]}`))
			})

			w := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, strings.Replace(tt.proxyPath, "%s", instID, 1), nil)
			r.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", w.Code)
			}
			if gotPath != tt.remoteWant {
				t.Fatalf("remote path = %s, want %s", gotPath, tt.remoteWant)
			}
		})
	}
}

// TestProxyHandler_InstanceNotFound 未知实例返回 502
func TestProxyHandler_InstanceNotFound(t *testing.T) {
	r, _ := setupProxyTest(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/proxy/nonexistent/projects", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}

// TestProxyWSHandler_SubprotocolEcho WS 子协议回选回归：
// 浏览器以子协议携带 unlock token（new WebSocket(url, ['scl_xxx'])，
// 浏览器规范要求服务器回选子协议，否则握手失败——旧实现不回选导致
// 远程实例所有 WS 连接建立即断
func TestProxyWSHandler_SubprotocolEcho(t *testing.T) {
	remoteUpgrader := websocket.Upgrader{
		CheckOrigin: func(*http.Request) bool { return true },
	}
	remoteHit := make(chan string, 1)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		conn, err := remoteUpgrader.Upgrade(w, req, nil)
		if err != nil {
			close(remoteHit)
			return
		}
		remoteHit <- req.URL.Path
		conn.Close()
	}))
	defer remote.Close()

	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	inst := store.Get().Instance.NewRemote("fake-ws-remote", remote.URL, "")
	if err := store.Get().Instance.Save(inst); err != nil {
		t.Fatalf("save instance: %v", err)
	}

	r := gin.New()
	gin.SetMode(gin.TestMode)
	r.GET("/ws/proxy/:instanceId/*path", ProxyWSHandler)
	srv := httptest.NewServer(r)
	defer srv.Close()

	// 模拟浏览器：带子协议拨号（ws://host 转换）
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/proxy/" + inst.ID + "/notifications"
	dialer := websocket.Dialer{Subprotocols: []string{"scl_test_token"}}
	conn, resp, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial with subprotocol should succeed, got err=%v resp=%v", err, resp)
	}
	defer conn.Close()

	// 响应必须回选同一子协议
	if proto := resp.Header.Get("Sec-WebSocket-Protocol"); proto != "scl_test_token" {
		t.Fatalf("server must echo subprotocol, got %q", proto)
	}
	if p := <-remoteHit; p != "/ws/notifications" {
		t.Fatalf("remote path = %s, want /ws/notifications", p)
	}
}

// TestIsLongOperation_AIPath AI 请求走长操作超时档：
// SSE 流式生成耗时长（LLM 逐 token 产出），落在 DefaultTimeout=30s 档会被整体超时截断
func TestIsLongOperation_AIPath(t *testing.T) {
	for _, p := range []string{
		"ai/chat/stream",  // /api/ai/* 经归一化剥掉 api/ 后的形态
		"/ai/chat/stream", // 带前导斜杠的形态
		"projects/abc123/ai/review/stream",
		"projects/abc123/ai/explain-commit/stream",
		"ai/analyze/stream",
	} {
		if !isLongOperation(p) {
			t.Errorf("isLongOperation(%q) = false, want true", p)
		}
	}
	// 误匹配反例：路径段含 "ai" 字样但不是 /ai 段
	for _, p := range []string{
		"projects/123/detail",
		"projects/123/files/main.go",
		"settings",
	} {
		if isLongOperation(p) {
			t.Errorf("isLongOperation(%q) = true, want false", p)
		}
	}
}

// TestWaitStreamDone_IdleResetsOnWrite 真 idle 检测回归：
// 持续写入的流总时长超过 idle 阈值也不应判 idle——
// 旧实现 time.After 从转发起点计时，会把持续产出但总时长超阈值的流（LLM 生成）误杀
func TestWaitStreamDone_IdleResetsOnWrite(t *testing.T) {
	var lastWrite atomic.Int64
	lastWrite.Store(time.Now().UnixNano())
	done := make(chan struct{})
	go func() {
		defer close(done)
		// 6 次 × 40ms = 240ms 总时长 > 100ms 阈值，但每两次写入间隔都在阈值内
		for i := 0; i < 6; i++ {
			time.Sleep(40 * time.Millisecond)
			lastWrite.Store(time.Now().UnixNano())
		}
	}()
	if got := waitStreamDone(done, nil, &lastWrite, 100*time.Millisecond); got != streamDone {
		t.Fatalf("waitStreamDone = %q, want %q (busy stream must not be killed)", got, streamDone)
	}
}

// TestWaitStreamDone_IdleWhenSilent 上游持续静默超过阈值才判 idle
func TestWaitStreamDone_IdleWhenSilent(t *testing.T) {
	var lastWrite atomic.Int64
	lastWrite.Store(time.Now().UnixNano())
	done := make(chan struct{})
	defer close(done) // 返回后收尾，避免 goroutine 悬挂
	if got := waitStreamDone(done, nil, &lastWrite, 50*time.Millisecond); got != streamIdle {
		t.Fatalf("waitStreamDone = %q, want %q", got, streamIdle)
	}
}

// TestWaitStreamDone_Cancelled 客户端断开即时返回
func TestWaitStreamDone_Cancelled(t *testing.T) {
	var lastWrite atomic.Int64
	lastWrite.Store(time.Now().UnixNano())
	done := make(chan struct{})
	defer close(done)
	cancelled := make(chan struct{})
	close(cancelled)
	if got := waitStreamDone(done, cancelled, &lastWrite, time.Hour); got != streamCancelled {
		t.Fatalf("waitStreamDone = %q, want %q", got, streamCancelled)
	}
}

// TestProxyHandler_SSEChunkedFlush SSE 转发逐块 Flush 集成回归：
// 上游两帧间隔 600ms，客户端必须在上游写出第二帧之前收到第一帧——
// 旧实现 io.Copy 不 Flush，帧被憋到流结束才一次性发出，前端逐 token 渲染失效
func TestProxyHandler_SSEChunkedFlush(t *testing.T) {
	firstSent := make(chan struct{})
	r, instID := setupProxyTest(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "event: delta\ndata: first\n\n")
		w.(http.Flusher).Flush()
		close(firstSent)
		time.Sleep(600 * time.Millisecond)
		_, _ = io.WriteString(w, "event: done\ndata: {}\n\n")
		w.(http.Flusher).Flush()
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	start := time.Now()
	resp, err := http.Get(srv.URL + "/proxy/" + instID + "/ai/chat/stream")
	if err != nil {
		t.Fatalf("get through proxy: %v", err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("content-type = %q, want text/event-stream", ct)
	}

	// 逐块读直到出现第一帧的内容，记录到达时刻
	buf := make([]byte, 512)
	var got strings.Builder
	for !strings.Contains(got.String(), "first") {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			got.Write(buf[:n])
		}
		if rerr != nil {
			t.Fatalf("read first frame before upstream finishes, err=%v (buffered till end = flush regression)", rerr)
		}
	}
	firstAt := time.Since(start)
	<-firstSent

	// 上游第二帧 600ms 后才写：若代理缓冲不 Flush，第一帧要到流结束（≥600ms）才到达
	if firstAt > 400*time.Millisecond {
		t.Fatalf("first frame arrived after %v, want < 400ms (upstream delays 2nd frame by 600ms)", firstAt)
	}
	_, _ = io.ReadAll(resp.Body) // 收尾读完第二帧
}

// TestProxyHandler_StripsUpstreamBaselineHeaders 剥上游冗余安全基线头
// （P-20261002-42）：远端同版本会带同值基线头，copyHeaders 按 Add 复制会产生
// 重复头——转发前剥除，代理响应以本地中间件施加的基线为准（本测试引擎未挂
// SecurityHeaders，剥净后基线清单应为空；带上 SecurityHeaders 挂载的对照见
// middleware 包单测）。按 SecurityBaselineHeaders 遍历而非硬编码三头：
// P-20261007-6 增补的 CSP Report-Only / Reporting-Endpoints 自动纳入本对账
func TestProxyHandler_StripsUpstreamBaselineHeaders(t *testing.T) {
	r, instID := setupProxyTest(t, func(w http.ResponseWriter, _ *http.Request) {
		for _, h := range middleware.SecurityBaselineHeaders {
			w.Header().Set(h, "upstream-value")
		}
		// 非基线头探针：证明剥除只针对基线清单
		w.Header().Set("X-Upstream-Only", "passthrough")
		w.WriteHeader(http.StatusOK)
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/proxy/"+instID+"/api/projects", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	for _, h := range middleware.SecurityBaselineHeaders {
		if got := w.Header().Values(h); len(got) != 0 {
			t.Errorf("%s 上游值未被剥除: %v", h, got)
		}
	}
	// 非基线头照常透传（剥除只针对基线清单）
	if got := w.Header().Get("X-Upstream-Only"); got != "passthrough" {
		t.Errorf("X-Upstream-Only = %q; want passthrough (non-baseline headers are kept)", got)
	}
}

// TestProxyHandler_RequestIDPassthrough 上游透传本面 request-id
// （P-20261003-216）：本地 RequestID 中间件生成的 id 随转发请求到达远端
// （远端日志与访端 errorLog 同值对齐）；远端响应携带的同名异值头（旧版本
// 远端自生成形态）被剥除——代理响应以本面 id 为准，客户端只读到一枚
func TestProxyHandler_RequestIDPassthrough(t *testing.T) {
	const upstreamID = "upstream0000000001" // 旧版本远端自生成异值形态
	var gotUpstream string
	// 挂上真实 RequestID 中间件（与服务端引擎同款装配），走完整链路
	r, instID := setupProxyTest(t, func(w http.ResponseWriter, req *http.Request) {
		gotUpstream = req.Header.Get("X-Request-Id")
		w.Header().Set("X-Request-Id", upstreamID)
		w.WriteHeader(http.StatusOK)
	}, middleware.RequestID())

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/proxy/"+instID+"/api/projects", nil)
	req.Header.Set("X-Request-Id", "abcd1234abcd1234") // 访端合法来头
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if gotUpstream != "abcd1234abcd1234" {
		t.Fatalf("upstream X-Request-Id = %q, want incoming id passed through", gotUpstream)
	}
	got := w.Header().Values("X-Request-Id")
	if len(got) != 1 || got[0] != "abcd1234abcd1234" {
		t.Fatalf("response X-Request-Id = %v, want exactly [abcd1234abcd1234]", got)
	}
}
