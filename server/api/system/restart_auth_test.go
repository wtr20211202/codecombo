package system

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// P-20261109-11 页面重启放开 LAN——回环之外接受有效锁 token 双路授权。
// 授权矩阵：回环恒放行（A8：锁定态也要能重启恢复）；非回环凭有效锁凭据
//（mw.ValidateLockCredential：头/cookie 载体，校验器与锁中间件同一套）放行；
// X-SC-Restart 自定义头恒必携（CSRF 门）；shutdown 保持 loopback-only 不动
//（重启可恢复、停机是终局的刻意不对称）。

// setupRestartAuthRouter 独立 store + 仅注册 restart/shutdown 两路由
// （与产品 router.go 注册形态一致：均不入 api 锁保护组）
func setupRestartAuthRouter(t *testing.T) (*gin.Engine, store.LockStore) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	lock := store.Get().Lock
	_ = lock.InitDefault() // Enabled=true + 默认口令，与产品首启形态一致

	r := gin.New()
	r.POST("/api/restart", Restart)
	r.POST("/api/shutdown", Shutdown)
	return r, lock
}

// withRestartAction 注册重启动作并返回观测通道（fn 经 goroutine 异步调用）。
// 用例结束把注册复位为 nil，防包级单例状态泄漏进同包其他用例
func withRestartAction(t *testing.T) <-chan struct{} {
	t.Helper()
	ch := make(chan struct{}, 1)
	RegisterRestart(func() { ch <- struct{}{} })
	t.Cleanup(func() { RegisterRestart(nil) })
	return ch
}

func withShutdownAction(t *testing.T) <-chan struct{} {
	t.Helper()
	ch := make(chan struct{}, 1)
	RegisterShutdown(func() { ch <- struct{}{} })
	t.Cleanup(func() { RegisterShutdown(nil) })
	return ch
}

func postRestart(r *gin.Engine, addr string, headers map[string]string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/restart", nil)
	req.RemoteAddr = addr
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	for _, ck := range cookies {
		req.AddCookie(ck)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func waitAction(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("restart/shutdown action not invoked within 2s")
	}
}

// 非回环客户端地址取 RFC 5737 文档保留段（TEST-NET-1/-2）：授权判定只区分
// 「回环 vs 非回环」，不写任何形似真实部署的内网段（公开纪律）
const (
	lanAddr    = "192.0.2.10:54321"
	lanAddr2   = "198.51.100.7:5555"
	loopback   = "127.0.0.1:1234"
	restartHdr = "X-SC-Restart"
)

// A8 回归：锁定态 + 回环 + 无任何 token → 照常 202（重启是锁定态逃生通道）
func TestRestart_Loopback_Locked_NoToken_202(t *testing.T) {
	r, lock := setupRestartAuthRouter(t)
	if !lock.GetConfig().Enabled {
		t.Fatal("precondition: lock enabled")
	}
	ch := withRestartAction(t)

	w := postRestart(r, loopback, map[string]string{restartHdr: "1"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", w.Code, w.Body.String())
	}
	waitAction(t, ch)
}

// 主修复路径：LAN 解锁态（X-Lock-Token 头载体）→ 202
func TestRestart_LAN_Unlocked_HeaderToken_202(t *testing.T) {
	r, lock := setupRestartAuthRouter(t)
	token, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	ch := withRestartAction(t)

	w := postRestart(r, lanAddr, map[string]string{restartHdr: "1", "X-Lock-Token": token})
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", w.Code, w.Body.String())
	}
	waitAction(t, ch)
}

// 刷新页面场景：内存无 token（axios 不带头），同源请求浏览器自动携带
// HttpOnly cookie 载体 → 与锁中间件同语义放行
func TestRestart_LAN_Unlocked_CookieToken_202(t *testing.T) {
	r, lock := setupRestartAuthRouter(t)
	token, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	ch := withRestartAction(t)

	w := postRestart(r, lanAddr2, map[string]string{restartHdr: "1"},
		&http.Cookie{Name: "sc_lock_token", Value: token})
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", w.Code, w.Body.String())
	}
	waitAction(t, ch)
}

// 头载体优先（与 lock_test.go 同语义）：无效头在场时有效 cookie 不参与判定
func TestRestart_LAN_InvalidHeader_ShadowsValidCookie_403(t *testing.T) {
	r, lock := setupRestartAuthRouter(t)
	good, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	w := postRestart(r, lanAddr, map[string]string{restartHdr: "1", "X-Lock-Token": "scl_bogus"},
		&http.Cookie{Name: "sc_lock_token", Value: good})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", w.Code, w.Body.String())
	}
}

// 锁定态 + LAN + 无 token → 403 诚实文案（修复前恒坏的形态在锁定态保持拒绝）
func TestRestart_LAN_Locked_NoToken_403(t *testing.T) {
	r, _ := setupRestartAuthRouter(t)

	w := postRestart(r, lanAddr, map[string]string{restartHdr: "1"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", w.Code, w.Body.String())
	}
	if want := "loopback only or valid unlock token required"; !strings.Contains(w.Body.String(), want) {
		t.Fatalf("expected honest 403 message %q, got body=%s", want, w.Body.String())
	}
}

// 失效 token 同样 403
func TestRestart_LAN_InvalidToken_403(t *testing.T) {
	r, _ := setupRestartAuthRouter(t)

	w := postRestart(r, lanAddr, map[string]string{restartHdr: "1", "X-Lock-Token": "scl_bogus"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", w.Code, w.Body.String())
	}
}

// CSRF 门独立于凭据：即便持有有效 token，缺 X-SC-Restart 自定义头仍 400
// （跨源伪造请求无法携带自定义头——预检被同源 CORS 拒；缺头即拒 = 双保险第二道）
func TestRestart_NoRestartHeader_400_EvenWithToken(t *testing.T) {
	r, lock := setupRestartAuthRouter(t)
	token, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	w := postRestart(r, lanAddr, map[string]string{"X-Lock-Token": token})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
	// 回环同头约束不变
	w = postRestart(r, loopback, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 (loopback), got %d body=%s", w.Code, w.Body.String())
	}
}

// 锁关闭（已有配置）：与 LockMiddleware 同语义全应用开放 → LAN 无 token 亦 202
func TestRestart_LAN_LockDisabled_202(t *testing.T) {
	r, lock := setupRestartAuthRouter(t)
	cfg := lock.GetConfig()
	cfg.Enabled = false
	if err := lock.SaveConfig(cfg); err != nil {
		t.Fatalf("save config: %v", err)
	}
	ch := withRestartAction(t)

	w := postRestart(r, lanAddr, map[string]string{restartHdr: "1"})
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", w.Code, w.Body.String())
	}
	waitAction(t, ch)
}

// 无配置（首次安装 / reset-lock 后）：fail-closed，LAN 只能走回环
func TestRestart_LAN_NoConfig_403(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })
	// 不 InitDefault：HasConfig()=false
	r := gin.New()
	r.POST("/api/restart", Restart)

	w := postRestart(r, lanAddr, map[string]string{restartHdr: "1"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", w.Code, w.Body.String())
	}
}

// shutdown 零变化：LAN + 有效 token 仍 403 loopback only（与 restart 刻意不对称）
func TestShutdown_LAN_ValidToken_Still403(t *testing.T) {
	r, lock := setupRestartAuthRouter(t)
	token, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	fired := withShutdownAction(t) // 拒绝路径下停机动作绝不可被触达

	req := httptest.NewRequest("POST", "/api/shutdown", nil)
	req.RemoteAddr = lanAddr
	req.Header.Set("X-SC-Shutdown", "1")
	req.Header.Set("X-Lock-Token", token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", w.Code, w.Body.String())
	}
	if want := "loopback only"; !strings.Contains(w.Body.String(), want) {
		t.Fatalf("expected loopback-only message, got body=%s", w.Body.String())
	}
	select {
	case <-fired:
		t.Fatal("shutdown action must not fire for LAN request even with valid token")
	case <-time.After(100 * time.Millisecond):
	}
}

// shutdown A8 回归：锁定态 + 回环 + 无 token → 202（行为零变化）
func TestShutdown_Loopback_Locked_NoToken_202(t *testing.T) {
	r, _ := setupRestartAuthRouter(t)
	ch := withShutdownAction(t)

	req := httptest.NewRequest("POST", "/api/shutdown", nil)
	req.RemoteAddr = loopback
	req.Header.Set("X-SC-Shutdown", "1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", w.Code, w.Body.String())
	}
	waitAction(t, ch)
}
