//go:build windows

package tools

import "syscall"

// CREATE_NO_WINDOW：SC 以无控制台方式运行（服务/计划任务）时，cmd /C 包装
// 不再闪出黑色控制台窗口；子进程仍随父进程环境独立存活（Windows 子进程
// 本就不随父进程退出而死，无 Unix SIGHUP 等价物）
const dshCreateNoWindow = 0x08000000

// dshSysProcAttr 一键启动子进程的窗口属性：隐藏包装控制台
func dshSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: dshCreateNoWindow}
}
