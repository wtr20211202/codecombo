package terminal

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// OSC 133 命令窗环形（P-20261005-170）单测：C 开窗 / D 闭窗 / E 记命令文本
// （bash C→E 与 powershell E→C 两帧序都成立）、环裁剪、降级形态（D 丢失的
// 陈旧 Open 窗兜底闭合 / 无 C 的 D 丢弃）。探测器纯内存裸构造，不起真实 PTY
//（本包惯例）；窗口时刻取 time.Now，断言只看相对关系不锁具体值

// feedWindow 喂一条完整命令（C→E→D）并返回该窗（末窗）
func feedWindow(d *oscStateDetector, cmdB64 string, exit string) CmdWindow {
	frames := "\x1b]133;C\x07"
	if cmdB64 != "" {
		frames += "\x1b]133;E;" + cmdB64 + "\x07"
	}
	frames += "\x1b]133;D;" + exit + ";5\x07"
	d.feed([]byte(frames))
	ws := d.commandWindows()
	return ws[len(ws)-1]
}

// TestCmdWindowClosesWithCommandAndExit bash 帧序（C→E→D）：窗闭合携带命令
// 文本与退出码，Start/End 时序成立
func TestCmdWindowClosesWithCommandAndExit(t *testing.T) {
	d := newOscStateDetector()
	before := time.Now().Add(-time.Second)
	w := feedWindow(d, "ZWNobyBoZWxsbw==", "3") // base64("echo hello"), exit 3
	if w.Open {
		t.Fatalf("window must be closed after D frame")
	}
	if w.Command != "echo hello" {
		t.Fatalf("window command want %q, got %q", "echo hello", w.Command)
	}
	if w.ExitCode != 3 {
		t.Fatalf("window exit want 3, got %d", w.ExitCode)
	}
	if w.Start.Before(before) || w.End.Before(w.Start) {
		t.Fatalf("window times inconsistent: start=%v end=%v (before=%v)", w.Start, w.End, before)
	}
}

// TestCmdWindowEBeforeC powershell 帧序（E→C）：先到的命令文本随下一个 C 随窗
// 落账——两 shell 集成帧序相反，绑定必须两序都成立
func TestCmdWindowEBeforeC(t *testing.T) {
	d := newOscStateDetector()
	// E 先到（无开窗）：暂存
	d.feed([]byte("\x1b]133;E;" + "cHctcHJpbnQ=" + "\x07")) // base64("pw-print")
	if ws := d.commandWindows(); len(ws) != 0 {
		t.Fatalf("E before C must not open a window, got %d", len(ws))
	}
	w := feedWindow(d, "", "0")
	if w.Command != "pw-print" {
		t.Fatalf("pending command must land on next window, want %q got %q", "pw-print", w.Command)
	}
	// 暂存消费后不得泄漏到再下一窗
	w2 := feedWindow(d, "bmV4dA==", "0") // base64("next")
	if w2.Command != "next" {
		t.Fatalf("stale pending must not leak, want %q got %q", "next", w2.Command)
	}
}

// TestCmdWindowOpenUntilD Open 窗语义：C 已见 D 未至 = 无上界区间（命令仍在跑）
func TestCmdWindowOpenUntilD(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte(testFrameC))
	ws := d.commandWindows()
	if len(ws) != 1 || !ws[0].Open || !ws[0].End.IsZero() {
		t.Fatalf("after C want one open window with zero End, got %+v", ws)
	}
	d.feed([]byte(testFrameD))
	ws = d.commandWindows()
	if len(ws) != 1 || ws[0].Open || ws[0].End.IsZero() {
		t.Fatalf("after D want one closed window with End set, got %+v", ws)
	}
}

// TestCmdWindowStaleOpenClosedByNextC D 丢失的降级形态：下一 C 到点时把陈旧
// Open 窗按当下时刻兜底闭合（环形不变式：至多一个 Open 窗）
func TestCmdWindowStaleOpenClosedByNextC(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte(testFrameC)) // 开窗后 D 永不到
	d.feed([]byte(testFrameC)) // 第二条命令
	ws := d.commandWindows()
	if len(ws) != 2 {
		t.Fatalf("want 2 windows, got %d", len(ws))
	}
	if ws[0].Open {
		t.Fatalf("stale open window must be closed by next C")
	}
	if !ws[1].Open {
		t.Fatalf("latest window must stay open")
	}
	if ws[0].End.IsZero() {
		t.Fatalf("stale window End must be stamped at next C, got zero")
	}
}

// TestCmdWindowDWithoutCIgnored 启动期 D（前面是 A 不是 C）：无可闭合窗，丢弃
// （与 cmdActive 同一归属闸，不虚开窗）
func TestCmdWindowDWithoutCIgnored(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte("\x1b]133;A\x07" + testFrameD))
	if ws := d.commandWindows(); len(ws) != 0 {
		t.Fatalf("D without C must not create a window, got %+v", ws)
	}
}

// TestCmdWindowRingTrim 环形裁剪：超上限丢最旧（归因只看「刚刚」）
func TestCmdWindowRingTrim(t *testing.T) {
	d := newOscStateDetector()
	for i := 0; i < cmdWindowCap+3; i++ {
		feedWindow(d, "", "0")
	}
	ws := d.commandWindows()
	if len(ws) != cmdWindowCap {
		t.Fatalf("ring must trim to %d, got %d", cmdWindowCap, len(ws))
	}
}

// TestCmdWindowTextTruncated 超长命令文本截断（窗内只留摘要，完整文本归命令
// 历史链）
func TestCmdWindowTextTruncated(t *testing.T) {
	d := newOscStateDetector()
	long := strings.Repeat("x", cmdTextKeep+100)
	frames := "\x1b]133;C\x07\x1b]133;E;" + base64.StdEncoding.EncodeToString([]byte(long)) + "\x07" + testFrameD
	d.feed([]byte(frames))
	w := d.commandWindows()[len(d.commandWindows())-1]
	if len(w.Command) != cmdTextKeep {
		t.Fatalf("command text must be truncated to %d bytes, got %d", cmdTextKeep, len(w.Command))
	}
}

// TestSessionCommandWindowsNilSafe 裸构造会话（无探测器）访问不炸，返回 nil
func TestSessionCommandWindowsNilSafe(t *testing.T) {
	s := &Session{}
	if ws := s.CommandWindows(); ws != nil {
		t.Fatalf("nil detector must return nil windows, got %+v", ws)
	}
}

// TestCmdWindowCopySemantics 快照是副本：调用方改写不回灌环形窗
func TestCmdWindowCopySemantics(t *testing.T) {
	d := newOscStateDetector()
	feedWindow(d, "", "0")
	ws := d.commandWindows()
	ws[0].Command = "tampered"
	if got := d.commandWindows()[0].Command; got == "tampered" {
		t.Fatalf("snapshot must be a copy, mutation leaked back into ring")
	}
}
