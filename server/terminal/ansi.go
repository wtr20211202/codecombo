package terminal

import "regexp"

// ANSI 转义序列剥除的单一定义点：CSI 与 OSC 两类序列的正则源串（csiPattern /
// oscPattern）只在本文件定义，编译形态 ansiSeqRe（单一 alternation，一次扫描
// 覆盖两类序列）为全部消费方共用，两种消费形态语义恒等——
//   - StripANSI：「要纯文本」的消费方直接调用（跨会话输出检索 search.go、
//     留档导出 export.go、输出冻结分享、验尸报告等）；
//   - appendStripped：滑窗匹配消费方（输出哨兵 sentinel.go / dev 端口探测
//     portdetect.go / git 活动 gitactivity.go），保留 scratch 跨 feed 复用形态。
//
// 勿在消费方再写内联剥离循环或第二份序列定义；剥离语义改动时所有消费方自动
// 一致（P-20261005-8 收敛，P-290「勿双实现」注记的兑现）。
//
// OSC 自 P-20261005-8 起参与滑窗剥离（此前滑窗只剥 CSI）：shell 常设终端标题
//（\x1b]0;user@host:cwd\x07）与 shell integration 133 标记原样留在滑窗，会让
// 标题/标记内容参与哨兵规则与端口模式匹配（标题携带的 cwd/命令段与输出正文
// 语义不同，规则词命中即误报）——本条起 OSC 内容不参与滑窗匹配，与 StripANSI
// 的纯文本口径对齐（控制面不属于输出文本）；「标题携带关键信息」的个别场景
// 由正文覆盖。
//
// DCS 等其余转义形态在滚动缓冲文本里罕见，残留不影响匹配/检索的正确性
//（只影响文本观感），按 YAGNI 不穷举。

// csiPattern ANSI CSI 序列（SGR 颜色/光标控制）。会话强制 TERM=xterm-256color +
// COLORTERM=truecolor，启动横幅必然着色：SGR 码会割裂 "Local:" 与 URL、
// 甚至吃掉单词边界（"\x1b[36mLocal" 里 m 与 L 之间无 \b）——匹配前先剥除
const csiPattern = `\x1b\[[0-9;?]*[ -/]*[@-~]`

// oscPattern OSC 序列：\x1b] ... BEL(\x07) 或 ST(\x1b\\) 结尾。
// 负字符类不含 \x1b：超链接形态 \x1b]8;;url\x1b\\text\x1b]8;;\x1b\\ 的
// ST 终止符以 ESC 开头，靠它停住避免吞掉后续正文
const oscPattern = "\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)"

// ansiSeqRe CSI|OSC 单一 alternation：StripANSI 消费 ReplaceAll、appendStripped
// 消费 FindAllIndex，同一份编译形态。两分支在 ESC 后的次字节（'[' 与 ']'）互斥，
// 且任一分支的匹配都不吞后续 ESC（CSI 终结字节/OSC 内容字符类均不含 ESC）——
// 单遍扫描与旧「先 OSC 后 CSI 两遍 ReplaceAll」结果恒等
var ansiSeqRe = regexp.MustCompile("(?:" + csiPattern + ")|(?:" + oscPattern + ")")

// StripANSI 剥除 ANSI 转义序列（CSI + OSC），返回可读纯文本
func StripANSI(data []byte) []byte {
	if !hasESC(data) {
		return data
	}
	return ansiSeqRe.ReplaceAll(data, nil)
}

// appendStripped 滑窗 ANSI 剥离：window 剥除 CSI/OSC 后追加到 dst 并返回。
// dst 为调用方跨 feed 复用的 scratch（本函数先复位长度再拼接，陈旧内容不外漏，
// 容量复用常态零分配）；滑窗匹配消费方（sentinel/portdetect/gitactivity）共用，
// 与 StripANSI 同一序列定义。hasESC 预筛与 StripANSI 同款：无 ESC 的窗口
// （纯文本常态）零正则成本
func appendStripped(dst, window []byte) []byte {
	dst = dst[:0]
	if !hasESC(window) {
		return append(dst, window...)
	}
	last := 0
	for _, loc := range ansiSeqRe.FindAllIndex(window, -1) {
		dst = append(dst, window[last:loc[0]]...)
		last = loc[1]
	}
	return append(dst, window[last:]...)
}

// hasESC 快速预筛：不含 ESC 字节的缓冲直接原样返回（纯文本常态零分配）
func hasESC(data []byte) bool {
	for _, b := range data {
		if b == 0x1b {
			return true
		}
	}
	return false
}
