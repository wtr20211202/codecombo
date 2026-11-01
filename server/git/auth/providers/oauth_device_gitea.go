package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"codecombo/server/config"
	"codecombo/server/git/auth"
	"codecombo/server/store"
)

// GiteaDeviceProvider 处理 Gitea（含自建实例）的 OAuth Device Flow（RFC 8628）
// 与 GitHubDeviceProvider 几乎一致；主要差异：
//  1. TokenUsername 固定 "oauth2"（GitHub 是 "x-access-token"）
//  2. StartDeviceFlow 的 scope 用逗号 "," 分隔（GitHub 用空格）
//  3. 自建 Gitea 实例 base URL 不固定，端点必须由调用方通过 endpoints 参数显式注入
//     因此本 provider 不持有 DeviceCodeURL / TokenURL 字段（与 GitHub 不同）
type GiteaDeviceProvider struct {
	HTTP *http.Client // nil 时 fallback oauthHTTPClient（registry.go，带 30s 超时）

	// Store 可选：由 HTTPSResolver.Resolve 在调用 Resolve 前通过 SetStore 注入
	// 用于 refresh 成功后持久化 cred（当前 Resolve 未触发 refresh，字段保留以对称 + 为后续 endpoints 注入铺路）
	Store store.CredentialStore
}

// SetStore 由 caller（HTTPSResolver）通过 type assertion 注入 cred 仓储
// 与 GitHubDeviceProvider.SetStore 对称；详见 server/git/auth/https_resolver.go findProvider
func (p *GiteaDeviceProvider) SetStore(s store.CredentialStore) {
	p.Store = s
}

// Type 返回 AuthType，供 registry 注册时分类
func (p *GiteaDeviceProvider) Type() string { return store.AuthTypeOAuthDevice }

// TokenUsername 返回 Gitea OAuth token 的 username 约定
// cred 参数保留以满足 TokenUsernameProvider 接口签名，Gitea 不依赖 cred 内容
func (p *GiteaDeviceProvider) TokenUsername(_ *store.Credential) string {
	return "oauth2"
}

// StartDeviceFlow 向 Gitea 请求 device_code + user_code
// 成功响应：{device_code, user_code, verification_uri, expires_in, interval}
// scopes 多个时用逗号分隔（Gitea 约定，与 GitHub 空格分隔不同）
func (p *GiteaDeviceProvider) StartDeviceFlow(ctx context.Context, clientID string, endpoints *auth.OAuthEndpoints, scopes []string) (*auth.DeviceFlow, error) {
	if endpoints == nil || endpoints.DeviceCodeURL == "" {
		// Gitea 自建实例 URL 不固定，端点必须显式注入
		return nil, auth.ConfigError("gitea-device-start", fmt.Errorf("endpoints.DeviceCodeURL is empty"))
	}

	form := url.Values{
		"client_id": {clientID},
		"scope":     {strings.Join(scopes, ",")}, // Gitea scope 用逗号分隔
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoints.DeviceCodeURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, auth.InternalError("gitea-device-start", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient().Do(req)
	if err != nil {
		return nil, auth.NetworkError("gitea-device-start", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return nil, auth.NetworkError("gitea-device-start", fmt.Errorf("status %d: %s", resp.StatusCode, string(body)))
	}

	var raw struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, auth.InternalError("gitea-device-start", err)
	}

	return &auth.DeviceFlow{
		DeviceCode:      raw.DeviceCode,
		UserCode:        raw.UserCode,
		VerificationURI: raw.VerificationURI,
		ExpiresIn:       raw.ExpiresIn,
		Interval:        raw.Interval,
	}, nil
}

// PollDeviceFlow 轮询 token 端点
// Gitea 与 GitHub 一致：error 字段走 JSON body（即使 HTTP 400）
// 错误分类共享 classifyPollError（providers 包内部工具，遵循 RFC 8628）
func (p *GiteaDeviceProvider) PollDeviceFlow(ctx context.Context, clientID, deviceCode string, endpoints *auth.OAuthEndpoints) (*auth.TokenBundle, error) {
	if endpoints == nil || endpoints.TokenURL == "" {
		return nil, auth.ConfigError("gitea-device-poll", fmt.Errorf("endpoints.TokenURL is empty"))
	}

	form := url.Values{
		"client_id":   {clientID},
		"device_code": {deviceCode},
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoints.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, auth.InternalError("gitea-device-poll", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient().Do(req)
	if err != nil {
		return nil, auth.NetworkError("gitea-device-poll", err)
	}
	defer resp.Body.Close()

	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
		ExpiresIn    int    `json:"expires_in"`
		Error        string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, auth.InternalError("gitea-device-poll", err)
	}

	if raw.Error != "" {
		return nil, classifyPollError(raw.Error)
	}

	if raw.AccessToken == "" {
		return nil, auth.InternalError("gitea-device-poll", fmt.Errorf("empty access_token"))
	}

	return &auth.TokenBundle{
		AccessToken:  raw.AccessToken,
		RefreshToken: raw.RefreshToken,
		ExpiresIn:    raw.ExpiresIn,
		Scope:        raw.Scope,
	}, nil
}

// RefreshToken 用 refresh_token 换新 access_token
// 同 TokenURL 端点，grant_type=refresh_token
// invalid_grant 表示 refresh_token 已失效，需用户重新走 OAuth
func (p *GiteaDeviceProvider) RefreshToken(ctx context.Context, cred *store.Credential, clientID string, endpoints *auth.OAuthEndpoints) (*auth.TokenBundle, error) {
	if endpoints == nil || endpoints.TokenURL == "" {
		return nil, auth.ConfigError("gitea-refresh", fmt.Errorf("endpoints.TokenURL is empty"))
	}

	rt, err := config.DecryptToken(cred.RefreshToken)
	if err != nil {
		return nil, auth.InternalError("gitea-refresh", err)
	}

	form := url.Values{
		"client_id":     {clientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {rt},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoints.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, auth.InternalError("gitea-refresh", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient().Do(req)
	if err != nil {
		return nil, auth.NetworkError("gitea-refresh", err)
	}
	defer resp.Body.Close()

	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		Scope        string `json:"scope"`
		ExpiresIn    int    `json:"expires_in"`
		Error        string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, auth.InternalError("gitea-refresh", err)
	}

	// invalid_grant / bad_refresh_token：refresh_token 已失效，用户需重新走 OAuth
	if raw.Error == "invalid_grant" || raw.Error == "bad_refresh_token" {
		return nil, auth.ExpiredError("gitea-refresh", fmt.Errorf("refresh_token invalid: %s", raw.Error))
	}
	if raw.Error != "" {
		return nil, auth.InternalError("gitea-refresh", fmt.Errorf("unknown error: %s", raw.Error))
	}

	return &auth.TokenBundle{
		AccessToken:  raw.AccessToken,
		RefreshToken: raw.RefreshToken,
		ExpiresIn:    raw.ExpiresIn,
		Scope:        raw.Scope,
	}, nil
}

// Resolve 把存储里的 Credential 转成 git 可用的 username/password
//
// 处理逻辑：
//  1. Status="expired" → 返 (nil, nil)，跳过当前 helper，让 git 走下一个 helper（GCM 兜底）
//  2. ExpiresAt 距 now > 5 分钟（或零值=永不过期） → 直接返 decrypt(Secret)
//  3. 即将过期 + endpoints 未注入 → 返 (nil, nil) 安全 fallback
//     不返回旧 token 让 git 试——即将过期的 token 极可能已失效，返回会触发 git
//     401 + 认证失败弹窗；返回 nil 让 git 走下一个 helper（manager / GCM）兜底
//
// 注意：自建 Gitea 实例 TokenURL 不固定，endpoints 应由 HTTPSResolver 在调本方法前
// 通过 SetStore + 额外 endpoints 注入；当前 resolver 尚未实现 endpoints 注入路径，
// 因此本 provider 无法独立 refresh——返回 nil 是当前阶段的安全降级
func (p *GiteaDeviceProvider) Resolve(ctx context.Context, cred *store.Credential) (*auth.ResolvedCredential, error) {
	if cred.Status == store.StatusExpired {
		return nil, nil
	}

	// 未到期（距 now > 5 分钟或零值=永不过期）→ 直接返回当前 token
	if cred.ExpiresAt.IsZero() || time.Until(cred.ExpiresAt) > 5*time.Minute {
		plain, err := config.DecryptToken(cred.Secret)
		if err != nil {
			return nil, auth.InternalError("gitea-resolve", err)
		}
		return &auth.ResolvedCredential{
			Username: cred.Username,
			Password: plain,
		}, nil
	}

	// token 即将过期 + 当前 provider 无 endpoints 注入能力（自建 Gitea URL 不固定）
	// 安全 fallback：返回 nil 让 git 走下一个 helper（credential manager / GCM）
	// 旧实现的「直接返回即将过期 token」会让 git 拿着可能失效的 token 撞 401，
	// 比返回 nil 更糟
	return nil, nil
}

// httpClient 返回 provider 配置的 client 或默认 client
func (p *GiteaDeviceProvider) httpClient() *http.Client {
	if p.HTTP != nil {
		return p.HTTP
	}
	return oauthHTTPClient
}

// 编译期断言：确保 GiteaDeviceProvider 实现 OAuthDeviceFlowProvider 接口
var _ auth.OAuthDeviceFlowProvider = (*GiteaDeviceProvider)(nil)
