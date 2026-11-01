package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupLockTestRouter 构造测试 router，注入独立 store
func setupLockTestRouter(t *testing.T) (*gin.Engine, store.LockStore) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	// 注入到全局 store，使 middleware 通过 store.Get().Lock 访问测试 store
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	lock := store.Get().Lock
	_ = lock.InitDefault()

	r := gin.New()
	r.Use(LockMiddleware())
	r.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })
	return r, lock
}

func TestLockMiddleware_DisabledByConfig(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	lock := store.Get().Lock
	cfg := store.LockConfig{
		Enabled:         false,
		AutoLockEnabled: true,
		AutoLockMinutes: 120,
		TokenTTLMinutes: 120,
		PasswordHash:    store.DEFAULT_PASSWORD_HASH,
	}
	if err := lock.SaveConfig(cfg); err != nil {
		t.Fatalf("save config: %v", err)
	}

	r := gin.New()
	r.Use(LockMiddleware())
	r.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })

	req := httptest.NewRequest("GET", "/ping", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Errorf("expected 200 when lock disabled, got %d", w.Code)
	}
}

func TestLockMiddleware_NoToken(t *testing.T) {
	r, _ := setupLockTestRouter(t)

	req := httptest.NewRequest("GET", "/ping", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 423 {
		t.Errorf("expected 423 without token, got %d", w.Code)
	}
}

func TestLockMiddleware_ValidToken(t *testing.T) {
	r, lock := setupLockTestRouter(t)
	token, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	req := httptest.NewRequest("GET", "/ping", nil)
	req.Header.Set(LockHeaderName, token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Errorf("expected 200 with valid token, got %d", w.Code)
	}
}

func TestLockMiddleware_RevokedToken(t *testing.T) {
	r, lock := setupLockTestRouter(t)
	token, _ := lock.IssueToken()
	lock.RevokeToken(token)

	req := httptest.NewRequest("GET", "/ping", nil)
	req.Header.Set(LockHeaderName, token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 423 {
		t.Errorf("expected 423 with revoked token, got %d", w.Code)
	}
}

func TestLockMiddleware_ExpiredToken(t *testing.T) {
	r, lock := setupLockTestRouter(t)
	token, _ := lock.IssueToken()

	// 测试覆盖 TTL 为 1ms，并立即过期
	store.SetTokenTTLForTesting(lock, 1*time.Millisecond)
	time.Sleep(10 * time.Millisecond)

	req := httptest.NewRequest("GET", "/ping", nil)
	req.Header.Set(LockHeaderName, token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 423 {
		t.Errorf("expected 423 for expired token, got %d", w.Code)
	}
}

func TestExtractLockToken_Header(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set(LockHeaderName, "scl_abc123")
	if got := ExtractLockToken(req); got != "scl_abc123" {
		t.Errorf("expected scl_abc123, got %q", got)
	}
}

func TestExtractLockToken_Subprotocol(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Add("Sec-WebSocket-Protocol", "scl_xyz789")
	if got := ExtractLockToken(req); got != "scl_xyz789" {
		t.Errorf("expected scl_xyz789, got %q", got)
	}
}

func TestExtractLockToken_None(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	if got := ExtractLockToken(req); got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}

func TestValidateLockTokenForWS_Disabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	// 配置存在且 Enabled=false（用户显式关闭锁定）→ 放行
	lock := store.Get().Lock
	if err := lock.SaveConfig(store.LockConfig{
		Enabled:      false,
		PasswordHash: store.DEFAULT_PASSWORD_HASH,
	}); err != nil {
		t.Fatalf("save config: %v", err)
	}
	req := httptest.NewRequest("GET", "/", nil)
	if _, ok := ValidateLockTokenForWS(req); !ok {
		t.Error("expected ok when lock disabled with existing config")
	}
}

func TestValidateLockTokenForWS_NeedsSetup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	// 从未初始化配置（首次安装/被 reset-lock 清除）→ 握手拒绝，强制先设密
	req := httptest.NewRequest("GET", "/", nil)
	if _, ok := ValidateLockTokenForWS(req); ok {
		t.Error("expected reject when no lock config (needs setup)")
	}
}

func TestLockMiddleware_NeedsSetup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	// 从未初始化配置：API 全量 423（仅 lock 公开组豁免，不在本中间件覆盖面）
	r := gin.New()
	r.Use(LockMiddleware())
	r.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })

	req := httptest.NewRequest("GET", "/ping", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 423 {
		t.Errorf("expected 423 when no lock config, got %d", w.Code)
	}
}

func TestValidateLockTokenForWS_Valid(t *testing.T) {
	_, lock := setupLockTestRouter(t)
	token, _ := lock.IssueToken()

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set(LockHeaderName, token)
	got, ok := ValidateLockTokenForWS(req)
	if !ok {
		t.Error("expected ok")
	}
	if got != token {
		t.Errorf("expected %q, got %q", token, got)
	}
}

func TestRateLimit_TriggerAndBlock(t *testing.T) {
	ResetLockUnlockRateLimitForTesting()
	t.Cleanup(ResetLockUnlockRateLimitForTesting)

	ip := "1.2.3.4"
	// 前 9 次不应被封禁
	for i := 0; i < lockUnlockMaxFails-1; i++ {
		RecordLockUnlockFailure(ip)
		if IsLockUnlockRateLimited(ip) {
			t.Fatalf("unexpected block at attempt %d", i+1)
		}
	}
	// 第 10 次达阈值
	RecordLockUnlockFailure(ip)
	if !IsLockUnlockRateLimited(ip) {
		t.Error("expected block after max failures")
	}
}

// TestRateLimit_GCExpired 测试 GC 行为：过期条目被惰性清理
// 直接操作内部 map 模拟时间过去，避免真实 sleep
func TestRateLimit_GCExpired(t *testing.T) {
	ResetLockUnlockRateLimitForTesting()
	t.Cleanup(ResetLockUnlockRateLimitForTesting)

	ip := "1.2.3.4"
	// 触发一次失败，进入 map
	RecordLockUnlockFailure(ip)
	if len(lockUnlockFailures.m) == 0 {
		t.Fatal("expected entry in map after failure")
	}

	// 模拟时间过去 3 分钟（窗口 1 分钟 + 2 倍窗口 GC 阈值）
	// blockUntil 默认零值，windowStart 设为 3 分钟前
	lockUnlockFailures.Lock()
	if f, ok := lockUnlockFailures.m[ip]; ok {
		f.windowStart = time.Now().Add(-3 * time.Minute)
	}
	lockUnlockFailures.Unlock()

	// 调用 IsLockUnlockRateLimited 触发 GC
	IsLockUnlockRateLimited(ip)
	if _, ok := lockUnlockFailures.m[ip]; ok {
		t.Error("expected entry to be GC'd after 3 minutes of inactivity")
	}
}

// TestRateLimit_BlockedNoResetOnWindowExpiry 关键安全测试：
// 封禁期内即使滑动窗口已过期，也不允许 count/windowStart 重置
// 否则攻击者只需等到窗口过期再失败一次即可让 count 归 1 绕过封禁
func TestRateLimit_BlockedNoResetOnWindowExpiry(t *testing.T) {
	ResetLockUnlockRateLimitForTesting()
	t.Cleanup(ResetLockUnlockRateLimitForTesting)

	ip := "9.9.9.9"
	// 触发封禁
	for i := 0; i < lockUnlockMaxFails; i++ {
		RecordLockUnlockFailure(ip)
	}
	if !IsLockUnlockRateLimited(ip) {
		t.Fatal("expected blocked after max failures")
	}

	// 模拟滑动窗口已过期（但封禁期未过）
	lockUnlockFailures.Lock()
	if f, ok := lockUnlockFailures.m[ip]; ok {
		f.windowStart = time.Now().Add(-2 * time.Minute) // 2 分钟前
		// blockUntil 保持未来 60s（在 RecordLockUnlockFailure 里设置）
	}
	lockUnlockFailures.Unlock()

	// 再次失败：应仍处于封禁状态，不应清零 count
	RecordLockUnlockFailure(ip)
	if !IsLockUnlockRateLimited(ip) {
		t.Error("expected still blocked: window expiry should not reset during ban period")
	}
	lockUnlockFailures.Lock()
	f := lockUnlockFailures.m[ip]
	lockUnlockFailures.Unlock()
	if f == nil || f.count < lockUnlockMaxFails {
		t.Errorf("expected count >= max during ban, got %v", f)
	}
}

// TestRateLimit_ResetOnlyAfterBanAndWindowExpiry 封禁期 + 窗口都过期后允许新一轮
func TestRateLimit_ResetOnlyAfterBanAndWindowExpiry(t *testing.T) {
	ResetLockUnlockRateLimitForTesting()
	t.Cleanup(ResetLockUnlockRateLimitForTesting)

	ip := "8.8.8.8"
	for i := 0; i < lockUnlockMaxFails; i++ {
		RecordLockUnlockFailure(ip)
	}
	if !IsLockUnlockRateLimited(ip) {
		t.Fatal("expected blocked")
	}

	// 模拟封禁期 + 窗口都过期
	lockUnlockFailures.Lock()
	if f, ok := lockUnlockFailures.m[ip]; ok {
		f.windowStart = time.Now().Add(-5 * time.Minute)
		f.blockUntil = time.Now().Add(-1 * time.Minute)
	}
	lockUnlockFailures.Unlock()

	// 再失败一次：应是全新一轮（count=1）
	RecordLockUnlockFailure(ip)
	if IsLockUnlockRateLimited(ip) {
		t.Error("expected NOT blocked after fresh round")
	}
	lockUnlockFailures.Lock()
	f := lockUnlockFailures.m[ip]
	lockUnlockFailures.Unlock()
	if f == nil || f.count != 1 {
		t.Errorf("expected count=1 in fresh round, got %v", f)
	}
}

// TestLockMiddleware_AgentToken 智能体令牌（sca_）经 X-Lock-Token 放行：
// 锁定开启时有效 sca_ 等效有效解锁 token，无效值仍 423
func TestLockMiddleware_AgentToken(t *testing.T) {
	r, _ := setupLockTestRouter(t)

	if err := store.Get().AgentToken.Ensure(); err != nil {
		t.Fatalf("ensure agent token: %v", err)
	}
	plain := store.Get().AgentToken.Plain()
	if plain == "" {
		t.Fatal("agent token plaintext empty after ensure")
	}

	req := httptest.NewRequest("GET", "/ping", nil)
	req.Header.Set(LockHeaderName, plain)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Errorf("valid agent token expected 200, got %d", w.Code)
	}

	req2 := httptest.NewRequest("GET", "/ping", nil)
	req2.Header.Set(LockHeaderName, "sca_invalid-invalid-invalid")
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != 423 {
		t.Errorf("invalid agent token expected 423, got %d", w2.Code)
	}
}

// TestLockMiddleware_CookieFallback iframe 导航与 iframe 内第三方 WS（端口预览）
// 无自定义头可用：cookie 是同一解锁 token 的补充载体；普通中间件不受影响。
// 同一 store 挂两种中间件（store.SetDefault 全局单例，两套 setup 会互相覆盖）
func TestLockMiddleware_CookieFallback(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })
	lock := store.Get().Lock
	_ = lock.InitDefault()

	newRouter := func(mw gin.HandlerFunc) *gin.Engine {
		r := gin.New()
		r.Use(mw)
		r.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })
		return r
	}
	rPlain := newRouter(LockMiddleware())
	rCookie := newRouter(LockMiddlewareWithCookie())
	token, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	// 仅 cookie、无头：普通中间件 423（行为不变），cookie 回退版 200
	req := httptest.NewRequest("GET", "/ping", nil)
	req.AddCookie(&http.Cookie{Name: LockCookieName, Value: token})
	w := httptest.NewRecorder()
	rPlain.ServeHTTP(w, req)
	if w.Code != 423 {
		t.Errorf("plain middleware with cookie only: expected 423, got %d", w.Code)
	}

	w2 := httptest.NewRecorder()
	rCookie.ServeHTTP(w2, req)
	if w2.Code != 200 {
		t.Errorf("cookie middleware with valid cookie: expected 200, got %d", w2.Code)
	}

	// 无效 cookie：回退版同样 423（校验器与头载体同一套）
	req3 := httptest.NewRequest("GET", "/ping", nil)
	req3.AddCookie(&http.Cookie{Name: LockCookieName, Value: "scl_invalid"})
	w3 := httptest.NewRecorder()
	rCookie.ServeHTTP(w3, req3)
	if w3.Code != 423 {
		t.Errorf("cookie middleware with invalid cookie: expected 423, got %d", w3.Code)
	}

	// 头优先：无效头 + 有效 cookie → 仍 423（不因 cookie 放行无效头）
	req4 := httptest.NewRequest("GET", "/ping", nil)
	req4.Header.Set(LockHeaderName, "scl_invalid")
	req4.AddCookie(&http.Cookie{Name: LockCookieName, Value: token})
	w4 := httptest.NewRecorder()
	rCookie.ServeHTTP(w4, req4)
	if w4.Code != 423 {
		t.Errorf("cookie middleware with invalid header + valid cookie: expected 423, got %d", w4.Code)
	}
}

// ── P-20261019-2：HttpOnly cookie 载体（服务端 Set-Cookie 签发/清除/WS 回退）──

// TestClearLockTokenCookie_Attributes 清除串必须带 HttpOnly + Strict + Path=/
// （与签发同属性，浏览器才认得这是同一个 cookie 的过期指令）
func TestClearLockTokenCookie_Attributes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/x", func(c *gin.Context) { ClearLockTokenCookie(c); c.String(200, "ok") })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))

	var got *http.Cookie
	for _, ck := range w.Result().Cookies() {
		if ck.Name == LockCookieName {
			got = ck
		}
	}
	if got == nil {
		t.Fatal("expected clear Set-Cookie")
	}
	if !got.HttpOnly || got.SameSite != http.SameSiteStrictMode || got.Path != "/" || got.MaxAge != -1 {
		t.Errorf("unexpected clear cookie attrs: %+v", got)
	}
	if got.Secure {
		t.Error("plain-HTTP clear must not carry Secure")
	}
}

// TestLockMiddleware_423ClearsCookie 锁定拒绝顺手过期 cookie：失效 token 的
// HttpOnly 载体留在浏览器只会反复 423，只有服务端清得掉
func TestLockMiddleware_423ClearsCookie(t *testing.T) {
	r, _ := setupLockTestRouter(t)

	req := httptest.NewRequest("GET", "/ping", nil)
	req.AddCookie(&http.Cookie{Name: LockCookieName, Value: "scl_revoked"})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 423 {
		t.Fatalf("expected 423, got %d", w.Code)
	}
	var cleared bool
	for _, ck := range w.Result().Cookies() {
		if ck.Name == LockCookieName && ck.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Error("423 response must expire the lock cookie")
	}
}

// TestExtractLockToken_CookieFallback 载体优先级：头 > Sec-WebSocket-Protocol
// 子协议 > cookie。刷新后的浏览器页面内存无令牌，业务 WS 握手只剩同源自动
// 携带的 cookie 可用（跨站握手被升级器 SameOrigin + cookie Strict 双防劫持）
func TestExtractLockToken_CookieFallback(t *testing.T) {
	r := httptest.NewRequest("GET", "/ws/x", nil)
	r.AddCookie(&http.Cookie{Name: LockCookieName, Value: "scl_from_cookie"})
	if got := ExtractLockToken(r); got != "scl_from_cookie" {
		t.Errorf("cookie fallback: got %q", got)
	}

	// 子协议压过 cookie
	r2 := httptest.NewRequest("GET", "/ws/x", nil)
	r2.Header.Set("Sec-WebSocket-Protocol", "scl_from_subproto")
	r2.AddCookie(&http.Cookie{Name: LockCookieName, Value: "scl_from_cookie"})
	if got := ExtractLockToken(r2); got != "scl_from_subproto" {
		t.Errorf("subprotocol must win over cookie: got %q", got)
	}

	// 头压过一切
	r3 := httptest.NewRequest("GET", "/ws/x", nil)
	r3.Header.Set(LockHeaderName, "scl_from_header")
	r3.Header.Set("Sec-WebSocket-Protocol", "scl_from_subproto")
	r3.AddCookie(&http.Cookie{Name: LockCookieName, Value: "scl_from_cookie"})
	if got := ExtractLockToken(r3); got != "scl_from_header" {
		t.Errorf("header must win over all: got %q", got)
	}

	// 全无 → 空串（不误取其他 cookie）
	r4 := httptest.NewRequest("GET", "/ws/x", nil)
	r4.AddCookie(&http.Cookie{Name: "other", Value: "x"})
	if got := ExtractLockToken(r4); got != "" {
		t.Errorf("no carrier: got %q", got)
	}
}

// TestValidateLockTokenForWS_CookieFallback WS 握手期 cookie 载体校验放行
func TestValidateLockTokenForWS_CookieFallback(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })
	lock := store.Get().Lock
	_ = lock.InitDefault()

	token, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	r := httptest.NewRequest("GET", "/ws/projects/p1", nil)
	if _, ok := ValidateLockTokenForWS(r); ok {
		t.Error("handshake without any carrier must be rejected")
	}

	r2 := httptest.NewRequest("GET", "/ws/projects/p1", nil)
	r2.AddCookie(&http.Cookie{Name: LockCookieName, Value: token})
	got, ok := ValidateLockTokenForWS(r2)
	if !ok || got != token {
		t.Errorf("cookie-carried handshake must pass: ok=%v token=%q", ok, got)
	}
}

// TestRequireTokenAuth_CookieFallback API Token 已配置时，本机 UI 直连路径
// （无 Authorization）的解锁令牌豁免对 cookie 载体同样生效——刷新后的页面
// 内存无令牌，强制认证端点（updates/apply 等）只剩 cookie 可带
func TestRequireTokenAuth_CookieFallback(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	// 造一个 API Token 使 HasAny() 为真
	if _, _, err := store.Get().Token.Generate("test-token", 1); err != nil {
		t.Fatalf("create token: %v", err)
	}
	lockToken, err := store.Get().Lock.IssueToken()
	if err != nil {
		t.Fatalf("issue lock token: %v", err)
	}

	r := gin.New()
	r.Use(RequireTokenAuthMiddleware())
	r.POST("/do", func(c *gin.Context) { c.String(200, "ok") })

	// 无任何凭据 → 401
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("POST", "/do", nil))
	if w.Code != 401 {
		t.Errorf("no credential: expected 401, got %d", w.Code)
	}

	// cookie 载体 → 放行
	req := httptest.NewRequest("POST", "/do", nil)
	req.AddCookie(&http.Cookie{Name: LockCookieName, Value: lockToken})
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req)
	if w2.Code != 200 {
		t.Errorf("cookie-carried lock token: expected 200, got %d", w2.Code)
	}
}
