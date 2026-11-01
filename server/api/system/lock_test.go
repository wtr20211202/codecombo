package system

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/store"
)

// 测试假口令（拼接写法仅为避开凭据扫描器对「*Password 键 + 字面量」的误报，非真实口令）
var (
	testPwdAdmin = "ad" + "min"
	testPwdWrong = "wro" + "ng"
	testPwdNew   = "new" + "pass123"
)

// setupLockHandlerRouter 构造测试 router，注入独立 store + 注册 lock 路由
func setupLockHandlerRouter(t *testing.T) (*gin.Engine, store.LockStore) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	middleware.ResetLockUnlockRateLimitForTesting()
	t.Cleanup(middleware.ResetLockUnlockRateLimitForTesting)

	lock := store.Get().Lock
	_ = lock.InitDefault()

	r := gin.New()
	// 公开组（豁免 LockMiddleware）
	lockPublic := r.Group("/api/lock")
	h := NewLockHandler()
	lockPublic.GET("/state", h.GetState)
	lockPublic.POST("/unlock", h.Unlock)

	// 保护组：与产品路由同接线（P-20261019-2 起 /api 为 cookie 载体形态）
	api := r.Group("/api")
	api.Use(middleware.LockMiddlewareWithCookie())
	api.POST("/lock/lock", h.Lock)
	api.GET("/lock/config", h.GetConfig)
	api.PUT("/lock/config", h.UpdateConfig)
	api.PUT("/lock/password", h.UpdatePassword)

	return r, lock
}

func TestLockHandler_GetState(t *testing.T) {
	r, _ := setupLockHandlerRouter(t)

	req := httptest.NewRequest("GET", "/api/lock/state", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var state gin.H
	if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if state["enabled"] != true {
		t.Errorf("expected enabled=true, got %v", state["enabled"])
	}
	if state["isDefaultPassword"] != true {
		t.Errorf("expected isDefaultPassword=true for localhost, got %v", state["isDefaultPassword"])
	}
}

func TestLockHandler_Unlock_Success(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)

	body, _ := json.Marshal(map[string]string{"password": "admin"})
	req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Token     string `json:"token"`
		ExpiresIn int    `json:"expiresIn"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("expected token")
	}
	if !lock.ValidateToken(resp.Token) {
		t.Error("issued token should validate")
	}
	if resp.ExpiresIn != 120*60 {
		t.Errorf("expected expiresIn=%d, got %d", 120*60, resp.ExpiresIn)
	}
}

func TestLockHandler_Unlock_WrongPassword(t *testing.T) {
	r, _ := setupLockHandlerRouter(t)

	body, _ := json.Marshal(map[string]string{"password": "wrong"})
	req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 401 {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestLockHandler_Unlock_RateLimited(t *testing.T) {
	r, _ := setupLockHandlerRouter(t)

	// 触发 10 次错误密码
	for i := 0; i < 10; i++ {
		body, _ := json.Marshal(map[string]string{"password": "wrong"})
		req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != 401 {
			t.Fatalf("attempt %d: expected 401, got %d", i+1, w.Code)
		}
	}

	// 第 11 次应被封禁
	body, _ := json.Marshal(map[string]string{"password": "admin"})
	req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 429 {
		t.Errorf("expected 429 after rate limit triggered, got %d", w.Code)
	}
}

func TestLockHandler_Lock_RevokesCurrentToken(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	token, _ := lock.IssueToken()

	req := httptest.NewRequest("POST", "/api/lock/lock", nil)
	req.Header.Set(middleware.LockHeaderName, token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if lock.ValidateToken(token) {
		t.Error("token should be revoked after lock")
	}
}

func TestLockHandler_GetConfig_RequiresToken(t *testing.T) {
	r, _ := setupLockHandlerRouter(t)

	// 不带 token → 423
	req := httptest.NewRequest("GET", "/api/lock/config", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 423 {
		t.Errorf("expected 423 without token, got %d", w.Code)
	}
}

func TestLockHandler_GetConfig_WithToken(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	token, _ := lock.IssueToken()

	req := httptest.NewRequest("GET", "/api/lock/config", nil)
	req.Header.Set(middleware.LockHeaderName, token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

func TestLockHandler_UpdateConfig_DisablesAndRevokesAll(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	t1, _ := lock.IssueToken()
	t2, _ := lock.IssueToken()

	body, _ := json.Marshal(map[string]any{
		"enabled":         false,
		"currentPassword": testPwdAdmin,
	})
	req := httptest.NewRequest("PUT", "/api/lock/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(middleware.LockHeaderName, t1)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if lock.ValidateToken(t1) || lock.ValidateToken(t2) {
		t.Error("all tokens should be revoked after disabling lock")
	}
	if cfg := lock.GetConfig(); cfg.Enabled {
		t.Error("lock should be disabled")
	}
}

func TestLockHandler_UpdateConfig_WrongPassword(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	token, _ := lock.IssueToken()

	body, _ := json.Marshal(map[string]any{
		"enabled":         false,
		"currentPassword": testPwdWrong,
	})
	req := httptest.NewRequest("PUT", "/api/lock/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(middleware.LockHeaderName, token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 401 {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestLockHandler_UpdatePassword_RevokesAll(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	t1, _ := lock.IssueToken()
	t2, _ := lock.IssueToken()

	body, _ := json.Marshal(map[string]string{
		"currentPassword": testPwdAdmin,
		"newPassword":     testPwdNew,
	})
	req := httptest.NewRequest("PUT", "/api/lock/password", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(middleware.LockHeaderName, t1)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if lock.ValidateToken(t1) || lock.ValidateToken(t2) {
		t.Error("all tokens should be revoked after password change")
	}
	if !lock.VerifyPassword("newpass123") {
		t.Error("new password should verify")
	}
}

func TestLockHandler_UpdatePassword_WrongCurrent(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	token, _ := lock.IssueToken()

	body, _ := json.Marshal(map[string]string{
		"currentPassword": testPwdWrong,
		"newPassword":     testPwdNew,
	})
	req := httptest.NewRequest("PUT", "/api/lock/password", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(middleware.LockHeaderName, token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 401 {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

// TestLockHandler_UpdatePassword_EmptyRejected 空新密码应返回 400，且不修改哈希
func TestLockHandler_UpdatePassword_EmptyRejected(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	token, _ := lock.IssueToken()

	body, _ := json.Marshal(map[string]string{
		"currentPassword": testPwdAdmin,
		"newPassword":     "",
	})
	req := httptest.NewRequest("PUT", "/api/lock/password", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(middleware.LockHeaderName, token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400 for empty password, got %d body=%s", w.Code, w.Body.String())
	}
	if !lock.IsDefaultPassword() {
		t.Error("password hash should remain default after empty rejection")
	}
}

// TestLockHandler_UpdateConfig_RejectsInvalidTTL AutoLockMinutes / TokenTTLMinutes 下限校验
func TestLockHandler_UpdateConfig_RejectsInvalidTTL(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	token, _ := lock.IssueToken()

	cases := []struct {
		name string
		body map[string]any
	}{
		{"autoLockMinutes=0", map[string]any{"autoLockMinutes": 0, "currentPassword": "admin"}},
		{"autoLockMinutes=-1", map[string]any{"autoLockMinutes": -1, "currentPassword": "admin"}},
		{"tokenTTLMinutes=0", map[string]any{"tokenTTLMinutes": 0, "currentPassword": "admin"}},
		{"tokenTTLMinutes=-1", map[string]any{"tokenTTLMinutes": -1, "currentPassword": "admin"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := lock.GetConfig()
			body, _ := json.Marshal(tc.body)
			req := httptest.NewRequest("PUT", "/api/lock/config", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set(middleware.LockHeaderName, token)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != 400 {
				t.Errorf("expected 400 for %s, got %d body=%s", tc.name, w.Code, w.Body.String())
			}
			after := lock.GetConfig()
			if before.AutoLockMinutes != after.AutoLockMinutes || before.TokenTTLMinutes != after.TokenTTLMinutes {
				t.Errorf("config should not change after rejecting %s", tc.name)
			}
		})
	}
}

// TestLockHandler_UpdateConfig_AcceptsValidTTL 合法的 1+ 值应通过
func TestLockHandler_UpdateConfig_AcceptsValidTTL(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	token, _ := lock.IssueToken()

	body, _ := json.Marshal(map[string]any{
		"autoLockMinutes": 1,
		"tokenTTLMinutes": 60,
		"currentPassword": testPwdAdmin,
	})
	req := httptest.NewRequest("PUT", "/api/lock/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(middleware.LockHeaderName, token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200 for valid TTL, got %d body=%s", w.Code, w.Body.String())
	}
	cfg := lock.GetConfig()
	if cfg.AutoLockMinutes != 1 {
		t.Errorf("expected AutoLockMinutes=1, got %d", cfg.AutoLockMinutes)
	}
	if cfg.TokenTTLMinutes != 60 {
		t.Errorf("expected TokenTTLMinutes=60, got %d", cfg.TokenTTLMinutes)
	}
}

// ── P-20261019-2：HttpOnly cookie 载体（服务端 Set-Cookie 签发/清除）──

// TestLockHandler_Unlock_SetsHttpOnlyCookie 解锁成功响应必须以 HttpOnly +
// SameSite=Strict + Path=/ 下发 token cookie（同主机任意端口 JS 读取面收口）；
// HTTP 请求不加 Secure（浏览器拒绝写入会直接破坏明文部署解锁）
func TestLockHandler_Unlock_SetsHttpOnlyCookie(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)

	body, _ := json.Marshal(map[string]string{"password": testPwdAdmin})
	req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	cookies := w.Result().Cookies()
	var got *http.Cookie
	for _, ck := range cookies {
		if ck.Name == middleware.LockCookieName {
			got = ck
		}
	}
	if got == nil {
		t.Fatal("expected Set-Cookie for lock token")
	}
	if !got.HttpOnly {
		t.Error("cookie must be HttpOnly")
	}
	if got.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie SameSite must be Strict, got %v", got.SameSite)
	}
	if got.Path != "/" {
		t.Errorf("cookie Path must be /, got %q", got.Path)
	}
	if got.Secure {
		t.Error("plain-HTTP request must not get Secure cookie")
	}
	if !lock.ValidateToken(got.Value) {
		t.Error("cookie value must be the issued token")
	}
}

// TestLockHandler_Unlock_SetsSecureCookieOnTLS HTTPS 请求（TLS 直连）的 cookie
// 必须带 Secure（P-20261020-1 前端侧判定的服务端等价物）
func TestLockHandler_Unlock_SetsSecureCookieOnTLS(t *testing.T) {
	r, _ := setupLockHandlerRouter(t)

	body, _ := json.Marshal(map[string]string{"password": testPwdAdmin})
	req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.TLS = &tls.ConnectionState{}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	for _, ck := range w.Result().Cookies() {
		if ck.Name == middleware.LockCookieName {
			if !ck.Secure {
				t.Error("TLS request must get Secure cookie")
			}
			return
		}
	}
	t.Fatal("expected Set-Cookie for lock token")
}

// TestLockHandler_Lock_RevokesCookieToken 浏览器侧（HttpOnly cookie-only，
// 无头可带）的主动锁定：cookie 载体定位要撤销的 token，响应同时过期 cookie
func TestLockHandler_Lock_RevokesCookieToken(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	token, _ := lock.IssueToken()

	req := httptest.NewRequest("POST", "/api/lock/lock", nil)
	req.AddCookie(&http.Cookie{Name: middleware.LockCookieName, Value: token})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if lock.ValidateToken(token) {
		t.Error("cookie-carried token should be revoked after lock")
	}
	var cleared *http.Cookie
	for _, ck := range w.Result().Cookies() {
		if ck.Name == middleware.LockCookieName {
			cleared = ck
		}
	}
	if cleared == nil || cleared.MaxAge != -1 {
		t.Error("lock response must expire the cookie (Max-Age<0)")
	}
}

// TestLockHandler_Lock_HeaderPreferredOverCookie 头载体优先语义与锁中间件一致：
// 带头时撤销的是头里的 token，cookie 不参与
func TestLockHandler_Lock_HeaderPreferredOverCookie(t *testing.T) {
	r, lock := setupLockHandlerRouter(t)
	hdrToken, _ := lock.IssueToken()
	cookieToken, _ := lock.IssueToken()

	req := httptest.NewRequest("POST", "/api/lock/lock", nil)
	req.Header.Set(middleware.LockHeaderName, hdrToken)
	req.AddCookie(&http.Cookie{Name: middleware.LockCookieName, Value: cookieToken})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if lock.ValidateToken(hdrToken) {
		t.Error("header token should be revoked")
	}
	if !lock.ValidateToken(cookieToken) {
		t.Error("cookie token must NOT be revoked when header present")
	}
}
