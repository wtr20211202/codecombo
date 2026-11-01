package system

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/store"
)

// setupRouter 首启设密流程测试 router：无配置状态 + 公开组 state/unlock/setup
func setupRouter(t *testing.T) (*gin.Engine, store.LockStore) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	middleware.ResetLockUnlockRateLimitForTesting()
	t.Cleanup(middleware.ResetLockUnlockRateLimitForTesting)

	lock := store.Get().Lock
	if lock.HasConfig() {
		t.Fatal("expected fresh store without lock config")
	}

	r := gin.New()
	h := NewLockHandler()
	lockPublic := r.Group("/api/lock")
	lockPublic.GET("/state", h.GetState)
	lockPublic.POST("/unlock", h.Unlock)
	lockPublic.POST("/setup", h.Setup)

	return r, lock
}

// newSetupReq 构造来自本机回环的 setup 请求（设密仅允许回环来源）
func newSetupReq(body string) *http.Request {
	req := httptest.NewRequest("POST", "/api/lock/setup", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:51000"
	return req
}

// TestSetup_FreshStore 首次设密：写入配置 + 返回 token + 解锁可用
func TestSetup_FreshStore(t *testing.T) {
	r, lock := setupRouter(t)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, newSetupReq(`{"password": "`+testPwdNew+`"}`))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 on setup, got %d: %s", w.Code, w.Body.String())
	}
	if !lock.HasConfig() {
		t.Fatal("expected config after setup")
	}
	if !lock.VerifyPassword(testPwdNew) {
		t.Error("expected password verify to pass after setup")
	}

	var resp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode setup response: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("expected token in setup response")
	}
	if !lock.ValidateToken(resp.Token) {
		t.Error("expected issued token to validate")
	}
}

// TestSetup_AlreadyInitialized 二次设密拒绝：409
func TestSetup_AlreadyInitialized(t *testing.T) {
	r, _ := setupRouter(t)

	body := `{"password": "` + testPwdNew + `"}`
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, newSetupReq(body))
		if i == 0 && w.Code != http.StatusOK {
			t.Fatalf("first setup: expected 200, got %d", w.Code)
		}
		if i == 1 && w.Code != http.StatusConflict {
			t.Fatalf("second setup: expected 409, got %d", w.Code)
		}
	}
}

// TestSetup_RevokesStaleTokens 重设密码后，重置前签发的旧 token 全部失效
// （忘记密码场景：reset-lock 前的存活会话不应在重设后继续可用）
func TestSetup_RevokesStaleTokens(t *testing.T) {
	r, lock := setupRouter(t)

	// 无配置时预签发一个 token（模拟重置前的存活会话）
	oldToken, err := lock.IssueToken()
	if err != nil {
		t.Fatal(err)
	}
	if !lock.ValidateToken(oldToken) {
		t.Fatal("expected old token valid before setup")
	}

	body := `{"password": "` + testPwdNew + `"}`
	req := httptest.NewRequest("POST", "/api/lock/setup", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:51000"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 on setup, got %d", w.Code)
	}

	if lock.ValidateToken(oldToken) {
		t.Error("expected stale token revoked after setup")
	}
}

// TestSetup_LoopbackOnly 默认绑定（127.0.0.1）下非本机回环来源拒绝设密（403）：
// 局域网侧不能抢设首启/重置密码（A3）。
// Host 必须显式设回环：settings 缺省回退 config.Load() 会读到开发机真实配置，
// 使该用例环境敏感
func TestSetup_LoopbackOnly(t *testing.T) {
	r, lock := setupRouter(t)
	store.Get().Settings.Get().Server.Host = "127.0.0.1"

	body := `{"password": "` + testPwdNew + `"}`
	req := httptest.NewRequest("POST", "/api/lock/setup", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "192.168.1.50:51000"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for LAN origin, got %d", w.Code)
	}
	if lock.HasConfig() {
		t.Error("expected no config after rejected setup")
	}
}

// TestSetup_LANAllowedWhenWildcardBound 显式绑定通配地址（0.0.0.0）时放行局域网设密：
// 无头 Linux 部署没有本机浏览器，通配绑定即运维者对局域网开放的有意表达；
// 此前一刀切回环限制把该场景堵死（403 无法完成首次部署）
func TestSetup_LANAllowedWhenWildcardBound(t *testing.T) {
	r, lock := setupRouter(t)
	store.Get().Settings.Get().Server.Host = "0.0.0.0"

	body := `{"password": "` + testPwdNew + `"}`
	req := httptest.NewRequest("POST", "/api/lock/setup", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "192.168.1.50:51000"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for LAN setup with wildcard bind, got %d: %s", w.Code, w.Body.String())
	}
	if !lock.HasConfig() {
		t.Error("expected lock config after LAN setup")
	}
	var resp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.Token == "" {
		t.Fatalf("expected token in response, got %s", w.Body.String())
	}
	if !lock.ValidateToken(resp.Token) {
		t.Error("expected issued token valid after LAN setup")
	}
}

// TestSetup_LANRejectedWhenLoopbackBound 显式绑定回环（127.0.0.1）时维持严格限制
func TestSetup_LANRejectedWhenLoopbackBound(t *testing.T) {
	r, lock := setupRouter(t)
	store.Get().Settings.Get().Server.Host = "127.0.0.1"

	body := `{"password": "` + testPwdNew + `"}`
	req := httptest.NewRequest("POST", "/api/lock/setup", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "192.168.1.50:51000"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for LAN origin with loopback bind, got %d", w.Code)
	}
	if lock.HasConfig() {
		t.Error("expected no config after rejected setup")
	}
}

// TestSetup_EmptyPassword 空密码拒绝：400
func TestSetup_EmptyPassword(t *testing.T) {
	r, lock := setupRouter(t)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, newSetupReq(`{"password": "  "}`))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on empty password, got %d", w.Code)
	}
	if lock.HasConfig() {
		t.Error("expected no config after failed setup")
	}
}

// TestGetState_NeedsSetup 无配置时 state 需返回 needsSetup=true
func TestGetState_NeedsSetup(t *testing.T) {
	r, _ := setupRouter(t)

	req := httptest.NewRequest("GET", "/api/lock/state", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 on state, got %d", w.Code)
	}
	var resp struct {
		NeedsSetup bool `json:"needsSetup"`
		Enabled    bool `json:"enabled"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	if !resp.NeedsSetup {
		t.Error("expected needsSetup=true on fresh store")
	}
}
