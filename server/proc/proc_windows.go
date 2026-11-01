//go:build windows

package proc

import "syscall"

func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	const SYNCHRONIZE = 0x00100000
	h, err := syscall.OpenProcess(SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer func() { _ = syscall.CloseHandle(h) }()
	event, err := syscall.WaitForSingleObject(h, 0)
	if err != nil {
		// 句柄有效但等待失败：保守判定存活（避免对正在退出的进程误判）
		return true
	}
	// WAIT_OBJECT_0（已触发）= 进程已退出；WAIT_TIMEOUT = 仍在运行
	return event == syscall.WAIT_TIMEOUT
}
