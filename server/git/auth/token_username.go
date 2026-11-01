package auth

import "codecombo/server/store"

// TokenUsernameProvider 用 PAT/OAuth token 走 Basic Auth 时决定 username 字段
// 由 Provider 实现而非 PlatformAdapter——同一平台不同 flow 可能 username 不同
// （例：GitHub PAT 用 "x-access-token"，Gitea OAuth 用 "oauth2"，但 BasicAuth 直接用用户填的）
type TokenUsernameProvider interface {
	// TokenUsername 返回该 provider 对应的 username 约定
	// 调用方在写入 git credential protocol 的 username 字段前先问一次
	TokenUsername(cred *store.Credential) string
}
