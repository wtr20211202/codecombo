//go:build windows

package update

import (
	"syscall"
	"testing"
)

// assertDaemonProcAttr Windows 侧 detach 断言：CREATE_NEW_PROCESS_GROUP +
// CREATE_NO_WINDOW（独立隐藏控制台脱离终端窗口生命周期——daemonProcAttr
// 注释同款语义，与 main 包 setDaemonAttrs 对齐）
func assertDaemonProcAttr(t *testing.T, sys *syscall.SysProcAttr) {
	t.Helper()
	if sys == nil {
		t.Fatal("spawn ProcAttr.Sys is nil — terminal detach semantics lost")
	}
	const createNoWindow = 0x08000000
	if sys.CreationFlags&(syscall.CREATE_NEW_PROCESS_GROUP|createNoWindow) != syscall.CREATE_NEW_PROCESS_GROUP|createNoWindow {
		t.Fatalf("CreationFlags = %#x, want CREATE_NEW_PROCESS_GROUP|CREATE_NO_WINDOW", sys.CreationFlags)
	}
}
