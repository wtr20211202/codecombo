//go:build !windows

package main

// 非 Windows 平台的服务上下文探测恒否——服务协议是 Windows SCM 专属概念
//（Linux systemd / macOS launchd 由 install.sh 写 unit/plist 直接托管进程，
// 不需要进程内对话协议）
func isWindowsService() bool { return false }

// runWindowsService 非 Windows 平台无调用路径（isWindowsService 恒否使分支
// 短路），仅为跨平台编译补符号——绝不可被实际调用
func runWindowsService(func()) error {
	panic("runWindowsService called on non-Windows platform")
}
