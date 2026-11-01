package agentchain

// prompt.go（P-20261004-38）：接续链 prompt 模板展开——占位符替换 + launchArgs
// 字节配额收敛。纯函数（单测锚点），触发引擎调用。
//
// 上下文包 MVP 是结构化三元组（提案红线：勿过度设计）：
//   {prevTask}   上一棒任务简称（task.progress 载荷 task）
//   {prevStatus} 终态（done / failed）
//   {prevStep}   上一棒最后一步摘要（载荷 step）
// 未知占位符原样透传（agentcron expandPromptVars 同纪律：agent 读到未识别
// 占位符即知模板笔误，好过静默吞成空串）。

import (
	"strings"
	"unicode/utf8"
)

const (
	// launchArgsMax prompt 配额（UTF-8 字节）：agent 会话 launchArgs 服务端
	// 上限同口径（terminal.go len(launchArgs) > 500 拒绝）。模板存储配额按
	// 原文计（api.go promptMax 同值），三元组展开发生在触发时——展开增量为
	// 「注入面」而非「存储面」，与 agentcron [scheduled] 时间戳后缀同注记口径；
	// 本文件把展开结果收敛回配额内（内部调用方自证长度合规契约）
	launchArgsMax = 500

	// placeholderPrev* 模板占位符（整枚精确命中才替换，非前缀替换）
	placeholderPrevTask   = "{prevTask}"
	placeholderPrevStatus = "{prevStatus}"
	placeholderPrevStep   = "{prevStep}"
)

// ExpandPrompt 模板展开：单行化 → 占位符整枚替换 → 超配额时按预算裁剪变量值
// （模板正文与 prevStatus 保真——status 是 4~6 字节短词，任务简称与步骤摘要
// 才是被裁对象，任务简称优先保头 2/3 预算）。模板固定段本身 ≤500 字节（存储
// 口校验），故空值展开恒在配额内，不存在「模板装不下」失败路径。
func ExpandPrompt(template, prevTask, prevStatus, prevStep string) string {
	single := strings.Join(strings.Fields(template), " ")
	task := strings.Join(strings.Fields(prevTask), " ")
	step := strings.Join(strings.Fields(prevStep), " ")

	render := func(t, s string) string {
		out := strings.ReplaceAll(single, placeholderPrevTask, t)
		out = strings.ReplaceAll(out, placeholderPrevStatus, prevStatus)
		out = strings.ReplaceAll(out, placeholderPrevStep, s)
		return out
	}

	full := render(task, step)
	if len(full) <= launchArgsMax {
		return full
	}
	// 超配额：预算 = 配额 - 固定段（空值展开形态）- status 展开增量，
	// 任务简称与步骤摘要按 2:1 分（任务语义权重高）；status 是白名单词汇
	//（done/failed），实际增量恒为原词长度
	fixed := len(render("", ""))
	statusLen := len(prevStatus)
	budget := launchArgsMax - fixed - statusLen
	if budget < 0 {
		budget = 0
	}
	taskBudget := budget * 2 / 3
	stepBudget := budget - taskBudget
	return render(truncateBytes(task, taskBudget), truncateBytes(step, stepBudget))
}

// truncateBytes 字节上限截断（不腰斩多字节字符；截断尾部以 … 标注省略，
// … 本身 3 字节计入预算）
func truncateBytes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	const ellipsis = "…"
	if len(s) <= max {
		return s
	}
	cut := s[:max-len(ellipsis)]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut + ellipsis
}
