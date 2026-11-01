import { describe, expect, it } from 'vitest'
import { isWeakExportPassphrase } from './passStrength'

// P-20261003-101 导出口令强度判定：长度 <12 或单字符类 → 弱（黄色警示，不阻断）
describe('isWeakExportPassphrase', () => {
  it('短口令一律弱（含 123456 这类典型弱口令与 8 位合法下限口令）', () => {
    expect(isWeakExportPassphrase('')).toBe(true)
    expect(isWeakExportPassphrase('123456')).toBe(true)
    // 8 位满足 validate 下限但不足 12：可导出，仍警示（即使四类字符齐全）
    expect(isWeakExportPassphrase('abC!12#$')).toBe(true)
    expect(isWeakExportPassphrase('11111111111')).toBe(true)
  })

  it('长度足够但单字符类仍弱（纯小写 12+ 位无数字无符号）', () => {
    expect(isWeakExportPassphrase('abcdefghijklmnop')).toBe(true)
    expect(isWeakExportPassphrase('1234567812345678')).toBe(true)
  })

  it('长度 ≥12 且两类以上字符 → 强（无提示）', () => {
    expect(isWeakExportPassphrase('abcdefghijkl1')).toBe(false)
    expect(isWeakExportPassphrase('Abcdefgh1234')).toBe(false)
    expect(isWeakExportPassphrase('Corr3ct-Horse-Battery-9')).toBe(false)
    expect(isWeakExportPassphrase('ab1!ab1!ab1!')).toBe(false)
  })
})
