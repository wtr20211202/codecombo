//go:build !windows

package update

import (
	"fmt"
	"os"
	"syscall"
	"time"
)

// waitForProcess 等待指定 PID 的进程退出
func waitForProcess(pid int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		proc, err := os.FindProcess(pid)
		if err != nil {
			return nil
		}
		if proc.Signal(syscall.Signal(0)) != nil {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for process %d", pid)
}
