/**
 * 会话结构化台账展示（P-20261005-208）：把 server/claudesessions.Ledger（写
 * 文件去重数 / shell 命令数 / 首尾工具活动跨时）渲染成会话中心行的紧凑段与
 * hover 完整句、接力前言的量化附行。三段可独立为零（只跑命令不写文件的会话
 * 无 files 段），消费方按段零值隐藏——「无数据」不上屏，与 DiagSnapshot 同款
 * 纪律。纯函数层：i18n 以译函数参数注入，不依赖组合式上下文。
 */
import type { ClaudeSessionLedger } from '../api/domains/claude'

/** i18n 译函数最小形态（useI18n().t 同形） */
export type LedgerTf = (key: string, params?: Record<string, unknown>) => string

/** 有无可展示的台账数据（三项全零 = 无展示数据 → 不渲染不注入） */
export function hasLedgerData(l?: ClaudeSessionLedger): boolean {
  return !!l && (l.filesWritten > 0 || l.commandsRun > 0 || l.durationMs > 0)
}

/** 跨时短格式（紧凑段展示值，与 token 徽标 1.2k 同族的语言中立形态）：
 * <1 分钟如实标 <1m；分钟整数；上小时一位小数 */
export function fmtLedgerDurationShort(ms: number): string {
  if (ms < 60_000) return '<1m'
  const minutes = ms / 60_000
  if (minutes < 60) return `${Math.floor(minutes)}m`
  return `${Math.round((minutes / 60) * 10) / 10}h`
}

/** 台账完整句（行 hover 提示 / 接力前言附行共用）：按段零值省略，「 · 」连接。
 *  无可展示数据返回空串——调用方以此判定整段隐藏/不注入 */
export function formatLedgerLine(l: ClaudeSessionLedger | undefined, tf: LedgerTf): string {
  if (!hasLedgerData(l)) return ''
  const parts: string[] = []
  if (l!.filesWritten > 0) parts.push(tf('claudeSessions.ledger.files', { n: l!.filesWritten }))
  if (l!.commandsRun > 0) parts.push(tf('claudeSessions.ledger.commands', { n: l!.commandsRun }))
  if (l!.durationMs > 0) parts.push(tf('claudeSessions.ledger.duration', { d: fmtLedgerDurationLong(l!.durationMs, tf) }))
  return parts.join(' · ')
}

/** 跨时长格式（完整句用，走 i18n；短格式 m/h 是语言中立的，分钟/小时词形各
 *  语言差异大，句子里必须本地化） */
function fmtLedgerDurationLong(ms: number, tf: LedgerTf): string {
  if (ms < 60_000) return tf('claudeSessions.ledger.durLt1m')
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return tf('claudeSessions.ledger.durMin', { n: minutes })
  return tf('claudeSessions.ledger.durHour', { n: Math.round((ms / 3_600_000) * 10) / 10 })
}
