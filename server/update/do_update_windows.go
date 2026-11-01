//go:build windows

package update

import (
	"fmt"
	"syscall"
	"time"
)

// waitForProcess 等待指定 PID 的进程退出
func waitForProcess(pid int, timeout time.Duration) error {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	openProcess := kernel32.NewProc("OpenProcess")
	waitForSingleObject := kernel32.NewProc("WaitForSingleObject")
	closeHandle := kernel32.NewProc("CloseHandle")

	// SYNCHRONIZE = 0x100000
	handle, _, _ := openProcess.Call(0x100000, 0, uintptr(pid))
	if handle == 0 {
		// 进程已退出
		return nil
	}
	defer func() { _, _, _ = closeHandle.Call(handle) }()

	ms := uintptr(timeout.Milliseconds())
	ret, _, _ := waitForSingleObject.Call(handle, ms)
	if ret == 0x102 { // WAIT_TIMEOUT
		return fmt.Errorf("timeout waiting for process %d", pid)
	}
	return nil
}
