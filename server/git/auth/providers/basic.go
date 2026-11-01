package providers

import (
	"context"

	"codecombo/server/config"
	"codecombo/server/git/auth"
	"codecombo/server/store"
)

// BasicAuthProvider 处理 AuthType="basic" 的凭据
// 包括 PAT、密码、App Password 等 username+secret 形态
// 不论 secret 是用户手填的明文 PAT 还是 UI 走完 OAuth 后存的 token，只要走 Basic Auth 都由本 Provider 处理
type BasicAuthProvider struct{}

// Type 返回 AuthType 字段值，供 registry 注册时分类
func (BasicAuthProvider) Type() string { return store.AuthTypeBasic }

// Resolve 返回 cred.Username + decrypt(cred.Secret)
// cred.Secret 可能是 enc: 加密串、明文（兼容旧数据）或空串——DecryptToken 内部统一处理
// 解密失败时包装成 InternalError，让 helper 上层 exit 0 + 日志，不打断用户流程
func (BasicAuthProvider) Resolve(ctx context.Context, cred *store.Credential) (*auth.ResolvedCredential, error) {
	plain, err := config.DecryptToken(cred.Secret)
	if err != nil {
		return nil, auth.InternalError("resolve-basic", err)
	}
	return &auth.ResolvedCredential{
		Username: cred.Username,
		Password: plain,
	}, nil
}

// TokenUsername 直接返回 cred.Username（用户在 UI 显式填的）
// 与 GitHub PAT 的 "x-access-token" / Gitea OAuth 的 "oauth2" 不同——
// basic 凭据的 username 永远是用户填的那个，没有约定俗成的固定值
func (BasicAuthProvider) TokenUsername(cred *store.Credential) string {
	return cred.Username
}
