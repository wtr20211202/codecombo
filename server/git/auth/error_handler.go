package auth

import (
	"errors"
	"log/slog"

	"codecombo/server/store"
)

// handleResolveError 处理 Provider.Resolve 返回的 AuthError
// 按错误 Kind 决定是否持久化 cred 字段：
//   - KindAuthExpired → 持久化 cred.Status = "expired" + LastError（截断 200 字符）
//   - KindNetwork / KindInternal → 仅记日志（瞬时错误，不改变 cred 状态）
//   - 其他 Kind → 仅记日志
//
// helper 与 HTTPSResolver 共用本函数，避免错误处理逻辑重复
//
// 使用标准库 errors.As 递归 Unwrap 错误链，兼容 fmt.Errorf("%w", ...) 包装
func handleResolveError(err error, cred *store.Credential, repo store.CredentialStore) {
	var ae *AuthError
	if !errors.As(err, &ae) {
		// 非 AuthError 类型：未知错误，仅记日志
		slog.Error("resolve unknown error", "err", err)
		return
	}
	switch ae.Kind {
	case KindAuthExpired:
		cred.Status = store.StatusExpired
		if ae.Err != nil {
			cred.LastError = truncateErr(ae.Err.Error(), 200)
		}
		if err := repo.Save(cred); err != nil {
			slog.Error("persist expired cred failed", "id", cred.ID, "err", err)
		}
	case KindNetwork:
		slog.Warn("resolve transient network error", "op", ae.Op, "err", ae.Err)
	case KindInternal:
		slog.Error("resolve internal error", "op", ae.Op, "err", ae.Err)
	default:
		// KindAuthPending / KindAuthSlowDown / KindAuthDenied / KindConfig：仅记日志，不持久化
		slog.Warn("resolve auth error", "op", ae.Op, "kind", ae.Kind, "err", ae.Err)
	}
}

// truncateErr 截断错误信息到指定长度，末尾加 "..."
// 防止 LastError 字段无限膨胀污染 store
func truncateErr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
