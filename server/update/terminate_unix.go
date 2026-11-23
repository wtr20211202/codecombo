//go:build !windows

package update

import (
	"os"
	"syscall"
)

// signalTerm 向指定 PID 投递 SIGTERM（P-20261122-6 launchd 换包后旧实例
// 终结的第一步：优雅关停走 app.go 的 signal handler——5s 排空 + serve 收尾
// 删 PID 文件，给 waitForHealthy 干净起点）。
// 非 Windows 覆盖 linux/darwin：launchd 形态实际只可能出现在 darwin，linux
// 编译同源（两分支都必须可编译——「全平台兼容规范」）。
// 与 killByPID（proc.Kill = SIGKILL）刻意分离：回滚链的硬杀语义不许软化
func signalTerm(pid int) error {
	if pid <= 0 {
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(syscall.SIGTERM)
}
