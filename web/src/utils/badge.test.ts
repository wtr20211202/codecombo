import { describe, expect, it } from 'vitest'
import { formatBadgeCount } from './badge'

describe('formatBadgeCount', () => {
  it('99 及以内原样返回数字', () => {
    expect(formatBadgeCount(0)).toBe(0)
    expect(formatBadgeCount(1)).toBe(1)
    expect(formatBadgeCount(99)).toBe(99)
  })

  it('超过 99 显示「99+」（徽标宽度有界）', () => {
    expect(formatBadgeCount(100)).toBe('99+')
    expect(formatBadgeCount(201)).toBe('99+')
    expect(formatBadgeCount(99999)).toBe('99+')
  })
})
