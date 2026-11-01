import { describe, expect, it } from 'vitest'
import { relativeTimeParts } from './relative-time'

describe('relativeTimeParts', () => {
  const now = 1_000_000_000_000
  const m = (n: number) => now - n * 60_000

  it('按区间映射文案 key', () => {
    expect(relativeTimeParts(now, now)).toEqual({ key: 'activityJustNow', n: 0 })
    expect(relativeTimeParts(now + 5000, now)).toEqual({ key: 'activityJustNow', n: 0 }) // 未来时间戳不回溯负数
    expect(relativeTimeParts(m(1), now)).toEqual({ key: 'activityMinutesAgo', n: 1 })
    expect(relativeTimeParts(m(59), now)).toEqual({ key: 'activityMinutesAgo', n: 59 })
    expect(relativeTimeParts(m(60), now)).toEqual({ key: 'activityHoursAgo', n: 1 })
    expect(relativeTimeParts(m(23 * 60), now)).toEqual({ key: 'activityHoursAgo', n: 23 })
    expect(relativeTimeParts(m(24 * 60), now)).toEqual({ key: 'activityDaysAgo', n: 1 })
    expect(relativeTimeParts(m(72 * 60), now)).toEqual({ key: 'activityDaysAgo', n: 3 })
  })
})
