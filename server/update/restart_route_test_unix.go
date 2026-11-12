//go:build !windows

package update

import (
	"syscall"
	"testing"
)

// assertDaemonProcAttr unix 侧 detach 断言：Setpgid（独立进程组，脱离终端
// 前景组——daemonProcAttr 注释同款语义，与 main 包 setDaemonAttrs 对齐）
func assertDaemonProcAttr(t *testing.T, sys *syscall.SysProcAttr) {
	t.Helper()
	if sys == nil {
		t.Fatal("spawn ProcAttr.Sys is nil — terminal detach semantics lost")
	}
	if !sys.Setpgid {
		t.Fatal("Setpgid not set — spawn stays in the old terminal session")
	}
}
