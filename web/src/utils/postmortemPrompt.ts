import { byteLength, fitByBytes, LAUNCH_ARGS_MAX_BYTES } from './promptFit'
import type { PostmortemReport } from '../api/domains/terminal'

/**
 * 复盘报告的问询 prompt 组装（P-20261004-60 一键转存问询的纯函数层）：
 * 弹层「询问智能体」把复盘 gist 经 launchArgs 预填新 agent 会话（ask 链，
 * useTodoAgentFix / useEditorAskAgent 同范式）。launchArgs 服务端上限 500
 * 字节——截断策略走 promptFit.fitByBytes 保尾语义：输出尾部（报错现场）比
 * 摘要铺垫更不可丢，退出码等关键事实放模板头部，截断只裁 gist 中段。
 * 纯函数（translator 注入）便于单测，与 useTodoAgentFix 同款组织。
 */

/** prompt 组装所需的极小翻译面（纯函数可测；调用方传 useI18n 的 t） */
export type PostmortemTranslator = (key: string, params?: Record<string, unknown>) => string

/** 复盘 gist：报告 → 紧凑事实行（语言中立 key=value + 尾部现场原文）。
 * 服务端 outputTail 已剥 ANSI 并做敏感遮蔽（P-108），此处原样搬运不再加工 */
export function buildPostmortemGist(report: PostmortemReport, t: PostmortemTranslator): string {
  const lines: string[] = []
  lines.push(`exit=${report.exitCode ?? '?'} runtime=${report.runtime || '?'} dir=${report.dir || '?'}`)
  if (report.exitedAt) lines.push(`${t('terminal.postmortem.exitedAt')}: ${report.exitedAt}`)
  const last = report.lastCommands?.[report.lastCommands.length - 1]
  if (last) lines.push(`last: ${last.command.replace(/\s+/g, ' ')} (exit ${last.exitCode})`)
  if (report.outputTail) lines.push('--- tail ---', report.outputTail)
  return lines.join('\n')
}

/** 问询 prompt：头部指令（携会话名与退出码——截断也不丢的关键事实）+ gist。
 * 超 500 字节时保尾裁剪 gist（fitByBytes），头部指令完整保留 */
export function buildPostmortemAskPrompt(report: PostmortemReport, t: PostmortemTranslator): string {
  const head = t('terminal.postmortem.askHead', {
    name: report.name || report.sessionId,
    code: report.exitCode ?? '?',
  })
  const gist = buildPostmortemGist(report, t)
  return fitByBytes((g) => `${head}\n${g}`, gist, LAUNCH_ARGS_MAX_BYTES)
}

/** prompt 字节数（敏感确认与调试面共用） */
export function postmortemPromptBytes(prompt: string): number {
  return byteLength(prompt)
}
