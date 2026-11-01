package terminal

import (
	"bytes"
	"testing"
)

// ANSI 剥离单一定义点（ansi.go）单测：appendStripped 滑窗 helper 与 StripANSI
// 的语义恒等 / scratch 复用不外漏陈旧内容 / 组合 alternation（CSI|OSC 单遍扫描）
// 边界——OSC ST 形态 / 两类序列交错相邻 / 未终止残片容忍（滑窗边界截断的 OSC
// 尾巴与 CSI 残片同款容忍，残片文本参与匹配属既有语义）。StripANSI 本体的
// CSI/OSC 用例见 search_test.go 同文件段

func TestAppendStrippedMatchesStripANSI(t *testing.T) {
	cases := []string{
		"",
		"plain text no escape",
		"\x1b[31mERROR\x1b[0m: build failed",
		"\x1b]0;user@host: ~/app\x07body text",
		"\x1b]8;;http://x\x1b\\click\x1b]8;;\x1b\\here",
		"\x1b]133;E;echo hi\x07echo hi done\n",
		// CSI 与 OSC 交错相邻：单遍 FindAllIndex 须两类全剥
		"\x1b[31m\x1b]0;title\x07\x1b[0m payload \x1b[?25l",
		// OSC 终止后紧跟 CSI（终止符边界不吞不漏）
		"\x1b]0;t\x07\x1b[2J\x1b[H rest",
		// 未终止 OSC 残片（流尾截断）：两种形态同款容忍
		"\x1b]0;truncated title",
		"\x1b]8;;http://x\x1b\\link text",
	}
	for _, in := range cases {
		viaStrip := string(StripANSI([]byte(in)))
		viaHelper := string(appendStripped(nil, []byte(in)))
		if viaStrip != viaHelper {
			t.Fatalf("两形态语义漂移 in=%q: StripANSI=%q appendStripped=%q", in, viaStrip, viaHelper)
		}
	}
}

func TestAppendStrippedScratchReuse(t *testing.T) {
	// 上一轮的陈旧内容不得外漏到本轮结果（dst 先复位再拼接）
	scratch := []byte("STALE-OLD-CONTENT-MUCH-LONGER-THAN-NEW")
	scratch = appendStripped(scratch, []byte("\x1b[31mred\x1b[0m"))
	if got := string(scratch); got != "red" {
		t.Fatalf("scratch 复用残留陈旧内容: %q", got)
	}

	// 无 ESC 窗口（纯文本常态）：原样追加且走零正则快路径
	scratch = appendStripped(scratch, []byte("plain\n"))
	if got := string(scratch); got != "plain\n" {
		t.Fatalf("纯文本窗口应原样通过: %q", got)
	}
}

func TestAppendStripped_UnterminatedOSCFragment(t *testing.T) {
	// 组合正则边界：滑窗边界/流尾截断的 OSC 尾巴按 CSI 残片同款容忍——
	// 未终止序列剥不掉，残片文本留在匹配面（语义注记见 ansi.go，不 panic
	// 不吞正文即达标）
	scratch := appendStripped(nil, []byte("ok \x1b]0;OOM detec"))
	if got := string(scratch); got != "ok \x1b]0;OOM detec" {
		t.Fatalf("未终止 OSC 残片应原样保留: %q", got)
	}

	// 跨 feed 拼接：残片补全终止符后，滑窗整体重剥即把完整序列剥净
	//（真实滑窗语义：window 逐 feed 累积，重扫恒对全窗进行）
	window := []byte("ok \x1b]0;OOM detec")
	window = append(window, ("ted\x07real body")...)
	scratch = appendStripped(scratch, window)
	if got := string(scratch); got != "ok real body" {
		t.Fatalf("补全后完整 OSC 应剥净: %q", got)
	}
}

func TestAppendStripped_HeadTruncatedOSC(t *testing.T) {
	// 滑窗保尾裁剪把序列头（ESC]）裁掉的形态：无前缀不剥，残片同款容忍
	//（与 CSI 被裁掉 ESC 后残留字节一致，滑窗裁剪本就不保证序列完整性）
	scratch := appendStripped(nil, []byte("0;user@host\x07 tail"))
	if got := string(scratch); got != "0;user@host\x07 tail" {
		t.Fatalf("头部被裁的 OSC 残片应原样保留: %q", got)
	}
	if bytes.Contains(appendStripped(nil, []byte("a\x1b[31mb\x1b]0;t\x07c")), []byte("\x1b")) {
		t.Fatal("完整 CSI/OSC 混合序列应剥至不含任何 ESC")
	}
}
