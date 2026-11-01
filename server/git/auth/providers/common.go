package providers

import (
	"fmt"

	"codecombo/server/git/auth"
)

// classifyPollError 把 RFC 8628 Device Flow polling 阶段的 error 字段映射成对应 Kind 的 *AuthError
// GitHub / Gitea / GitLab 等遵循 RFC 8628 的平台共用同一套错误码，因此抽到此处共享
//
// 错误码语义（RFC 8628 §3.5）：
//   - authorization_pending: 用户尚未在浏览器完成授权，UI 应按 interval 继续轮询
//   - slow_down: 轮询过快，UI 应增加 interval 后再试（独立 Kind：KindAuthSlowDown）
//   - expired_token: device_code 已过期，需重新发起 StartDeviceFlow
//   - access_denied: 用户主动拒绝授权
//   - 其他: 内部错误（可能是平台扩展的非标错误码）
//
// 注意：op 当前固定 "device-poll"，未来若需按平台区分调用点上下文，可扩展为 classifyPollError(op, rawError)
func classifyPollError(rawError string) error {
	switch rawError {
	case "authorization_pending":
		return auth.PendingError("device-poll", nil)
	case "slow_down":
		// RFC 8628 §3.5：客户端必须增大 interval 至少 5 秒
		// 与 authorization_pending 区分 Kind，便于 handler 决定 interval 增量
		return auth.SlowDownError("device-poll", nil)
	case "expired_token":
		return auth.ExpiredError("device-poll", fmt.Errorf("device_code expired"))
	case "access_denied":
		return auth.DeniedError("device-poll", fmt.Errorf("access_denied"))
	default:
		return auth.InternalError("device-poll", fmt.Errorf("unknown error: %s", rawError))
	}
}
