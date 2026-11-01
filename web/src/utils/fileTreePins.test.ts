import { describe, it, expect } from 'vitest'
import { MAX_PINNED_DIRS, upsertPin, removePin, prunePins, pinAlias } from './fileTreePins'

describe('upsertPin', () => {
  it('新钉选置顶', () => {
    expect(upsertPin(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('重复钉选移到最前且不重复', () => {
    expect(upsertPin(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })

  it(`超过上限 ${MAX_PINNED_DIRS} FIFO 淘汰最旧`, () => {
    const full = Array.from({ length: MAX_PINNED_DIRS }, (_, i) => `d${i}`) // 新→旧：d0 最新，d7 最旧
    const next = upsertPin(full, 'new')
    expect(next).toHaveLength(MAX_PINNED_DIRS)
    expect(next[0]).toBe('new')
    expect(next).toContain('d6') // 尾部最旧 d7 被淘汰，d6 起保留
    expect(next).not.toContain('d7')
  })

  it('上限内不截断已有项', () => {
    expect(upsertPin(['a'], 'b')).toEqual(['b', 'a'])
  })
})

describe('removePin / prunePins', () => {
  it('removePin 只删目标', () => {
    expect(removePin(['a', 'b', 'a/b'], 'a')).toEqual(['b', 'a/b'])
    expect(removePin(['a'], 'x')).toEqual(['a'])
  })

  it('prunePins 按谓词清理失效项', () => {
    const valid = (p: string) => p !== 'gone'
    expect(prunePins(['ok', 'gone', 'ok2'], valid)).toEqual(['ok', 'ok2'])
  })
})

describe('pinAlias', () => {
  it('深层目录取末两段', () => {
    expect(pinAlias('src/components/layout')).toBe('components/layout')
  })
  it('两段目录原样', () => {
    expect(pinAlias('src/components')).toBe('src/components')
  })
  it('单段目录就是自身', () => {
    expect(pinAlias('docs')).toBe('docs')
  })
})
