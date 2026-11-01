//go:build integration

// Package integration 包含 OAuth Device Flow 端到端集成测试。
// 运行：go test -tags=integration ./server/git/auth/integration/ -v
//
// 本文件覆盖 spec §OAuth 流程的 Start→Poll→Token 全链路验证：
//   - mock GitHub / Gitea OAuth server，按 RFC 8628 响应 device_code + access_token
//   - 第一次 poll 返 authorization_pending（验证 Pending 分类）
//   - 第二次 poll 返成功（验证 TokenBundle 字段）
//   - 单独子测试覆盖 slow_down（验证 SlowDown 分类，区别于 Pending）
package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"codecombo/server/git/auth"
	"codecombo/server/git/auth/providers"
)

// startPollState 跟踪 mock OAuth server 在 Poll 阶段的状态机
// 用于在多次 Poll 之间切换返回内容（pending → ok / slow_down → ok）
type startPollState struct {
	// pollCount 原子计数已发生的 Poll 请求次数
	pollCount int32
	// mode 决定 Poll 端点的响应策略
	//   "pending_then_ok"  ：第 1 次返 pending，第 2 次返 ok
	//   "slow_down_then_ok"：第 1 次返 slow_down，第 2 次返 ok
	mode string
}

// newMockOAuthServer 启一个 httptest server 模拟 OAuth 平台的 device/code + access_token 端点
//
//	参数：
//	  mode：Poll 阶段状态机策略（见 startPollState.mode）
//	  platform：决定 TokenUsername 等约定（"github" / "gitea"）
func newMockOAuthServer(t *testing.T, mode string) (*httptest.Server, *startPollState) {
	t.Helper()
	st := &startPollState{mode: mode}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/login/device/code":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_code":      "DC-test",
				"user_code":        "UC-test",
				"verification_uri": "https://example.com/login/device",
				"expires_in":       900,
				"interval":         1,
			})
		case r.URL.Path == "/login/oauth/access_token":
			n := atomic.AddInt32(&st.pollCount, 1)
			switch st.mode {
			case "pending_then_ok":
				if n < 2 {
					w.WriteHeader(http.StatusBadRequest)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"error": "authorization_pending",
					})
					return
				}
			case "slow_down_then_ok":
				if n < 2 {
					w.WriteHeader(http.StatusBadRequest)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"error": "slow_down",
					})
					return
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "gho_AT",
				"refresh_token": "gho_RT",
				"scope":         "repo",
				"expires_in":    28800,
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	return srv, st
}

// TestOAuthDeviceFlowStartPoll 验证 GitHub Device Flow 的 Start→Poll→Token 主链路
//
// 流程：
//  1. 启 mock GitHub OAuth server（mode=pending_then_ok）
//  2. 调 StartDeviceFlow，校验 DeviceCode / UserCode / Interval
//  3. 第一次 Poll：期望 *AuthError{KindAuthPending}
//  4. 第二次 Poll：期望 TokenBundle 含 access_token / refresh_token / expires_in
func TestOAuthDeviceFlowStartPoll(t *testing.T) {
	srv, _ := newMockOAuthServer(t, "pending_then_ok")
	defer srv.Close()

	p := &providers.GitHubDeviceProvider{
		HTTP:          srv.Client(),
		DeviceCodeURL: srv.URL + "/login/device/code",
		TokenURL:      srv.URL + "/login/oauth/access_token",
	}
	endpoints := &auth.OAuthEndpoints{
		DeviceCodeURL: srv.URL + "/login/device/code",
		TokenURL:      srv.URL + "/login/oauth/access_token",
	}

	// 1. StartDeviceFlow 应拿到 device_code + user_code
	df, err := p.StartDeviceFlow(context.Background(), "client-test", endpoints, []string{"repo"})
	if err != nil {
		t.Fatalf("StartDeviceFlow: %v", err)
	}
	if df.DeviceCode != "DC-test" {
		t.Errorf("DeviceCode = %q, want DC-test", df.DeviceCode)
	}
	if df.UserCode != "UC-test" {
		t.Errorf("UserCode = %q, want UC-test", df.UserCode)
	}
	if df.Interval != 1 {
		t.Errorf("Interval = %d, want 1", df.Interval)
	}

	// 2. 第一次 Poll：authorization_pending 应映射成 KindAuthPending
	_, err = p.PollDeviceFlow(context.Background(), "client-test", df.DeviceCode, endpoints)
	if err == nil {
		t.Fatal("first poll: expected error, got nil")
	}
	var ae *auth.AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("first poll err type = %T, want *auth.AuthError", err)
	}
	if ae.Kind != auth.KindAuthPending {
		t.Errorf("first poll Kind = %v, want KindAuthPending", ae.Kind)
	}

	// 3. 第二次 Poll：应成功返回 TokenBundle
	tb, err := p.PollDeviceFlow(context.Background(), "client-test", df.DeviceCode, endpoints)
	if err != nil {
		t.Fatalf("second poll: %v", err)
	}
	if tb.AccessToken != "gho_AT" {
		t.Errorf("AccessToken = %q, want gho_AT", tb.AccessToken)
	}
	if tb.RefreshToken != "gho_RT" {
		t.Errorf("RefreshToken = %q, want gho_RT", tb.RefreshToken)
	}
	if tb.ExpiresIn != 28800 {
		t.Errorf("ExpiresIn = %d, want 28800", tb.ExpiresIn)
	}
	if tb.Scope != "repo" {
		t.Errorf("Scope = %q, want repo", tb.Scope)
	}
}

// TestOAuthDeviceFlowSlowDown 验证 slow_down 错误独立分类为 KindAuthSlowDown
//
// RFC 8628 §3.5 要求客户端在收到 slow_down 时增大 interval，与 authorization_pending 处理不同。
// 此测试断言 KindAuthSlowDown（非 KindAuthPending），是 G4 修复的核心回归保护。
func TestOAuthDeviceFlowSlowDown(t *testing.T) {
	srv, _ := newMockOAuthServer(t, "slow_down_then_ok")
	defer srv.Close()

	p := &providers.GitHubDeviceProvider{
		HTTP:          srv.Client(),
		DeviceCodeURL: srv.URL + "/login/device/code",
		TokenURL:      srv.URL + "/login/oauth/access_token",
	}
	endpoints := &auth.OAuthEndpoints{
		DeviceCodeURL: srv.URL + "/login/device/code",
		TokenURL:      srv.URL + "/login/oauth/access_token",
	}

	df, err := p.StartDeviceFlow(context.Background(), "client-test", endpoints, []string{"repo"})
	if err != nil {
		t.Fatalf("StartDeviceFlow: %v", err)
	}

	// 第一次 Poll 应返 KindAuthSlowDown（而非 KindAuthPending）
	_, err = p.PollDeviceFlow(context.Background(), "client-test", df.DeviceCode, endpoints)
	if err == nil {
		t.Fatal("first poll: expected slow_down error, got nil")
	}
	var ae *auth.AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("first poll err type = %T, want *auth.AuthError", err)
	}
	if ae.Kind != auth.KindAuthSlowDown {
		t.Errorf("first poll Kind = %v, want KindAuthSlowDown", ae.Kind)
	}

	// 第二次 Poll 应成功（确认 slow_down 后流程可继续）
	tb, err := p.PollDeviceFlow(context.Background(), "client-test", df.DeviceCode, endpoints)
	if err != nil {
		t.Fatalf("second poll after slow_down: %v", err)
	}
	if tb.AccessToken != "gho_AT" {
		t.Errorf("AccessToken = %q, want gho_AT", tb.AccessToken)
	}
}

// TestOAuthDeviceFlowGitea 验证 Gitea Device Flow 的 Start→Poll→Token 链路
// Gitea 与 GitHub 的差异：
//   - scope 用逗号分隔（GitHub 空格）
//   - TokenUsername 固定 "oauth2"
//   - 端点 base URL 由调用方注入（自建实例）
func TestOAuthDeviceFlowGitea(t *testing.T) {
	srv, _ := newMockOAuthServer(t, "pending_then_ok")
	defer srv.Close()

	p := &providers.GiteaDeviceProvider{
		HTTP: srv.Client(),
	}
	endpoints := &auth.OAuthEndpoints{
		DeviceCodeURL: srv.URL + "/login/device/code",
		TokenURL:      srv.URL + "/login/oauth/access_token",
	}

	df, err := p.StartDeviceFlow(context.Background(), "client-gitea", endpoints, []string{"read:user", "write:repository"})
	if err != nil {
		t.Fatalf("StartDeviceFlow: %v", err)
	}
	if df.DeviceCode != "DC-test" {
		t.Errorf("DeviceCode = %q, want DC-test", df.DeviceCode)
	}

	// 第一次 Poll 期望 pending
	_, err = p.PollDeviceFlow(context.Background(), "client-gitea", df.DeviceCode, endpoints)
	var ae *auth.AuthError
	if !errors.As(err, &ae) || ae.Kind != auth.KindAuthPending {
		t.Errorf("first poll err = %v, want KindAuthPending", err)
	}

	// 第二次 Poll 期望成功
	tb, err := p.PollDeviceFlow(context.Background(), "client-gitea", df.DeviceCode, endpoints)
	if err != nil {
		t.Fatalf("second poll: %v", err)
	}
	if tb.AccessToken != "gho_AT" {
		t.Errorf("AccessToken = %q, want gho_AT", tb.AccessToken)
	}

	// 验证 Gitea 的 TokenUsername 约定
	if u := p.TokenUsername(nil); u != "oauth2" {
		t.Errorf("TokenUsername = %q, want oauth2", u)
	}
}
