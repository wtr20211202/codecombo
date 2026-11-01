import { describe, it, expect } from 'vitest'
import {
  isManualDndActive,
  manualDndRemainingMs,
  DND_MANUAL_QUICK_MS,
} from '@/utils/dndSchedule'

// 手动临时免打扰纯函数（P-20261003-227）：0 = 直到手动关的哨兵、null = 关、
// >0 = 绝对到期时刻（挂钟对账，到点即失效的半开语义）

describe('dndSchedule 手动临时免打扰', () => {
  const now = 1_000_000

  it('isManualDndActive：null 关 / 0 直到手动关 / 未来时刻生效 / 到点及过点失效', () => {
    expect(isManualDndActive(null, now)).toBe(false)
    expect(isManualDndActive(0, now)).toBe(true)
    expect(isManualDndActive(now + 1, now)).toBe(true)
    expect(isManualDndActive(now, now)).toBe(false)
    expect(isManualDndActive(now - 1, now)).toBe(false)
  })

  it('DND_MANUAL_QUICK_MS：快速档恒为 1 小时', () => {
    expect(DND_MANUAL_QUICK_MS).toBe(60 * 60 * 1000)
  })

  it('manualDndRemainingMs：仅有限档返回剩余（夹 0 下限），关/无限期返回 null', () => {
    expect(manualDndRemainingMs(now + 5_000, now)).toBe(5_000)
    expect(manualDndRemainingMs(now - 5_000, now)).toBe(0)
    expect(manualDndRemainingMs(0, now)).toBeNull()
    expect(manualDndRemainingMs(null, now)).toBeNull()
  })
})
