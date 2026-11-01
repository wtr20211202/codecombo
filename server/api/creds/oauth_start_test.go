package creds

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"codecombo/server/config"
	"codecombo/server/git/auth"

	"github.com/gin-gonic/gin"
)

// TestOAuthStartMissingClient 验证未配置 OAuth Client 时返回 400 + oauth_client_not_configured
func TestOAuthStartMissingClient(t *testing.T) {
	config.ResetForTest()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	_, _ = config.EncryptToken("init")

	body := `{"platform":"github","host":"github.com"}`
	req := httptest.NewRequest("POST", "/oauth/start", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	OAuthStart(c)

	if w.Code != 400 {
		t.Errorf("status = %d, want 400; body = %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["error"] != "oauth_client_not_configured" {
		t.Errorf("error = %v, want oauth_client_not_configured", resp["error"])
	}
}

// TestOAuthStartUnsupportedPlatform 验证不支持 OAuth Device Flow 的平台返回 400
// gitlab 在 P0 中不实现 OAuthCapable（即使配置了 client 也应被拒绝）
func TestOAuthStartUnsupportedPlatform(t *testing.T) {
	config.ResetForTest()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	_, _ = config.EncryptToken("init")
	config.SetOAuthClientForTest(config.OAuthClientConfig{
		Platform: auth.PlatformGitLab, Host: "gitlab.com", ClientID: "x",
	})

	body := `{"platform":"gitlab","host":"gitlab.com"}`
	req := httptest.NewRequest("POST", "/oauth/start", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	OAuthStart(c)

	// gitlab P0 不支持 OAuth Device Flow（不实现 OAuthCapable）
	if w.Code != 400 {
		t.Errorf("status = %d, want 400; body = %s", w.Code, w.Body.String())
	}
}

// TestOAuthStartNetworkFailureOrSuccess 验证 client 已配置后能调通 StartDeviceFlow
// 由于不 mock GitHub（避免引入网络依赖），CI 网络可达时返 200，不可达时返 502
func TestOAuthStartNetworkFailureOrSuccess(t *testing.T) {
	config.ResetForTest()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	_, _ = config.EncryptToken("init")
	config.SetOAuthClientForTest(config.OAuthClientConfig{
		Platform: auth.PlatformGitHub, Host: "github.com", ClientID: "cid",
	})

	body := `{"platform":"github","host":"github.com"}`
	req := httptest.NewRequest("POST", "/oauth/start", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	OAuthStart(c)

	// 期望 502（无法访问 github.com）或 200（如果 CI 能访问）
	if w.Code != 502 && w.Code != 200 {
		t.Errorf("status = %d, want 502 or 200; body = %s", w.Code, w.Body.String())
	}
}
