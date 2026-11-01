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

func init() {
	gin.SetMode(gin.TestMode)
}

func TestSaveOAuthClient(t *testing.T) {
	// 重置 config 单例，确保干净环境
	config.ResetForTest()
	// 初始化 master-key（避免后续 EncryptToken panic）
	t.Setenv("CC_DATA_DIR", t.TempDir())
	_, _ = config.EncryptToken("init")

	body := `{"platform":"github","host":"github.com","client_id":"ghp_xxx","client_secret":"shh"}`
	req := httptest.NewRequest("POST", "/oauth-clients", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	c, _ := gin.CreateTestContext(w)
	c.Request = req

	SaveOAuthClient(c)

	if w.Code != 200 {
		t.Errorf("status = %d, want 200; body = %s", w.Code, w.Body.String())
	}

	// 验证持久化
	cfg := config.Load()
	if len(cfg.OAuthClients) != 1 {
		t.Fatalf("OAuthClients len = %d", len(cfg.OAuthClients))
	}
	if cfg.OAuthClients[0].ClientID != "ghp_xxx" {
		t.Errorf("ClientID = %q", cfg.OAuthClients[0].ClientID)
	}
	// client_secret 不应明文存储（应 enc: 前缀）
	if cfg.OAuthClients[0].ClientSecret == "shh" {
		t.Errorf("ClientSecret not encrypted: %q", cfg.OAuthClients[0].ClientSecret)
	}
	if !config.IsEncrypted(cfg.OAuthClients[0].ClientSecret) {
		t.Errorf("ClientSecret should be enc: prefixed: %q", cfg.OAuthClients[0].ClientSecret)
	}
}

func TestListOAuthClientsDoesNotReturnSecret(t *testing.T) {
	config.ResetForTest()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	_, _ = config.EncryptToken("init")
	// 先存一个带 secret 的 client
	config.SetOAuthClientForTest(config.OAuthClientConfig{
		Platform: auth.PlatformGitHub, Host: "github.com",
		ClientID: "cid", ClientSecret: "enc:xxx",
	})

	req := httptest.NewRequest("GET", "/oauth-clients", nil)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	ListOAuthClients(c)

	if w.Code != 200 {
		t.Fatalf("status = %d", w.Code)
	}

	var resp struct {
		Clients []map[string]any `json:"clients"`
	}
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if len(resp.Clients) != 1 {
		t.Fatalf("clients len = %d", len(resp.Clients))
	}
	// 永不返回 client_secret 字段（即便加密也不返回）
	if _, exists := resp.Clients[0]["client_secret"]; exists {
		t.Error("client_secret should not be in response")
	}
	// 必须返回 has_secret 布尔
	if _, exists := resp.Clients[0]["has_secret"]; !exists {
		t.Error("has_secret missing")
	}
}

func TestDeleteOAuthClient(t *testing.T) {
	config.ResetForTest()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	_, _ = config.EncryptToken("init")
	config.SetOAuthClientForTest(config.OAuthClientConfig{
		Platform: auth.PlatformGitHub, Host: "github.com", ClientID: "x",
	})

	req := httptest.NewRequest("DELETE", "/oauth-clients/github/github.com", nil)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{
		{Key: "platform", Value: "github"},
		{Key: "host", Value: "github.com"},
	}
	c.Request = req

	DeleteOAuthClient(c)

	if w.Code != 200 {
		t.Errorf("status = %d; body = %s", w.Code, w.Body.String())
	}
	cfg := config.Load()
	if len(cfg.OAuthClients) != 0 {
		t.Errorf("after delete, len = %d", len(cfg.OAuthClients))
	}
}

// TestSaveOAuthClientInvalidPlatform 验证 platform 白名单
func TestSaveOAuthClientInvalidPlatform(t *testing.T) {
	config.ResetForTest()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	_, _ = config.EncryptToken("init")

	body := `{"platform":"gitlab","host":"gitlab.com","client_id":"x"}`
	req := httptest.NewRequest("POST", "/oauth-clients", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	SaveOAuthClient(c)

	if w.Code != 400 {
		t.Errorf("status = %d, want 400; body = %s", w.Code, w.Body.String())
	}
}

// TestSaveOAuthClientKeepsSecretWhenEmpty 验证空 secret 时保留原值（更新场景）
func TestSaveOAuthClientKeepsSecretWhenEmpty(t *testing.T) {
	config.ResetForTest()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	_, _ = config.EncryptToken("init")

	// 先存一个带 secret 的
	config.SetOAuthClientForTest(config.OAuthClientConfig{
		Platform: auth.PlatformGitHub, Host: "github.com",
		ClientID: "old_id", ClientSecret: "enc:old",
	})

	// 再次保存，但 secret 为空（仅更新 ClientID）
	body := `{"platform":"github","host":"github.com","client_id":"new_id"}`
	req := httptest.NewRequest("POST", "/oauth-clients", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	SaveOAuthClient(c)

	if w.Code != 200 {
		t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
	}
	cfg := config.Load()
	if len(cfg.OAuthClients) != 1 {
		t.Fatalf("should be exactly 1 (updated in place), got %d", len(cfg.OAuthClients))
	}
	if cfg.OAuthClients[0].ClientID != "new_id" {
		t.Errorf("ClientID = %q, want new_id", cfg.OAuthClients[0].ClientID)
	}
	// 原 secret 保留
	if cfg.OAuthClients[0].ClientSecret != "enc:old" {
		t.Errorf("ClientSecret = %q, want enc:old", cfg.OAuthClients[0].ClientSecret)
	}
}
