import { describe, it, expect } from 'vitest'
import {
  aggregateRepeatedCommands,
  REPEAT_COMMAND_MIN_COUNT,
  REPEAT_COMMAND_WINDOW_DAYS,
  REPEAT_COMMAND_TOP_N,
} from '../../utils/repeatCommands'

// 重复命令聚合（P-20261003-199）单测：频次阈值 / 7 天窗 / top N / 排序 / 边界
const NOW = new Date('2026-10-07T12:00:00Z')

const at = (iso: string) => ({ command: 'cmd', at: iso })
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 3600_000).toISOString()

describe('aggregateRepeatedCommands', () => {
  it('常量为任务书定档（≥3 次 / 7 天 / top 20）', () => {
    expect(REPEAT_COMMAND_MIN_COUNT).toBe(3)
    expect(REPEAT_COMMAND_WINDOW_DAYS).toBe(7)
    expect(REPEAT_COMMAND_TOP_N).toBe(20)
  })

  it('同命令累计次数并给出窗口内最近使用时间', () => {
    const stats = aggregateRepeatedCommands([
      { command: 'npm test', at: hoursAgo(1) },
      { command: 'npm test', at: hoursAgo(5) },
      { command: 'npm test', at: hoursAgo(10) },
    ], { now: NOW })
    expect(stats).toEqual([
      { command: 'npm test', count: 3, lastUsedAt: hoursAgo(1) },
    ])
  })

  it('低于阈值（<3 次）不入列', () => {
    const stats = aggregateRepeatedCommands([
      at(hoursAgo(1)),
      at(hoursAgo(2)),
    ], { now: NOW })
    expect(stats).toEqual([])
  })

  it('窗口外（>7 天）的条目不计次——仅窗外记录则整条出局', () => {
    const stats = aggregateRepeatedCommands([
      at(daysAgo(8)),
      at(daysAgo(9)),
      at(daysAgo(10)),
    ], { now: NOW })
    expect(stats).toEqual([])
  })

  it('窗外旧次不计入次数：窗内 1 次 + 窗外 2 次 < 3 不入列', () => {
    const stats = aggregateRepeatedCommands([
      at(hoursAgo(1)),
      at(daysAgo(8)),
      at(daysAgo(9)),
    ], { now: NOW })
    expect(stats).toEqual([])
  })

  it('窗口边界含 7 天整（恰好 cutoff 时点计入）', () => {
    const stats = aggregateRepeatedCommands([
      at(new Date(NOW.getTime() - 7 * 24 * 3600_000).toISOString()),
      at(hoursAgo(2)),
      at(hoursAgo(3)),
    ], { now: NOW })
    expect(stats).toHaveLength(1)
    expect(stats[0]!.count).toBe(3)
  })

  it('按次数降序；同数按最近使用新者在前', () => {
    const stats = aggregateRepeatedCommands([
      { command: 'a', at: hoursAgo(1) },
      { command: 'a', at: hoursAgo(2) },
      { command: 'a', at: hoursAgo(3) },
      { command: 'a', at: hoursAgo(4) },
      { command: 'b', at: hoursAgo(1) },
      { command: 'b', at: hoursAgo(2) },
      { command: 'b', at: hoursAgo(30) },
      { command: 'c', at: hoursAgo(2) },
      { command: 'c', at: hoursAgo(5) },
      { command: 'c', at: hoursAgo(6) },
    ], { now: NOW })
    expect(stats.map(s => s.command)).toEqual(['a', 'b', 'c'])
    expect(stats.find(s => s.command === 'b')!.lastUsedAt).toBe(hoursAgo(1))
  })

  it('topN 截断保序', () => {
    const entries = [] as { command: string; at: string }[]
    for (let i = 0; i < 25; i++) {
      for (let k = 0; k < 3; k++) entries.push({ command: `cmd-${i}`, at: hoursAgo(1 + i) })
    }
    const stats = aggregateRepeatedCommands(entries, { now: NOW, topN: 20 })
    expect(stats).toHaveLength(20)
    expect(stats[0]!.command).toBe('cmd-0')
    expect(stats[19]!.command).toBe('cmd-19')
  })

  it('非法时间戳跳过不致崩；空输入返回空', () => {
    expect(aggregateRepeatedCommands([], { now: NOW })).toEqual([])
    const stats = aggregateRepeatedCommands([
      { command: 'x', at: 'not-a-date' },
      at(hoursAgo(1)),
      at(hoursAgo(2)),
      at(hoursAgo(3)),
    ], { now: NOW })
    expect(stats).toEqual([{ command: 'cmd', count: 3, lastUsedAt: hoursAgo(1) }])
  })

  it('默认 now=当前时点（不传 opts 可用）', () => {
    const recent = new Date().toISOString()
    const stats = aggregateRepeatedCommands([at(recent), at(recent), at(recent)])
    expect(stats).toHaveLength(1)
    expect(stats[0]!.count).toBe(3)
  })
})
