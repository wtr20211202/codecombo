import { describe, expect, it } from 'vitest'
import { SESSION_IDLE_THRESHOLD_MIN, SESSION_STALL_THRESHOLD_MIN, idleTextKeys, sessionIdleMinutes, sessionStallMinutes } from './session-idle'

describe('sessionIdleMinutes', () => {
  const now = 1_000_000_000_000
  const m = (n: number) => now - n * 60_000

  it('running 且无活动超阈值才亮标，分钟数向下取整', () => {
    expect(sessionIdleMinutes(true, m(3), now)).toBe(3) // 超 3 分钟（含整 3 分钟）即静默
    expect(sessionIdleMinutes(true, m(3) - 30_000, now)).toBe(3) // 3 分 30 秒 → 3
    expect(sessionIdleMinutes(true, m(65), now)).toBe(65)
    expect(sessionIdleMinutes(true, m(SESSION_IDLE_THRESHOLD_MIN) + 1, now)).toBe(0) // 差 1ms 不亮
  })

  it('非 running / 无活动记录 / 活跃会话不亮标', () => {
    expect(sessionIdleMinutes(false, m(30), now)).toBe(0) // 非运行态不判静默
    expect(sessionIdleMinutes(true, undefined, now)).toBe(0) // 无 OSC 133 记录 = 未知
    expect(sessionIdleMinutes(true, m(1), now)).toBe(0) // 活跃
  })
})

describe('idleTextKeys', () => {
  it('有 pending 审批特化「等待裁决」文案键（badge+tip 同档）', () => {
    expect(idleTextKeys(true)).toEqual({
      badge: 'claudeSessions.idle.pendingBadge',
      tip: 'claudeSessions.idle.pendingTip',
    })
  })

  it('无 pending 回落泛化「无输出」文案键（判据不变只分档文案）', () => {
    expect(idleTextKeys(false)).toEqual({
      badge: 'claudeSessions.idle.badge',
      tip: 'claudeSessions.idle.tip',
    })
  })
})

describe('sessionStallMinutes', () => {
  const now = 1_000_000_000_000
  const m = (n: number) => now - n * 60_000
  // 主形态：runningMap false（命令已结束回提示符）+ 任务侧声称 running
  const deadish = { taskRunning: true, running: false } as const

  it('反组合两侧都沉默满阈值才亮标，分钟数向下取整', () => {
    expect(sessionStallMinutes({ ...deadish, lastActivity: m(6), lastReportAt: m(6), now })).toBe(6)
    expect(sessionStallMinutes({ ...deadish, lastActivity: m(5), lastReportAt: m(9), now })).toBe(5) // 整 5 分钟即停滞
    expect(sessionStallMinutes({ ...deadish, lastActivity: m(5) + 1, lastReportAt: m(9), now })).toBe(0) // 差 1ms 不亮
    expect(sessionStallMinutes({ ...deadish, lastActivity: m(4), lastReportAt: m(4), now })).toBe(0) // 弱标档内不升级
    expect(SESSION_STALL_THRESHOLD_MIN).toBeGreaterThan(SESSION_IDLE_THRESHOLD_MIN) // 停滞档长于静默防抖档
  })

  it('任一侧近期还有动静不算停滞（活 agent 思考中/刚上报过）', () => {
    // shell 沉默 6 分钟但任务 1 分钟前刚上报——agent 活着，不误标
    expect(sessionStallMinutes({ ...deadish, lastActivity: m(6), lastReportAt: m(1), now })).toBe(0)
    // 任务上报停在 6 分钟前但 shell 刚有事件——会话侧有动静，不误标
    expect(sessionStallMinutes({ taskRunning: true, running: true, lastActivity: m(1), lastReportAt: m(6), now })).toBe(0)
  })

  it('runningMap true 且静默超阈值：弱标观察档之后升级停滞档', () => {
    expect(sessionStallMinutes({ taskRunning: true, running: true, lastActivity: m(6), lastReportAt: m(6), now })).toBe(6)
    expect(sessionStallMinutes({ taskRunning: true, running: true, lastActivity: m(4), lastReportAt: m(6), now })).toBe(0) // 仍在弱标档
  })

  it('任务非 running / 无 OSC 133 记录不判（宁漏标不误标）', () => {
    expect(sessionStallMinutes({ taskRunning: false, running: false, lastActivity: m(30), lastReportAt: m(30), now })).toBe(0)
    expect(sessionStallMinutes({ taskRunning: true, running: false, lastActivity: undefined, lastReportAt: m(30), now })).toBe(0)
    expect(sessionStallMinutes({ taskRunning: true, running: false, lastActivity: m(30), lastReportAt: undefined, now })).toBe(30) // 无上报记录退化为单侧口径
  })

  it('now 缺省取 Date.now（宿主不传时钟）', () => {
    const at = Date.now() - 7 * 60_000
    expect(sessionStallMinutes({ ...deadish, lastActivity: at, lastReportAt: at })).toBe(7)
  })
})
