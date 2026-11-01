package providers

import (
	"context"
	"encoding/json"
	"errors"
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

// GitHubDeviceProvider 处理 GitHub 的 OAuth Device Flow（RFC 8628）
// 端点：device/code、access_token、refresh（同 access_token 端点）
// username 约定 "x-access-token"——GitHub 的 HTTPS Basic Auth 用 PAT/OAuth token 时 username 字段固定值
type GitHubDeviceProvider struct {
	HTTP          *http.Client // nil 时 fallback oauthHTTPClient（registry.go，带 30s 超时）
	DeviceCodeURL string       // 默认 https://github.com/login/device/code
	TokenURL      string       // 默认 https://github.com/login/oauth/access_token

	// Store 可选：由 HTTPSResolver.Resolve 在调用 Resolve 前通过 SetStore 注入
	// 当 Resolve 内部触发 refresh 成功后，会调用 Store.Save 持久化新 token，
	// 避免每次 git op 重复 refresh 耗尽 refresh_token
	Store store.CredentialStore
}

// SetStore 由 caller（HTTPSResolver）通过 type assertion 注入 cred 仓储
// 作用：让 provider.Resolve 在 refresh 成功后能持久化 cred
// 详见 server/git/auth/https_resolver.go findProvider
func (p *GitHubDeviceProvider) SetStore(s store.CredentialStore) {
	p.Store = s
}

// Type 返回 AuthType，供 registry 注册时分类
func (p *GitHubDeviceProvider) Type() string { return store.AuthTypeOAuthDevice }

// TokenUsername 返回 GitHub PAT/OAuth token 的 username 约定
// cred 参数保留以满足 TokenUsernameProvider 接口签名，GitHub 不依赖 cred 内容
func (p *GitHubDeviceProvider) TokenUsername(_ *store.Credential) string {
	return "x-access-token"
}

// StartDeviceFlow 向 GitHub 请求 device_code + user_code
// 成功响应：{device_code, user_code, verification_uri, expires_in, interval}
func (p *GitHubDeviceProvider) StartDeviceFlow(ctx context.Context, clientID string, endpoints *auth.OAuthEndpoints, scopes []string) (*auth.DeviceFlow, error) {
	u := ""
	if endpoints != nil {
		u = endpoints.DeviceCodeURL
	}
	if u == "" {
		u = p.DeviceCodeURL
	}
	if u == "" {
		u = "https://github.com/login/device/code"
	}

	form := url.Values{
		"client_id": {clientID},
		"scope":     {strings.Join(scopes, " ")},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, auth.InternalError("device-start", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient().Do(req)
	if err != nil {
		return nil, auth.NetworkError("device-start", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return nil, auth.NetworkError("device-start", fmt.Errorf("status %d: %s", resp.StatusCode, string(body)))
	}

	var raw struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, auth.InternalError("device-start", err)
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
// GitHub 用 JSON body 返回 error 字段（不是 HTTP 状态码），所以即使 400 也要解析 body
// 错误分类见 OAuthDeviceFlowProvider.PollDeviceFlow 注释
func (p *GitHubDeviceProvider) PollDeviceFlow(ctx context.Context, clientID, deviceCode string, endpoints *auth.OAuthEndpoints) (*auth.TokenBundle, error) {
	u := ""
	if endpoints != nil {
		u = endpoints.TokenURL
	}
	if u == "" {
		u = p.TokenURL
	}
	if u == "" {
		u = "https://github.com/login/oauth/access_token"
	}

	form := url.Values{
		"client_id":   {clientID},
		"device_code": {deviceCode},
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, auth.InternalError("device-poll", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient().Do(req)
	if err != nil {
		return nil, auth.NetworkError("device-poll", err)
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
		return nil, auth.InternalError("device-poll", err)
	}

	if raw.Error != "" {
		return nil, classifyPollError(raw.Error)
	}

	if raw.AccessToken == "" {
		return nil, auth.InternalError("device-poll", fmt.Errorf("empty access_token"))
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
func (p *GitHubDeviceProvider) RefreshToken(ctx context.Context, cred *store.Credential, clientID string, endpoints *auth.OAuthEndpoints) (*auth.TokenBundle, error) {
	u := ""
	if endpoints != nil {
		u = endpoints.TokenURL
	}
	if u == "" {
		u = p.TokenURL
	}
	if u == "" {
		u = "https://github.com/login/oauth/access_token"
	}

	rt, err := config.DecryptToken(cred.RefreshToken)
	if err != nil {
		return nil, auth.InternalError("refresh", err)
	}

	form := url.Values{
		"client_id":     {clientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {rt},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, auth.InternalError("refresh", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient().Do(req)
	if err != nil {
		return nil, auth.NetworkError("refresh", err)
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
		return nil, auth.InternalError("refresh", err)
	}

	// invalid_grant / bad_refresh_token：refresh_token 已失效，用户需重新走 OAuth
	if raw.Error == "invalid_grant" || raw.Error == "bad_refresh_token" {
		return nil, auth.ExpiredError("refresh", fmt.Errorf("refresh_token invalid: %s", raw.Error))
	}
	if raw.Error != "" {
		return nil, auth.InternalError("refresh", fmt.Errorf("unknown error: %s", raw.Error))
	}

	return &auth.TokenBundle{
		AccessToken:  raw.AccessToken,
		RefreshToken: raw.RefreshToken,
		ExpiresIn:    raw.ExpiresIn,
		Scope:        raw.Scope,
	}, nil
}

// Resolve 把存储里的 Credential 转成 git 可用的 username/password
// 处理逻辑：
//  1. Status="expired" → 返 (nil, nil)，跳过当前 helper
//  2. ExpiresAt 距 now > 5 分钟（或零值） → 直接返 decrypt(Secret)
//  3. 否则触发 RefreshToken；失败按 Kind 分类处理
//
// 注意：Resolve 接口签名不传 endpoints/clientID，所以本实现：
//   - OAuthClientID 为空 → 直接返回当前 token（让 git 试，失败由 resolver 标 expired）
//   - 否则用 provider 字段 TokenURL（生产中由 HTTPSResolver 在调 Resolve 前注入正确 endpoints，见 Plan 2 Task 1）
func (p *GitHubDeviceProvider) Resolve(ctx context.Context, cred *store.Credential) (*auth.ResolvedCredential, error) {
	if cred.Status == store.StatusExpired {
		return nil, nil
	}

	// 未到期（距 now > 5 分钟或零值=永不过期）→ 直接返回当前 token
	if cred.ExpiresAt.IsZero() || time.Until(cred.ExpiresAt) > 5*time.Minute {
		plain, err := config.DecryptToken(cred.Secret)
		if err != nil {
			return nil, auth.InternalError("resolve-oauth", err)
		}
		return &auth.ResolvedCredential{
			Username: cred.Username,
			Password: plain,
		}, nil
	}

	// token 即将过期：尝试 refresh
	// OAuthClientID 缺失 → 无法 refresh，fallback 返当前 token（让 git 试，失败由 resolver 标 expired）
	if cred.OAuthClientID == "" {
		plain, _ := config.DecryptToken(cred.Secret)
		return &auth.ResolvedCredential{
			Username: cred.Username,
			Password: plain,
		}, nil
	}

	// 用 GitHub 默认 endpoints（生产中应由 resolver 注入自定义）
	endpoints := &auth.OAuthEndpoints{
		TokenURL: p.TokenURL,
	}

	tb, err := p.RefreshToken(ctx, cred, cred.OAuthClientID, endpoints)
	if err != nil {
		var ae *auth.AuthError
		if errors.As(err, &ae) {
			if ae.Kind == auth.KindAuthExpired {
				// refresh_token 失效：返回 err 让 resolver 把 cred 标 expired
				return nil, err
			}
			// KindNetwork / KindInternal：返 nil 让 GCM 兜底
			return nil, nil
		}
		return nil, nil
	}

	// refresh 成功：更新 in-memory cred 并持久化
	// 持久化是 spec 强制要求——避免每次 git op 重复 refresh（可能耗尽 refresh_token）
	// Store 由 HTTPSResolver 在调本方法前通过 SetStore 注入；未注入时仅更新内存（开发/测试场景）
	newSecret, err := config.EncryptToken(tb.AccessToken)
	if err != nil {
		return nil, auth.InternalError("resolve-oauth", err)
	}
	newRT := cred.RefreshToken
	if tb.RefreshToken != "" {
		encRT, err := config.EncryptToken(tb.RefreshToken)
		if err != nil {
			return nil, auth.InternalError("resolve-oauth", err)
		}
		newRT = encRT
	}
	cred.Secret = newSecret
	cred.RefreshToken = newRT
	if tb.ExpiresIn > 0 {
		cred.ExpiresAt = time.Now().Add(time.Duration(tb.ExpiresIn) * time.Second)
	}
	cred.Status = store.StatusActive
	cred.LastError = ""
	cred.UpdatedAt = time.Now()

	if p.Store != nil {
		if err := p.Store.Save(cred); err != nil {
			// 持久化失败不阻塞当前 resolve：本次仍返回新 token 让 git 完成，
			// 下次 git op 会再次触发 refresh（重复一次的代价 < 让用户立刻失败）
			// 不引入 log/slog 保持 providers 包依赖最小；上层 handleResolveError
			// 已对 Resolve 返回的错误做日志兜底，持久化错误的可见性可接受丢弃
			_ = err
		}
	}

	return &auth.ResolvedCredential{
		Username: cred.Username,
		Password: tb.AccessToken,
	}, nil
}

// httpClient 返回 provider 配置的 client 或默认 client
func (p *GitHubDeviceProvider) httpClient() *http.Client {
	if p.HTTP != nil {
		return p.HTTP
	}
	return oauthHTTPClient
}
