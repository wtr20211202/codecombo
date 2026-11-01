/**
 * 会话接力摘要提取（P-20261003-114）：从时间线尾部窗口挑「结论」作接力源，
 * 注入新会话 launchArgs 前言（跨天任务的知识接力进全新上下文）。
 *
 * 尾部优先策略（越近越相关）：跨天接力的知识价值集中在会话收尾——最后的
 * assistant 回复通常是任务终态结论（做了什么/卡在哪/下一步），此前的过程性
 * 内容（工具调用/结果/思考草稿）不进摘要。服务端 timeline 解析已把 thinking
 * 跳过、tool/result 分流成独立 kind（server/claudesessions/timeline.go），这里
 * 只认 assistant 文本条目，从最新往回找第一条非空者即「最后结论」。
 */
import type { ClaudeSessionPressure, ClaudeTimelineEntry } from '../api/domains/claude'

/** 尾部回溯窗口条数：最后一条 assistant 文本可能被收尾的 user 指令/tool 混排
 *  垫在几条之前，60 条足够覆盖收尾一段，又远小于时间线首屏 limit(50) 的两页
 *  感知量；服务端指纹缓存下两跳请求零重复解析成本 */
export const RELAY_TAIL_ENTRIES = 60

/** 上下文低余量阈值出厂缺省（P-20261003-141）：余量（100−占用估算%）不足该值时
 *  会话行出「上下文将满」警示并放开活跃会话接力——上下文将满时 agent 输出质量
 *  骤降，换代时机要主动递到用户面前，而不是让人对着 ≈NN% 徽标心算。
 *  用户可调（P-20261006-33，5-30 档设备本地偏好 stores/contextWarn.ts）：长写作/
 *  重构会话调高阈值给结论生成留余量，本常量降级为「未调过」的出厂档 */
export const LOW_REMAINING_PCT = 10

/**
 * 上下文低余量判定：余量 = 100 − pressure.percent（服务端尾部 usage 估算，
 * 一位小数），严格小于阈值才算将满（恰压线仍算够用）；无压力数据（非活跃
 * 行服务端不估算）恒 false——警示只跟随真实估算，「无数据」≠「将满」，与
 * 服务端 ContextPressure 的 ok=false 语义同纪律。threshold 缺省出厂档（存量
 * 调用方/单测零改动），用户阈值由消费方从 contextWarn store 注入（P-33）。
 */
export function isLowRemaining(pressure: ClaudeSessionPressure | undefined, threshold: number = LOW_REMAINING_PCT): boolean {
  if (!pressure) return false
  return 100 - pressure.percent < threshold
}

/**
 * 取接力摘要源：尾部窗口内最后一条有正文的 assistant 条目文本（trim 后）；
 * 窗口内没有任何 assistant 文本（纯工具会话/空会话）返回空串，由调用方如实
 * 提示放弃而非注入空前言。
 */
export function pickRelaySummary(entries: ClaudeTimelineEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e && e.kind === 'assistant' && e.text.trim()) return e.text.trim()
  }
  return ''
}
