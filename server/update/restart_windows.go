//go:build windows

package update

import (
	"os/exec"
	"syscall"
)

// Windows 服务分支的平台实现（P-20261112-1-S2）。sc.exe 是 Windows 专属命令，
// 按「全平台兼容规范」收进构建标签分支（非 Windows 侧见 restart_other.go，
// 两分支都可编译）。服务名常量 windowsServiceName 定义在 restart.go（平台
// 无关——路由失败留痕引用它）

// scStartService 换包完成后交还 SCM：binPath 钉着与换包目标同一路径，磁盘上
// 已是新二进制，start 即以新版本拉起（restartService windows-service 分支）
func scStartService() error {
	return exec.Command("sc.exe", "start", windowsServiceName).Run()
}

// stopWindowsService 回滚前优雅停服务（SCM 对话）：经 svc.Handler 优雅退出，
// 退出码 0 不触发 failure-recovery（硬杀进程非零退出会与回滚 sc start 赛跑）
func stopWindowsService() error {
	return exec.Command("sc.exe", "stop", windowsServiceName).Run()
}

// daemonProcAttr bare/前台形态 spawn 的进程属性：与 main 包 setDaemonAttrs
// （daemon_windows.go）同款——CREATE_NO_WINDOW 让守护进程获得独立隐藏控制台，
// 脱离启动它的终端窗口生命周期（仅 CREATE_NEW_PROCESS_GROUP 时守护进程仍挂接
// 父控制台，关窗即收到 CTRL_CLOSE_EVENT）；不用 DETACHED_PROCESS（完全无控制台
// 的进程派生控制台子进程时每个子进程各弹一个新窗口）
func daemonProcAttr() *syscall.SysProcAttr {
	// 0x08000000 = CREATE_NO_WINDOW（syscall 包未定义该常量，main 包
	// daemon_windows.go 同款字面量口径）
	return &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | 0x08000000,
	}
}
