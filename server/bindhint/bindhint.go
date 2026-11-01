// Package bindhint 端口绑定失败的可行动提示：把 Windows 的两类高频
// bind 错误（WSAEACCES ≈ 保留端口段/独占占用、WSAEADDRINUSE ≈ 被占用）
// 翻译成下一动作。非 Windows 平台一律返回空串（保持原错误不动）
package bindhint

// For 返回针对该绑定错误的可行动提示（空串 = 无补充提示）
func For(err error, port int) string { return forPlatform(err, port) }
