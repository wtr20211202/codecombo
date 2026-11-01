import { describe, expect, it } from 'vitest'
import { fmtLedgerDurationShort, formatLedgerLine, hasLedgerData } from './sessionLedger'
import type { ClaudeSessionLedger } from '../api/domains/claude'

/** 台账工厂（只给测试关心的字段，形态对齐 server/claudesessions.Ledger） */
function led(filesWritten: number, commandsRun: number, durationMs: number): ClaudeSessionLedger {
  return { filesWritten, commandsRun, durationMs }
}

/** 译函数桩：直接按 zh-CN 词形返回，验证分段拼接与零值省略 */
const tf = (key: string, params?: Record<string, unknown>): string => {
  const table: Record<string, string> = {
    'claudeSessions.ledger.files': `改 ${params?.n} 文件`,
    'claudeSessions.ledger.commands': `跑 ${params?.n} 命令`,
    'claudeSessions.ledger.duration': `耗时 ${params?.d}`,
    'claudeSessions.ledger.durMin': `${params?.n} 分钟`,
    'claudeSessions.ledger.durHour': `${params?.n} 小时`,
    'claudeSessions.ledger.durLt1m': '不足 1 分钟',
  }
  return table[key] ?? key
}

describe('hasLedgerData（P-20261005-208 零值隐藏）', () => {
  it('undefined / 三项全零 = 无展示数据', () => {
    expect(hasLedgerData(undefined)).toBe(false)
    expect(hasLedgerData(led(0, 0, 0))).toBe(false)
  })
  it('任一段非零即有数据（只跑命令不写文件的会话）', () => {
    expect(hasLedgerData(led(0, 3, 0))).toBe(true)
    expect(hasLedgerData(led(0, 0, 500))).toBe(true)
  })
})

describe('fmtLedgerDurationShort（紧凑段跨时）', () => {
  it('<1 分钟 / 分钟整数 / 上小时一位小数', () => {
    expect(fmtLedgerDurationShort(30_000)).toBe('<1m')
    expect(fmtLedgerDurationShort(42 * 60_000)).toBe('42m')
    expect(fmtLedgerDurationShort(90 * 60_000)).toBe('1.5h')
  })
})

describe('formatLedgerLine（完整句：按段零值省略）', () => {
  it('三段齐全：改 N 文件 · 跑 N 命令 · 耗时 X', () => {
    expect(formatLedgerLine(led(3, 12, 42 * 60_000), tf)).toBe('改 3 文件 · 跑 12 命令 · 耗时 42 分钟')
  })
  it('零值段省略（只跑命令的会话不出文件段）', () => {
    expect(formatLedgerLine(led(0, 12, 42 * 60_000), tf)).toBe('跑 12 命令 · 耗时 42 分钟')
  })
  it('跨时不足 1 分钟与上小时两档', () => {
    expect(formatLedgerLine(led(1, 0, 30_000), tf)).toBe('改 1 文件 · 耗时 不足 1 分钟')
    expect(formatLedgerLine(led(1, 0, 90 * 60_000), tf)).toBe('改 1 文件 · 耗时 1.5 小时')
  })
  it('无可展示数据返回空串（调用方整段隐藏/不注入）', () => {
    expect(formatLedgerLine(undefined, tf)).toBe('')
    expect(formatLedgerLine(led(0, 0, 0), tf)).toBe('')
  })
})
