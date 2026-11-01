//go:build windows

package main

import (
	"os"
	"os/signal"
	"syscall"
)

func isProcessAlive(pid int) bool {
	// 历史"简单处理"直接假设存活：os.FindProcess 在 Windows 对任意 PID 都
	// 成功且 Signal(0) 不可用 → gracefulStop 的退出确认恒假，restart 在
	// "已停/未起"之间随机中止。正确做法：OpenProcess(SYNCHRONIZE) +
	// WaitForSingleObject(0)——进程已退出则句柄触发（signaled）
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
		// 句柄有效但等待失败：保守判定存活（避免对正在退出的服务误判）
		return true
	}
	// WAIT_OBJECT_0（已触发）= 进程已退出；WAIT_TIMEOUT = 仍在运行
	return event == syscall.WAIT_TIMEOUT
}

func setupSignalNotify() <-chan os.Signal {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	return ch
}
