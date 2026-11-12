//go:build !windows

package update

import (
	"errors"
	"syscall"
)

// 非 Windows 平台的分支实现（与 restart_windows.go 构建标签成对，两分支都
// 必须可编译——门禁含 GOOS=darwin/linux 交叉编译）。

// scStartService / stopWindowsService 非 Windows 无 SCM。生产路径不可达：
// 主进程侧 servicectx.IsService 非 Windows 恒否，env 提示不会是
// windows-service（子进程自查 systemd 亦优先于 env 提示）——保留防御分支，
// env 被外部篡改时按启动失败走既有回滚链如实留痕
func scStartService() error {
	return errors.New("windows-service supervise form is windows-only")
}

func stopWindowsService() error {
	return errors.New("windows-service supervise form is windows-only")
}

// daemonProcAttr bare/前台形态 spawn 的进程属性：与 main 包 setDaemonAttrs
// （daemon_unix.go）同款——子进程落独立进程组（Setpgid），脱离启动它的终端
// 会话（前台形态关窗后不在终端前景进程组，不随 SIGHUP 退出）
func daemonProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		Setpgid: true,
	}
}
