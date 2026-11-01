package auth

import "fmt"

// ErrKind 错误类别，决定 resolver / helper 的处理策略
type ErrKind int

const (
	KindAuthExpired ErrKind = iota // token / refresh / agent socket 失效
	KindAuthPending                // OAuth pending（轮询中）
	KindAuthSlowDown               // OAuth 轮询过快，需增大 interval（RFC 8628 §3.5）
	KindAuthDenied                 // 用户主动拒绝
	KindNetwork                    // 平台不可达 / 超时
	KindConfig                     // client_id 未配 / 错误
	KindInternal                   // 内部错误（store / 解密 / 不变式违反）
)

// String 返回 Kind 的字符串表示，用于日志和 UI 显示
func (k ErrKind) String() string {
	switch k {
	case KindAuthExpired:
		return "expired"
	case KindAuthPending:
		return "pending"
	case KindAuthSlowDown:
		return "slow_down"
	case KindAuthDenied:
		return "denied"
	case KindNetwork:
		return "network"
	case KindConfig:
		return "config"
	case KindInternal:
		return "internal"
	}
	return "unknown"
}

// AuthError 统一的认证错误类型
// 所有 Provider / Resolver / Helper 的错误返回都用 *AuthError 包装
type AuthError struct {
	Kind ErrKind
	Op   string // "resolve" / "refresh" / "ssh-resolve" / "device-poll" 等
	Err  error  // 底层错误（可为 nil，如 pending）
}

func (e *AuthError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Op, e.Kind, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Op, e.Kind)
}

func (e *AuthError) Unwrap() error { return e.Err }

// 构造辅助函数
func ExpiredError(op string, err error) *AuthError {
	return &AuthError{Kind: KindAuthExpired, Op: op, Err: err}
}
func PendingError(op string, err error) *AuthError {
	return &AuthError{Kind: KindAuthPending, Op: op, Err: err}
}
// SlowDownError 表示 OAuth Device Flow 轮询过快（RFC 8628 §3.5 slow_down）
// 调用方应增加 interval 后重试，区别于 PendingError 的「按原 interval 重试」
func SlowDownError(op string, err error) *AuthError {
	return &AuthError{Kind: KindAuthSlowDown, Op: op, Err: err}
}
func DeniedError(op string, err error) *AuthError {
	return &AuthError{Kind: KindAuthDenied, Op: op, Err: err}
}
func NetworkError(op string, err error) *AuthError {
	return &AuthError{Kind: KindNetwork, Op: op, Err: err}
}
func ConfigError(op string, err error) *AuthError {
	return &AuthError{Kind: KindConfig, Op: op, Err: err}
}
func InternalError(op string, err error) *AuthError {
	return &AuthError{Kind: KindInternal, Op: op, Err: err}
}
