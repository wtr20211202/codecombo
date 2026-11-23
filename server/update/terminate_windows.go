//go:build windows

package update

import "errors"

// signalTerm Windows 无 SIGTERM 可跨进程投递（跨进程 GenerateConsoleCtrlEvent
// 需共享控制台），故本函数不提供优雅停语义。生产路径不可达：launchd 形态只在
// darwin 成立（主进程 currentSuperviseForm 的 ppid==1 探测 + 子进程 env 提示），
// 保留可编译桩使 terminateStaleLaunchdInstance 在 Windows 上仍能编译
// （「全平台兼容规范」两分支都必须可编译）；env 被外部篡改为 launchd 时按
// 终结失败走既有回滚链如实留痕
func signalTerm(pid int) error {
	return errors.New("SIGTERM signaling is unavailable on Windows (launchd supervise form is darwin-only)")
}
