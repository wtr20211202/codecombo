package terminal

import (
	"runtime"
	"strings"
	"testing"
)

// OSC 7 cwd 实时追踪（P-20261004-59）单测：发射形态（BEL/ST/tmux DCS 包装）、
// 跨 chunk 半帧拼接、百分号解码、Windows 盘符折算、多帧取最近、异常流回落。

func mustCurrent(t *testing.T, c *cwdTracker) string {
	t.Helper()
	dir, known := c.current()
	if !known {
		t.Fatalf("expected cwd known, got unknown")
	}
	return dir
}

// TestCWDBelTerminated 本系统 shellint 发射形态：BEL 终止
func TestCWDBelTerminated(t *testing.T) {
	c := newCWDDetector()
	c.feed([]byte("noise\x1b]7;file://myhost/home/u/sub\x07tail"))
	if got := mustCurrent(t, c); got != "/home/u/sub" {
		t.Fatalf("dir = %q, want /home/u/sub", got)
	}
}

// TestCWDSTTerminated VS Code 等第三方集成惯例：ST（ESC \）终止
func TestCWDSTTerminated(t *testing.T) {
	c := newCWDDetector()
	c.feed([]byte("\x1b]7;file://localhost/home/u/st\x1b\\more"))
	if got := mustCurrent(t, c); got != "/home/u/st" {
		t.Fatalf("dir = %q, want /home/u/st", got)
	}
}

// TestCWDTmuxPassthrough tmux DCS passthrough 包装（bash.sh/zsh.sh 在 $TMUX 内
// 的形态）：内层 OSC 头完整，无需特判即可寻中
func TestCWDTmuxPassthrough(t *testing.T) {
	c := newCWDDetector()
	c.feed([]byte("\x1bPtmux;\x1b\x1b]7;file://h/home/u/tmux\x07\x1b\\"))
	if got := mustCurrent(t, c); got != "/home/u/tmux" {
		t.Fatalf("dir = %q, want /home/u/tmux", got)
	}
}

// TestCWDSplitAcrossChunks 4KB 读块边界切在序列中间：pending 拼接后照常解出
func TestCWDSplitAcrossChunks(t *testing.T) {
	c := newCWDDetector()
	seq := []byte("\x1b]7;file://h/home/u/split\x07")
	c.feed(seq[:5])
	if _, known := c.current(); known {
		t.Fatalf("半帧不应产出 cwd")
	}
	c.feed(seq[5:])
	if got := mustCurrent(t, c); got != "/home/u/split" {
		t.Fatalf("dir = %q, want /home/u/split", got)
	}
}

// TestCWDSplitInsidePath 切点落在路径中段（更常见的边界形态）
func TestCWDSplitInsidePath(t *testing.T) {
	c := newCWDDetector()
	seq := []byte("\x1b]7;file://h/home/u/de%20ep\x07")
	mid := 10
	c.feed(seq[:mid])
	c.feed(seq[mid:])
	if got := mustCurrent(t, c); got != "/home/u/de ep" {
		t.Fatalf("dir = %q, want /home/u/de ep", got)
	}
}

// TestCWDPercentDecode 百分号解码：空格消歧；裸 %（非编码序列）保留原样
func TestCWDPercentDecode(t *testing.T) {
	c := newCWDDetector()
	c.feed([]byte("\x1b]7;file://h/a%20b/100%x\x07"))
	if got := mustCurrent(t, c); got != "/a b/100%x" {
		t.Fatalf("dir = %q, want /a b/100%%x", got)
	}
}

// TestCWDWindowsDriveForm Windows 盘符形态：/C:/... → 原生分隔符（仅 windows
// 运行时折算——服务端与 shell 同机；linux/mac 门禁下保持 POSIX 原样）
func TestCWDWindowsDriveForm(t *testing.T) {
	c := newCWDDetector()
	c.feed([]byte("\x1b]7;file://myhost/C:/Users/u/sub\x07"))
	if runtime.GOOS == "windows" {
		if got := mustCurrent(t, c); got != `C:\Users\u\sub` {
			t.Fatalf("dir = %q, want C:\\Users\\u\\sub", got)
		}
	} else if got := mustCurrent(t, c); got != "/C:/Users/u/sub" {
		t.Fatalf("dir = %q, want /C:/Users/u/sub (POSIX keeps raw)", got)
	}
}

// TestCWDMultipleFramesLastWins 同 chunk 多帧（快速连续 cd）：最近一帧生效
func TestCWDMultipleFramesLastWins(t *testing.T) {
	c := newCWDDetector()
	c.feed([]byte("\x1b]7;file://h/first\x07 mid \x1b]7;file://h/second\x07"))
	if got := mustCurrent(t, c); got != "/second" {
		t.Fatalf("dir = %q, want /second", got)
	}
}

// TestCWDMalformedSkipped 非 file URL 载荷弃帧，不影响后续合法帧
func TestCWDMalformedSkipped(t *testing.T) {
	c := newCWDDetector()
	c.feed([]byte("\x1b]7;not-a-file-url\x07\x1b]7;file://h/ok\x07"))
	if got := mustCurrent(t, c); got != "/ok" {
		t.Fatalf("dir = %q, want /ok", got)
	}
}

// TestCWDUnknownWithoutFrames 无帧（旧 shell）保持 unknown——消费方回落创建 dir
func TestCWDUnknownWithoutFrames(t *testing.T) {
	c := newCWDDetector()
	c.feed([]byte("plain shell output without any osc7"))
	if _, known := c.current(); known {
		t.Fatalf("无帧不应 known")
	}
}

// TestCWDPendingCap 异常流（无终止符超限）弃 pending 自愈，后续合法帧照常
func TestCWDPendingCap(t *testing.T) {
	c := newCWDDetector()
	c.feed([]byte("\x1b]7;file://h/" + strings.Repeat("x", cwdPendingCap))) // 无终止
	c.feed([]byte("\x1b]7;file://h/recovered\x07"))
	if got := mustCurrent(t, c); got != "/recovered" {
		t.Fatalf("dir = %q, want /recovered", got)
	}
}

// TestSessionCurrentDirAccessor Session 访问器：nil tracker（裸构造）安全 unknown
func TestSessionCurrentDirAccessor(t *testing.T) {
	s := &Session{}
	if _, known := s.CurrentDir(); known {
		t.Fatalf("nil tracker 不应 known")
	}
	s.cwd = newCWDDetector()
	s.cwd.feed([]byte("\x1b]7;file://h/via-session\x07"))
	if got, known := s.CurrentDir(); !known || got != "/via-session" {
		t.Fatalf("dir = %q known=%v, want /via-session true", got, known)
	}
}
