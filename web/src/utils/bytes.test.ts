// bytes util（P-20261005-176 冻结快照占用可见性）单测：GB 感知格式化 +
// >80% 预警档边界（交叉相乘实现的精确性——80% 恰好不预警）

import { describe, expect, it } from 'vitest'
import { formatBytes, usageExceeds } from './bytes'

describe('formatBytes', () => {
  it('B 档不显小数位', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })
  it('KB/MB 一位小数（digits 缺省 1）', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
  it('GB 档：digits 可调两位（占用合计行用）；不足 1GB 仍按量级落 MB', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
    expect(formatBytes(128 * 1024 * 1024, 2)).toBe('128.00 MB')
    expect(formatBytes(1.5 * 1024 ** 3, 2)).toBe('1.50 GB')
  })
  it('超 GB 上界钳在 GB 档（无 TB 档，护栏 1GB 量级用不到）', () => {
    expect(formatBytes(2048 * 1024 ** 3)).toBe('2048.0 GB')
  })
})

describe('usageExceeds', () => {
  it('恰 80% 不预警（边界），80%+1 字节预警', () => {
    const cap = 1024 ** 3
    expect(usageExceeds(cap * 0.8, cap)).toBe(false)
    expect(usageExceeds(cap * 0.8 + 1, cap)).toBe(true)
  })
  it('低位不预警，满额/超额预警', () => {
    const cap = 1024 ** 3
    expect(usageExceeds(0, cap)).toBe(false)
    expect(usageExceeds(cap / 2, cap)).toBe(false)
    expect(usageExceeds(cap, cap)).toBe(true)
    expect(usageExceeds(cap * 2, cap)).toBe(true)
  })
  it('护栏值未下发（cap ≤ 0）恒不预警——不预警比误报安全', () => {
    expect(usageExceeds(999, 0)).toBe(false)
    expect(usageExceeds(999, -1)).toBe(false)
  })
})
