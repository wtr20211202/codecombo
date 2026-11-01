package providers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/git/auth"
	"codecombo/server/store"
)

// newMockGitea 启一个 httptest server 模拟 Gitea OAuth 端点
// 与 GitHub mock 的差异：device code 路径用 /login/oauth/device_code（GitHub 是 /login/device/code）
// token 端点路径与 GitHub 一致：/login/oauth/access_token
//
// deviceCodeResp：/login/oauth/device_code 的 JSON 响应体
// tokenResp：/login/oauth/access_token 的 JSON 响应体
// tokenStatus：token 端点的 HTTP 状态码（0 表示不写状态码，用默认 200）
func newMockGitea(t *testing.T, deviceCodeResp, tokenResp string, tokenStatus int) (*httptest.Server, *GiteaDeviceProvider) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/login/oauth/device_code"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(deviceCodeResp))
		case strings.HasSuffix(r.URL.Path, "/login/oauth/access_token"):
			w.Header().Set("Content-Type", "application/json")
			if tokenStatus != 0 {
				w.WriteHeader(tokenStatus)
			}
			_, _ = w.Write([]byte(tokenResp))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	p := &GiteaDeviceProvider{
		HTTP: srv.Client(),
	}
	return srv, p
}

// TestGiteaStartDeviceFlow 验证 StartDeviceFlow 正确解析 device_code/user_code/interval
// Gitea 自建实例 URL 不固定，所以端点通过 endpoints 参数显式传入（不依赖 provider 字段）
func TestGiteaStartDeviceFlow(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitea(t,
		`{"device_code":"DC","user_code":"UC","verification_uri":"https://gitea.com/login/device","expires_in":900,"interval":5}`,
		``, 0)
	defer srv.Close()

	df, err := p.StartDeviceFlow(context.Background(), "client-xxx", &auth.OAuthEndpoints{
		DeviceCodeURL: srv.URL + "/login/oauth/device_code",
	}, []string{"read", "write"})
	if err != nil {
		t.Fatalf("StartDeviceFlow: %v", err)
	}
	if df.DeviceCode != "DC" {
		t.Errorf("DeviceCode = %q, want DC", df.DeviceCode)
	}
	if df.UserCode != "UC" {
		t.Errorf("UserCode = %q, want UC", df.UserCode)
	}
	if df.Interval != 5 {
		t.Errorf("Interval = %d, want 5", df.Interval)
	}
	if df.VerificationURI != "https://gitea.com/login/device" {
		t.Errorf("VerificationURI = %q", df.VerificationURI)
	}
}

// TestGiteaPollDeviceFlowSuccess 验证 PollDeviceFlow 成功返回 token bundle
func TestGiteaPollDeviceFlowSuccess(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitea(t, ``,
		`{"access_token":"gt_AT","refresh_token":"gt_RT","token_type":"bearer","scope":"read,write","expires_in":3600}`, 200)
	defer srv.Close()

	tb, err := p.PollDeviceFlow(context.Background(), "client-xxx", "DC", &auth.OAuthEndpoints{
		TokenURL: srv.URL + "/login/oauth/access_token",
	})
	if err != nil {
		t.Fatalf("PollDeviceFlow: %v", err)
	}
	if tb.AccessToken != "gt_AT" {
		t.Errorf("AccessToken = %q", tb.AccessToken)
	}
	if tb.RefreshToken != "gt_RT" {
		t.Errorf("RefreshToken = %q", tb.RefreshToken)
	}
	if tb.ExpiresIn != 3600 {
		t.Errorf("ExpiresIn = %d, want 3600", tb.ExpiresIn)
	}
	if tb.Scope != "read,write" {
		t.Errorf("Scope = %q", tb.Scope)
	}
}

// TestGiteaPollDeviceFlowPending 验证 authorization_pending 错误分类为 KindAuthPending
func TestGiteaPollDeviceFlowPending(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitea(t, ``,
		`{"error":"authorization_pending","error_description":"..."}`, 400)
	defer srv.Close()

	_, err := p.PollDeviceFlow(context.Background(), "client-xxx", "DC", &auth.OAuthEndpoints{
		TokenURL: srv.URL + "/login/oauth/access_token",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	var ae *auth.AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("error type = %T, want *AuthError", err)
	}
	if ae.Kind != auth.KindAuthPending {
		t.Errorf("Kind = %v, want KindAuthPending", ae.Kind)
	}
}

// TestGiteaPollDeviceFlowDenied 验证 access_denied 错误分类为 KindAuthDenied
func TestGiteaPollDeviceFlowDenied(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitea(t, ``,
		`{"error":"access_denied"}`, 400)
	defer srv.Close()

	_, err := p.PollDeviceFlow(context.Background(), "c", "d", &auth.OAuthEndpoints{TokenURL: srv.URL + "/login/oauth/access_token"})
	if err == nil {
		t.Fatal("expected error")
	}
	var ae *auth.AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("error type = %T, want *AuthError", err)
	}
	if ae.Kind != auth.KindAuthDenied {
		t.Errorf("Kind = %v, want KindAuthDenied", ae.Kind)
	}
}

// TestGiteaPollDeviceFlowExpired 验证 expired_token 错误分类为 KindAuthExpired
func TestGiteaPollDeviceFlowExpired(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitea(t, ``,
		`{"error":"expired_token"}`, 400)
	defer srv.Close()

	_, err := p.PollDeviceFlow(context.Background(), "c", "d", &auth.OAuthEndpoints{TokenURL: srv.URL + "/login/oauth/access_token"})
	var ae *auth.AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("error type = %T, want *AuthError", err)
	}
	if ae.Kind != auth.KindAuthExpired {
		t.Errorf("Kind = %v, want KindAuthExpired", ae.Kind)
	}
}

// TestGiteaRefreshTokenSuccess 验证 refresh 成功返回新 token
func TestGiteaRefreshTokenSuccess(t *testing.T) {
	setupTestCrypto(t)
	enc, _ := config.EncryptToken("old-rt")
	srv, p := newMockGitea(t, ``,
		`{"access_token":"gt_NEW","refresh_token":"gt_NEWRT","token_type":"bearer","scope":"read,write","expires_in":3600}`, 200)
	defer srv.Close()

	cred := &store.Credential{
		AuthType:      store.AuthTypeOAuthDevice,
		RefreshToken:  enc,
		OAuthClientID: "client-xxx",
	}
	tb, err := p.RefreshToken(context.Background(), cred, "client-xxx", &auth.OAuthEndpoints{TokenURL: srv.URL + "/login/oauth/access_token"})
	if err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if tb.AccessToken != "gt_NEW" {
		t.Errorf("AccessToken = %q", tb.AccessToken)
	}
	if tb.RefreshToken != "gt_NEWRT" {
		t.Errorf("RefreshToken = %q", tb.RefreshToken)
	}
}

// TestGiteaRefreshTokenInvalidGrant 验证 invalid_grant 错误分类为 KindAuthExpired
func TestGiteaRefreshTokenInvalidGrant(t *testing.T) {
	setupTestCrypto(t)
	enc, _ := config.EncryptToken("old-rt")
	srv, p := newMockGitea(t, ``,
		`{"error":"invalid_grant"}`, 200)
	defer srv.Close()

	cred := &store.Credential{
		AuthType:      store.AuthTypeOAuthDevice,
		RefreshToken:  enc,
		OAuthClientID: "client-xxx",
	}
	_, err := p.RefreshToken(context.Background(), cred, "client-xxx", &auth.OAuthEndpoints{TokenURL: srv.URL + "/login/oauth/access_token"})
	var ae *auth.AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("error type = %T, want *AuthError", err)
	}
	if ae.Kind != auth.KindAuthExpired {
		t.Errorf("Kind = %v, want KindAuthExpired", ae.Kind)
	}
}

// TestGiteaResolveNotExpired 验证 ExpiresAt 在未来时直接返回当前 token
// Gitea 的 Resolve 与 GitHub 几乎一致，主要差异在 username（"oauth2"）
func TestGiteaResolveNotExpired(t *testing.T) {
	setupTestCrypto(t)
	enc, _ := config.EncryptToken("gt_AT")

	p := &GiteaDeviceProvider{}
	cred := &store.Credential{
		AuthType:  store.AuthTypeOAuthDevice,
		Username:  "oauth2",
		Secret:    enc,
		Status:    store.StatusActive,
		ExpiresAt: time.Now().Add(1 * time.Hour), // 距 now 1 小时，大于 5 分钟阈值
	}
	got, err := p.Resolve(context.Background(), cred)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got == nil {
		t.Fatal("expected non-nil resolved")
	}
	if got.Password != "gt_AT" {
		t.Errorf("Password = %q, want gt_AT", got.Password)
	}
	if got.Username != "oauth2" {
		t.Errorf("Username = %q, want oauth2", got.Username)
	}
}

// TestGiteaResolveExpiredCred 验证 Status=expired 时返回 (nil, nil)
func TestGiteaResolveExpiredCred(t *testing.T) {
	setupTestCrypto(t)
	p := &GiteaDeviceProvider{}
	cred := &store.Credential{AuthType: store.AuthTypeOAuthDevice, Status: store.StatusExpired}

	got, err := p.Resolve(context.Background(), cred)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil resolved, got %+v", got)
	}
}

// TestGiteaResolveExpiringSoonFallback 验证即将过期 + 无 endpoints 注入时返回 (nil, nil)
//
// 旧实现返回即将过期的旧 token，会让 git 拿着可能失效的 token 撞 401 弹认证失败；
// 新实现返回 nil 让 git 走下一个 helper（credential manager / GCM）兜底，更安全
func TestGiteaResolveExpiringSoonFallback(t *testing.T) {
	setupTestCrypto(t)
	enc, _ := config.EncryptToken("gt_AT")

	p := &GiteaDeviceProvider{}
	cred := &store.Credential{
		AuthType:      store.AuthTypeOAuthDevice,
		Username:      "oauth2",
		Secret:        enc,
		Status:        store.StatusActive,
		ExpiresAt:     time.Now().Add(1 * time.Minute), // 距 now 1 分钟，小于 5 分钟阈值
		OAuthClientID: "client-xxx",                    // 即使有 client id，无 endpoints 也无法 refresh
	}
	got, err := p.Resolve(context.Background(), cred)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil resolved for expiring token without endpoints, got %+v", got)
	}
}

// TestGiteaTokenUsername 验证 TokenUsername 固定返回 "oauth2"
// 这是 Gitea OAuth token 的 username 约定（HTTPS Basic Auth 的 username 字段）
func TestGiteaTokenUsername(t *testing.T) {
	p := &GiteaDeviceProvider{}
	if u := p.TokenUsername(nil); u != "oauth2" {
		t.Errorf("TokenUsername = %q, want oauth2", u)
	}
}

// TestGiteaType 验证 Type() 返回 "oauth-device"
func TestGiteaType(t *testing.T) {
	p := &GiteaDeviceProvider{}
	if p.Type() != store.AuthTypeOAuthDevice {
		t.Errorf("Type = %q, want oauth-device", p.Type())
	}
}
