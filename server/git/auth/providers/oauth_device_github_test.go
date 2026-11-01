package providers

import (
	"context"
	"encoding/json"
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

// newMockGitHub 启一个 httptest server 模拟 GitHub OAuth 端点
// deviceCodeResp：/login/device/code 的 JSON 响应体
// tokenResp：/login/oauth/access_token 的 JSON 响应体
// tokenStatus：token 端点的 HTTP 状态码（0 表示不写状态码，用默认 200）
//
// 测试 Pending / Denied 等错误分支时，token 端点返 400 + JSON body（含 error 字段），
// 这是 GitHub 实际行为——RFC 8628 规定 error 走 JSON body 而非 HTTP 状态码
func newMockGitHub(t *testing.T, deviceCodeResp, tokenResp string, tokenStatus int) (*httptest.Server, *GitHubDeviceProvider) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/login/device/code"):
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
	p := &GitHubDeviceProvider{
		HTTP:          srv.Client(),
		DeviceCodeURL: srv.URL + "/login/device/code",
		TokenURL:      srv.URL + "/login/oauth/access_token",
	}
	return srv, p
}

// TestGitHubStartDeviceFlow 验证 StartDeviceFlow 正确解析 device_code/user_code/interval
func TestGitHubStartDeviceFlow(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitHub(t,
		`{"device_code":"DC-xxx","user_code":"ABCD-WXYZ","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}`,
		``, 0)
	defer srv.Close()

	df, err := p.StartDeviceFlow(context.Background(), "client-xxx", &auth.OAuthEndpoints{
		DeviceCodeURL: p.DeviceCodeURL,
	}, []string{"repo"})
	if err != nil {
		t.Fatalf("StartDeviceFlow: %v", err)
	}
	if df.DeviceCode != "DC-xxx" {
		t.Errorf("DeviceCode = %q", df.DeviceCode)
	}
	if df.UserCode != "ABCD-WXYZ" {
		t.Errorf("UserCode = %q", df.UserCode)
	}
	if df.Interval != 5 {
		t.Errorf("Interval = %d, want 5", df.Interval)
	}
	if df.VerificationURI != "https://github.com/login/device" {
		t.Errorf("VerificationURI = %q", df.VerificationURI)
	}
}

// TestGitHubPollDeviceFlowSuccess 验证 PollDeviceFlow 成功返回 token bundle
func TestGitHubPollDeviceFlowSuccess(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitHub(t, ``,
		`{"access_token":"gho_AT","refresh_token":"gho_RT","token_type":"bearer","scope":"repo","expires_in":28800}`, 200)
	defer srv.Close()

	tb, err := p.PollDeviceFlow(context.Background(), "client-xxx", "DC-xxx", &auth.OAuthEndpoints{
		TokenURL: p.TokenURL,
	})
	if err != nil {
		t.Fatalf("PollDeviceFlow: %v", err)
	}
	if tb.AccessToken != "gho_AT" {
		t.Errorf("AccessToken = %q", tb.AccessToken)
	}
	if tb.RefreshToken != "gho_RT" {
		t.Errorf("RefreshToken = %q", tb.RefreshToken)
	}
	if tb.ExpiresIn != 28800 {
		t.Errorf("ExpiresIn = %d, want 28800", tb.ExpiresIn)
	}
	if tb.Scope != "repo" {
		t.Errorf("Scope = %q", tb.Scope)
	}
}

// TestGitHubPollDeviceFlowPending 验证 authorization_pending 错误分类为 KindAuthPending
func TestGitHubPollDeviceFlowPending(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitHub(t, ``,
		`{"error":"authorization_pending","error_description":"..."}`, 400)
	defer srv.Close()

	_, err := p.PollDeviceFlow(context.Background(), "client-xxx", "DC-xxx", &auth.OAuthEndpoints{
		TokenURL: p.TokenURL,
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

// TestGitHubPollDeviceFlowDenied 验证 access_denied 错误分类为 KindAuthDenied
func TestGitHubPollDeviceFlowDenied(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitHub(t, ``,
		`{"error":"access_denied"}`, 400)
	defer srv.Close()

	_, err := p.PollDeviceFlow(context.Background(), "c", "d", &auth.OAuthEndpoints{TokenURL: p.TokenURL})
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

// TestGitHubPollDeviceFlowSlowDown 验证 slow_down 错误分类为 KindAuthSlowDown
// RFC 8628 §3.5：slow_down 需独立 Kind，handler 据此增大 interval
func TestGitHubPollDeviceFlowSlowDown(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitHub(t, ``,
		`{"error":"slow_down"}`, 400)
	defer srv.Close()

	_, err := p.PollDeviceFlow(context.Background(), "c", "d", &auth.OAuthEndpoints{TokenURL: p.TokenURL})
	var ae *auth.AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("error type = %T, want *AuthError", err)
	}
	if ae.Kind != auth.KindAuthSlowDown {
		t.Errorf("Kind = %v, want KindAuthSlowDown", ae.Kind)
	}
}

// TestGitHubPollDeviceFlowExpired 验证 expired_token 错误分类为 KindAuthExpired
func TestGitHubPollDeviceFlowExpired(t *testing.T) {
	setupTestCrypto(t)
	srv, p := newMockGitHub(t, ``,
		`{"error":"expired_token"}`, 400)
	defer srv.Close()

	_, err := p.PollDeviceFlow(context.Background(), "c", "d", &auth.OAuthEndpoints{TokenURL: p.TokenURL})
	var ae *auth.AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("error type = %T, want *AuthError", err)
	}
	if ae.Kind != auth.KindAuthExpired {
		t.Errorf("Kind = %v, want KindAuthExpired", ae.Kind)
	}
}

// TestGitHubRefreshTokenInvalidGrant 验证 invalid_grant 错误分类为 KindAuthExpired
func TestGitHubRefreshTokenInvalidGrant(t *testing.T) {
	setupTestCrypto(t)
	enc, _ := config.EncryptToken("old-rt")
	srv, p := newMockGitHub(t, ``,
		`{"error":"invalid_grant"}`, 200)
	defer srv.Close()

	cred := &store.Credential{
		AuthType:      store.AuthTypeOAuthDevice,
		RefreshToken:  enc,
		OAuthClientID: "client-xxx",
	}
	_, err := p.RefreshToken(context.Background(), cred, "client-xxx", &auth.OAuthEndpoints{TokenURL: p.TokenURL})
	var ae *auth.AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("error type = %T, want *AuthError", err)
	}
	if ae.Kind != auth.KindAuthExpired {
		t.Errorf("Kind = %v, want KindAuthExpired", ae.Kind)
	}
}

// TestGitHubRefreshTokenSuccess 验证 refresh 成功返回新 token
func TestGitHubRefreshTokenSuccess(t *testing.T) {
	setupTestCrypto(t)
	enc, _ := config.EncryptToken("old-rt")
	srv, p := newMockGitHub(t, ``,
		`{"access_token":"gho_NEW","refresh_token":"gho_NEWRT","token_type":"bearer","scope":"repo","expires_in":28800}`, 200)
	defer srv.Close()

	cred := &store.Credential{
		AuthType:      store.AuthTypeOAuthDevice,
		RefreshToken:  enc,
		OAuthClientID: "client-xxx",
	}
	tb, err := p.RefreshToken(context.Background(), cred, "client-xxx", &auth.OAuthEndpoints{TokenURL: p.TokenURL})
	if err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if tb.AccessToken != "gho_NEW" {
		t.Errorf("AccessToken = %q", tb.AccessToken)
	}
	if tb.RefreshToken != "gho_NEWRT" {
		t.Errorf("RefreshToken = %q", tb.RefreshToken)
	}
}

// TestGitHubResolveNotExpired 验证 ExpiresAt 在未来时直接返回当前 token
func TestGitHubResolveNotExpired(t *testing.T) {
	setupTestCrypto(t)
	enc, _ := config.EncryptToken("gho_AT")

	p := &GitHubDeviceProvider{}
	cred := &store.Credential{
		AuthType:  store.AuthTypeOAuthDevice,
		Username:  "x-access-token",
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
	if got.Password != "gho_AT" {
		t.Errorf("Password = %q, want gho_AT", got.Password)
	}
	if got.Username != "x-access-token" {
		t.Errorf("Username = %q, want x-access-token", got.Username)
	}
}

// TestGitHubResolveExpiredCred 验证 Status=expired 时返回 (nil, nil)
func TestGitHubResolveExpiredCred(t *testing.T) {
	setupTestCrypto(t)
	p := &GitHubDeviceProvider{}
	cred := &store.Credential{AuthType: store.AuthTypeOAuthDevice, Status: store.StatusExpired}

	got, err := p.Resolve(context.Background(), cred)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil resolved, got %+v", got)
	}
}

// TestGitHubTokenUsername 验证 TokenUsername 固定返回 "x-access-token"
// 这是 GitHub PAT / OAuth token 的 username 约定（HTTPS Basic Auth 的 username 字段）
func TestGitHubTokenUsername(t *testing.T) {
	p := &GitHubDeviceProvider{}
	if u := p.TokenUsername(nil); u != "x-access-token" {
		t.Errorf("TokenUsername = %q, want x-access-token", u)
	}
}

// TestGitHubType 验证 Type() 返回 "oauth-device"
func TestGitHubType(t *testing.T) {
	p := &GitHubDeviceProvider{}
	if p.Type() != store.AuthTypeOAuthDevice {
		t.Errorf("Type = %q, want oauth-device", p.Type())
	}
}

// 防止 unused json import warning（如未来某测试不再用 json 可移除）
var _ = json.Marshal
