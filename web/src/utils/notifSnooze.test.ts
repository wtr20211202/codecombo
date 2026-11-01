import { describe, expect, it, vi, afterEach } from 'vitest'
import { formatSnoozeUntil, snoozeUntilFor } from './notifSnooze'

// 通知稍后提醒时刻纯函数（自 NotificationCenter.vue P-20261007-23 迁入伴随测试）：
// 三档菜单的绝对时刻算法与到期展示的今天/跨天分叉。

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('snoozeUntilFor 三档菜单算绝对时刻（P-20261003-36）', () => {
  it('min30/hour1：分钟平移 30/60', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 24, 10, 5, 0))
    expect(new Date(snoozeUntilFor('min30')).getMinutes()).toBe(35)
    expect(new Date(snoozeUntilFor('hour1')).getHours()).toBe(11)
  })

  it('明天：历法 +1 天（跨月也落同墙钟时刻），其余 key 同口径', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 31, 22, 40, 0)) // 月末 → 跨月
    const tomorrow = new Date(snoozeUntilFor('tomorrow'))
    expect(tomorrow.getMonth()).toBe(10) // 11 月
    expect(tomorrow.getDate()).toBe(1)
    expect(tomorrow.getHours()).toBe(22)
    // 未登记 key（扩展面）按「明天」兜底——与组件既有行为一致
    const other = new Date(snoozeUntilFor('whatever'))
    expect(other.getDate()).toBe(1)
  })
})

describe('formatSnoozeUntil 到期展示（今天钟点 / 跨天带日期）', () => {
  it('今天：只看 HH:mm（两位补零）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 24, 9, 0, 0))
    const iso = new Date(2026, 9, 24, 9, 5, 0).toISOString()
    expect(formatSnoozeUntil(iso)).toBe('09:05')
  })

  it('跨天：M-D HH:mm（数字形态语言中立）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 24, 9, 0, 0))
    const iso = new Date(2026, 10, 2, 23, 30, 0).toISOString()
    expect(formatSnoozeUntil(iso)).toBe('11-2 23:30')
  })
})
