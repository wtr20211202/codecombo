package terminal

import (
	"testing"
)

// TestResolveBackendExplicitNative 显式 native 永远返回 native（与 tmux 是否可用无关）
func TestResolveBackendExplicitNative(t *testing.T) {
	if got := ResolveBackend("native"); got != BackendNative {
		t.Errorf("ResolveBackend(\"native\") = %q, want %q", got, BackendNative)
	}
}

// TestResolveBackendUnknownFallsBack 未知值 fallback 到 native
func TestResolveBackendUnknownFallsBack(t *testing.T) {
	if got := ResolveBackend("unknown-value"); got != BackendNative {
		t.Errorf("ResolveBackend(\"unknown-value\") = %q, want %q", got, BackendNative)
	}
	if got := ResolveBackend(""); got != BackendNative && got != BackendTmux {
		// 空字符串等价于 auto，根据 tmux 是否可用分流
		t.Errorf("ResolveBackend(\"\") = %q, expected native or tmux", got)
	}
}

// TestResolveBackendAutoDependsOnTmux auto 模式取决于 tmux 可用性
func TestResolveBackendAutoDependsOnTmux(t *testing.T) {
	got := ResolveBackend("auto")
	if isTmuxAvailable() {
		if got != BackendTmux {
			t.Errorf("ResolveBackend(\"auto\") = %q, want %q (tmux available)", got, BackendTmux)
		}
	} else {
		if got != BackendNative {
			t.Errorf("ResolveBackend(\"auto\") = %q, want %q (tmux unavailable)", got, BackendNative)
		}
	}
}

// TestResolveBackendTmuxFallback tmux 不可用时强制 tmux 模式应 fallback native
func TestResolveBackendTmuxFallback(t *testing.T) {
	got := ResolveBackend("tmux")
	if isTmuxAvailable() {
		if got != BackendTmux {
			t.Errorf("ResolveBackend(\"tmux\") = %q, want %q", got, BackendTmux)
		}
	} else {
		if got != BackendNative {
			t.Errorf("ResolveBackend(\"tmux\") = %q, want %q (tmux unavailable, should fallback)", got, BackendNative)
		}
	}
}

// TestNewBackendNative native kind 始终返回 nativeBackend
func TestNewBackendNative(t *testing.T) {
	b := NewBackend(BackendNative)
	if _, ok := b.(*nativeBackend); !ok {
		t.Errorf("NewBackend(native) = %T, want *nativeBackend", b)
	}
}

// TestNativeBackendImplementsInterface 编译期验证 nativeBackend 实现 PtyBackend 接口
func TestNativeBackendImplementsInterface(t *testing.T) {
	var _ PtyBackend = (*nativeBackend)(nil)
	var _ PtyBackend = newNativeBackend()
}

// TestNativeBackendNonPersistent native 必须报告 IsPersistent()=false 且 Reattach 返回 error
func TestNativeBackendNonPersistent(t *testing.T) {
	b := newNativeBackend()
	if b.IsPersistent() {
		t.Errorf("nativeBackend.IsPersistent() = true, want false")
	}
	if _, err := b.Reattach(SessionSpec{}); err == nil {
		t.Errorf("nativeBackend.Reattach() returned nil error, want error")
	}
}
