package auth

import (
	"context"

	"codecombo/server/store"
)

// ResolvedCredential 是 helper 给 git 输出的最终凭据
// Username + Password 组合直接喂给 git 的 credential protocol（username=... / password=...）
type ResolvedCredential struct {
	Username string
	Password string
}

// CredentialProvider 是所有 HTTPS 凭据类型的最小契约
// 实现方按 AuthType 注册到 providers registry，由 resolver 按 cred.AuthType 查表调用
type CredentialProvider interface {
	// Type 返回 AuthType，对应 Credential.AuthType 字段
	// 例如 "basic" / "oauth-device" / "oauth-web"
	Type() string

	// Resolve 把存储里的 Credential 转成 git 可用的 username/password
	// 返回 (nil, nil) 表示「跳过当前 helper」——让 git 走下一个 helper（GCM 兜底）
	// 返回 err 非 nil 时，helper 仍 exit 0（见 §错误处理）
	Resolve(ctx context.Context, cred *store.Credential) (*ResolvedCredential, error)
}
