import { describe, it, expect } from 'vitest'
import { formatMB, formatDeltaMB, formatDeltaLoad, formatDeltaCount, formatDiagShortTime } from './diagFormat'

// 诊断快照数值展示：弹窗对比条与主机卡悬停共用同一口径（P-20261002-18）

describe('formatMB', () => {
  it('MB 以下取整，GB 保留一位小数', () => {
    expect(formatMB(512)).toBe('512 MB')
    expect(formatMB(1024)).toBe('1.0 GB')
    expect(formatMB(23552)).toBe('23.0 GB')
    expect(formatMB(-2560)).toBe('-2.5 GB')
    expect(formatMB(0)).toBe('0 MB')
  })
  it('非数值退化为占位符', () => {
    expect(formatMB(NaN)).toBe('—')
    expect(formatMB(Infinity)).toBe('—')
  })
})

describe('formatDeltaMB', () => {
  it('带符号差值：+/−/±', () => {
    expect(formatDeltaMB(23552)).toBe('+23.0 GB')
    expect(formatDeltaMB(-1024)).toBe('-1.0 GB')
    expect(formatDeltaMB(256)).toBe('+256 MB')
    expect(formatDeltaMB(0)).toBe('±0 MB')
  })
})

describe('formatDeltaLoad', () => {
  it('两位小数带符号', () => {
    expect(formatDeltaLoad(0.5)).toBe('+0.50')
    expect(formatDeltaLoad(-0.2)).toBe('-0.20')
    expect(formatDeltaLoad(0)).toBe('±0.00')
    expect(formatDeltaLoad(NaN)).toBe('—')
  })
})

describe('formatDeltaCount', () => {
  it('整数带符号：+/−/±（会话与终端计数，本机体检趋势条 P-20261005-169）', () => {
    expect(formatDeltaCount(2)).toBe('+2')
    expect(formatDeltaCount(-1)).toBe('-1')
    expect(formatDeltaCount(0)).toBe('±0')
    expect(formatDeltaCount(NaN)).toBe('—')
  })
})

describe('formatDiagShortTime', () => {
  it('ISO → MM/DD HH:mm', () => {
    // 本地时区构造，避免 CI 时区漂移
    const d = new Date(2026, 9, 3, 14, 22)
    expect(formatDiagShortTime(d.toISOString())).toBe('10/03 14:22')
  })
  it('空值/非法值返回空串', () => {
    expect(formatDiagShortTime(undefined)).toBe('')
    expect(formatDiagShortTime('not-a-date')).toBe('')
  })
})
