package middleware

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"codecombo/server/api/shared"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// wsDialerURL 把 httptest server 地址转为 WS URL
func wsDialerURL(srvURL, path string) string {
	return "ws" + strings.TrimPrefix(srvURL, "http") + path
}

// setupWSAuthRouter 构造仅含 WithWSLockAuth 的测试 router：
// 真实路由表中 /ws/* 不挂全局 LockMiddleware（WS 认证只经 WithWSLockAuth），
// 复用含 r.Use(LockMiddleware()) 的 HTTP 测试构造会让拨号被全局中间件 423
func setupWSAuthRouter(t *testing.T) (*gin.Engine, store.LockStore) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	lock := store.Get().Lock
	_ = lock.InitDefault()
	return gin.New(), lock
}

// dialWS 以指定子协议（模拟前端 new WebSocket(url, [token]) 携带 unlock token）拨号
func dialWS(t *testing.T, url, token string) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{
		Subprotocols:     []string{token},
		HandshakeTimeout: 5 * time.Second,
	}
	t0 := time.Now()
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if time.Since(t0) > 4*time.Second {
		t.Fatal("dial exceeded handshake timeout budget")
	}
	return conn
}

// TestWithWSLockAuth_RejectsWith4001 无效 token 的 WS 握手：先升级再以 4001 关闭。
// 此前回 HTTP 423 时浏览器拿不到状态码（onclose 一律 1006），前端无法区分
// 「token 失效」与「网络故障」，只能拿失效 token 无限重连；升级后关闭帧的
// code 对浏览器 event.code 可见，前端可确定性切锁定屏
func TestWithWSLockAuth_RejectsWith4001(t *testing.T) {
	r, _ := setupWSAuthRouter(t)
	r.GET("/ws/guarded", WithWSLockAuth(func(c *gin.Context) {
		t.Error("handler must not run for invalid token")
	}))

	srv := httptest.NewServer(r)
	defer srv.Close()

	conn := dialWS(t, wsDialerURL(srv.URL, "/ws/guarded"), "scl_definitely_invalid")
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err := conn.ReadMessage()
	ce, ok := err.(*websocket.CloseError)
	if !ok {
		t.Fatalf("expected close error, got %v", err)
	}
	if ce.Code != CloseCodeLockRejected {
		t.Fatalf("expected close code %d, got %d (%s)", CloseCodeLockRejected, ce.Code, ce.Text)
	}
}

// TestWithWSLockAuth_ValidTokenRunsHandler 有效 token：handler 正常执行且
// 连接存续期间有活续期（handler 返回后续期循环停止，无 goroutine 泄漏路径）
func TestWithWSLockAuth_ValidTokenRunsHandler(t *testing.T) {
	r, lock := setupWSAuthRouter(t)
	handlerRan := make(chan struct{})
	r.GET("/ws/guarded", WithWSLockAuth(func(c *gin.Context) {
		// 与真实 WS handler 一致：升级由 handler 自身完成（WithWSLockAuth
		// 只做校验 + 活续期）；不升级会让客户端等 101 直至超时
		conn, err := shared.WSUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
		if err != nil {
			return
		}
		defer conn.Close()
		handlerRan <- struct{}{}
		// 保持连接至测试侧断开：模拟真实 WS 生命周期（handler 返回 → stopTouch）
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))

	srv := httptest.NewServer(r)
	defer srv.Close()

	token, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	conn := dialWS(t, wsDialerURL(srv.URL, "/ws/guarded"), token)
	defer conn.Close()

	select {
	case <-handlerRan:
	case <-time.After(3 * time.Second):
		t.Fatal("handler did not run for valid token")
	}
	// 客户端主动断开 → 服务端 handler 返回 → 触发 stopTouch（defer 路径）
	conn.Close()
	time.Sleep(100 * time.Millisecond)
}

// TestTouchInterval_Clamp 续期间隔 = TTL/4 钳位 [2s, 30s]：
// TTL 允许配置到 1 分钟，间隔必须远小于 TTL 才能保证连续续期不漏档
func TestTouchInterval_Clamp(t *testing.T) {
	_, lock := setupLockTestRouter(t)

	// 默认 120min → TTL/4 = 30min → 上限钳到 30s
	if got := touchInterval(); got != 30*time.Second {
		t.Fatalf("default TTL interval = %v, want 30s", got)
	}

	// TTL = 1min → TTL/4 = 15s（中间值原样通过）
	cfg := lock.GetConfig()
	cfg.TokenTTLMinutes = 1
	if err := lock.SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	if got := touchInterval(); got != 15*time.Second {
		t.Fatalf("1min TTL interval = %v, want 15s", got)
	}
}

// TestStartLockTokenTouchLoop_Stops 启停不泄漏：stop 后循环退出
func TestStartLockTokenTouchLoop_Stops(t *testing.T) {
	_, lock := setupLockTestRouter(t)
	token, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	stop := StartLockTokenTouchLoop(token)
	if stop == nil {
		t.Fatal("stop func must not be nil")
	}
	stop()
	stop() // 幂等

	// 空 token 直接返回 no-op stop
	noop := StartLockTokenTouchLoop("")
	if noop == nil {
		t.Fatal("empty token must still return a callable stop")
	}
	noop()
}
