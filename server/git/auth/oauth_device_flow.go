package auth

import (
	"context"

	"codecombo/server/store"
)

// OAuthEndpoints 描述某平台的 OAuth 端点
// 由 PlatformAdapter 的 OAuthCapable 能力返回，注入给 Device Flow Provider 使用
type OAuthEndpoints struct {
	DeviceCodeURL string // POST → {device_code, user_code, verification_uri, expires_in, interval}
	TokenURL      string // POST → {access_token, refresh_token, expires_in, scope}；也用于 refresh_token grant
	RevokeURL     string // POST/DELETE 撤销 token
}

// DeviceFlow 是 StartDeviceFlow 返回的设备授权会话状态
// UI 拿到后展示 user_code + verification_uri，按 Interval 节奏调 PollDeviceFlow
type DeviceFlow struct {
	DeviceCode      string
	UserCode        string
	VerificationURI string
	ExpiresIn       int // 秒
	Interval        int // 秒，UI 轮询节奏
}

// TokenBundle 是 DeviceFlow 完成或 Refresh 拿到的 token 包
// Resolver 会把 AccessToken 写入 cred.Secret，RefreshToken 写入 cred.RefreshToken
type TokenBundle struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    int
	Scope        string
}

// OAuthDeviceFlowProvider 实现 Device Flow 类 OAuth（RFC 8628）
// Start/Poll 与 Resolve 解耦：Resolve 只读 cred 内 token；Start/Poll 是 OAuth 注册流
// 每个平台（GitHub / Gitea / GitLab）各自实现此接口，端点 / client_id 不同
type OAuthDeviceFlowProvider interface {
	CredentialProvider

	// StartDeviceFlow 向平台请求 device_code + user_code
	// scopes 平台特定，例如 GitHub 用 "repo gist"，Gitea 用 "read:user write:repository"
	StartDeviceFlow(ctx context.Context, clientID string, endpoints *OAuthEndpoints, scopes []string) (*DeviceFlow, error)

	// PollDeviceFlow 轮询平台拿 token
	// 错误分类：
	//   - KindAuthPending（authorization_pending）——UI 等下个 interval 再 poll
	//   - KindAuthSlowDown（slow_down）——UI 增大 interval 后再 poll
	//   - KindAuthExpired（expired_token）——device_code 过期，需重新 StartDeviceFlow
	//   - KindAuthDenied（access_denied）——用户拒绝授权
	//   - KindNetwork——HTTP 失败或非预期状态码
	//   - KindInternal——JSON 解析失败
	PollDeviceFlow(ctx context.Context, clientID, deviceCode string, endpoints *OAuthEndpoints) (*TokenBundle, error)

	// RefreshToken 用 refresh_token 换新 access_token
	// 错误分类：
	//   - KindAuthExpired（invalid_grant / bad_refresh_token）——refresh_token 已失效，需用户重新 OAuth
	//   - KindNetwork——HTTP 失败
	//   - KindInternal——JSON 解析失败
	RefreshToken(ctx context.Context, cred *store.Credential, clientID string, endpoints *OAuthEndpoints) (*TokenBundle, error)
}

// StoreSetter 由需要在内部持久化 cred 的 Provider 实现
// 典型实现者：OAuthDeviceFlowProvider（refresh 成功后 Save 新 token）
//
// 设计动机：避免 auth 包反向 import providers 子包（会循环 import）
// HTTPSResolver.Resolve 通过 type assertion 检测 provider 是否实现本接口，
// 若是则注入自身持有的 Store——provider 即可在 Resolve 内部 refresh 成功后持久化
//
// 见 server/git/auth/https_resolver.go findProvider 调用点
type StoreSetter interface {
	SetStore(s store.CredentialStore)
}
