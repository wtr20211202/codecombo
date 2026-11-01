import { describe, expect, it } from 'vitest'
import {
  NEW_SESSION_WINDOW_MS,
  formatSessionActivityShort,
  formatSessionCreatedAt,
  isNewAgentSession,
} from './sessionIdentity'

/**
 * 会话身份面纯函数单测（P-20261023-3）：「新」徽标判据（24h 窗口 / 无活动 /
 * 接续排除）、行内创建时间短格式（今日/今年/跨年）、最近活动短格式。
 * 判据与格式均为纯函数——真实侧栏行的渲染由 e2e session-identity.spec 守门
 */

describe('isNewAgentSession', () => {
  const now = Date.parse('2026-10-23T12:00:00Z')

  it('窗口内创建且无活动：亮「新」', () => {
    expect(isNewAgentSession({ createdAt: '2026-10-23T11:00:00Z', hasActivity: false }, now)).toBe(true)
  })

  it('有 OSC 活动即不亮（用过就不是「新」）', () => {
    expect(isNewAgentSession({ createdAt: '2026-10-23T11:00:00Z', hasActivity: true }, now)).toBe(false)
  })

  it('超 24h 窗口不亮', () => {
    expect(isNewAgentSession({ createdAt: '2026-10-21T11:59:00Z', hasActivity: false }, now)).toBe(false)
  })

  it('恰在窗口边界内亮（24h 整点）', () => {
    const t = now - NEW_SESSION_WINDOW_MS
    expect(isNewAgentSession({ createdAt: new Date(t).toISOString(), hasActivity: false }, now)).toBe(true)
  })

  it('接续会话不亮「新」（复用语义不与新建混义）', () => {
    expect(isNewAgentSession({ createdAt: '2026-10-23T11:00:00Z', resumed: true, hasActivity: false }, now)).toBe(false)
  })

  it('createdAt 缺失/不可解析/未来时刻：不亮（空显不虚构）', () => {
    expect(isNewAgentSession({ hasActivity: false }, now)).toBe(false)
    expect(isNewAgentSession({ createdAt: 'not-a-date', hasActivity: false }, now)).toBe(false)
    expect(isNewAgentSession({ createdAt: '2026-10-23T13:00:00Z', hasActivity: false }, now)).toBe(false)
  })
})

describe('formatSessionCreatedAt', () => {
  // 本地时区口径：固定 now 的各时段形态
  const now = new Date(2026, 9, 23, 12, 5) // 2026-10-23 12:05 本地

  it('今日：HH:mm', () => {
    const t = new Date(2026, 9, 23, 9, 7)
    expect(formatSessionCreatedAt(t.toISOString(), now)).toBe('09:07')
  })

  it('今年非今日：MM-DD', () => {
    const t = new Date(2026, 9, 1, 9, 7)
    expect(formatSessionCreatedAt(t.toISOString(), now)).toBe('10-01')
  })

  it('跨年：YYYY-MM-DD', () => {
    const t = new Date(2025, 11, 31, 9, 7)
    expect(formatSessionCreatedAt(t.toISOString(), now)).toBe('2025-12-31')
  })

  it('缺失/不可解析：空串（调用方不渲染）', () => {
    expect(formatSessionCreatedAt(undefined, now)).toBe('')
    expect(formatSessionCreatedAt('garbage', now)).toBe('')
  })
})

describe('formatSessionActivityShort', () => {
  const now = Date.parse('2026-10-23T12:00:00Z')

  it('分钟档：N分', () => {
    expect(formatSessionActivityShort(now - 3 * 60_000, now)).toBe('3分')
  })

  it('小时档：N时；天档：N天', () => {
    expect(formatSessionActivityShort(now - 2 * 3_600_000, now)).toBe('2时')
    expect(formatSessionActivityShort(now - 5 * 86_400_000, now)).toBe('5天')
  })

  it('刚刚/无记录：空串（tooltip 有完整文案，行宽留给创建时间）', () => {
    expect(formatSessionActivityShort(now - 30_000, now)).toBe('')
    expect(formatSessionActivityShort(undefined, now)).toBe('')
  })
})
