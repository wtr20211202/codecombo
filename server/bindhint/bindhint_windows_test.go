package bindhint

import (
	"fmt"
	"strings"
	"syscall"
	"testing"
)

func TestForWindowsErrno(t *testing.T) {
	// 独占占用（Go 监听套接字语义）→ WSAEACCES，提示里要有定位命令
	h := For(fmt.Errorf("listen tcp 127.0.0.1:10001: bind: %w", syscall.Errno(10013)), 10001)
	if h == "" {
		t.Fatal("WSAEACCES should produce a hint")
	}
	for _, want := range []string{"10001", "netstat", "netsh"} {
		if !strings.Contains(h, want) {
			t.Errorf("hint missing %q: %s", want, h)
		}
	}

	// 普通占用 → WSAEADDRINUSE，提示里要有定位命令与处置
	h = For(fmt.Errorf("bind: %w", syscall.Errno(10048)), 10000)
	if h == "" || !strings.Contains(h, "10000") || !strings.Contains(h, "netstat") {
		t.Errorf("WSAEADDRINUSE hint unexpected: %s", h)
	}

	// 非 errno 错误：不加提示
	if got := For(fmt.Errorf("no route to host"), 9999); got != "" {
		t.Errorf("non-errno error should have no hint, got %s", got)
	}
}
