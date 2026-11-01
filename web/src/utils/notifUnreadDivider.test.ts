import { describe, it, expect } from 'vitest'
import { countNewSince, isNewSince, lastNewRowIndex, notifTimeMs } from './notifUnreadDivider'

// 未读分界线纯函数（P-20261003-259）：边界语义——无基线不分界、严格晚于
// 才新增（同一毫秒按旧处理）、脏时间不制造假新增、落点取最后一条新行。

const LAST_SEEN = Date.UTC(2026, 9, 18, 12, 0, 0)
const older = new Date(LAST_SEEN - 60_000).toISOString()
const sameMoment = new Date(LAST_SEEN).toISOString()
const newer = new Date(LAST_SEEN + 60_000).toISOString()

describe('notifUnreadDivider 未读分界线', () => {
  it('notifTimeMs：合法 ISO 转毫秒，非法/空串回落 0', () => {
    expect(notifTimeMs(newer)).toBe(LAST_SEEN + 60_000)
    expect(notifTimeMs('')).toBe(0)
    expect(notifTimeMs('not-a-date')).toBe(0)
  })

  it('isNewSince：严格晚于才算新增；同毫秒/更早/脏时间都不算', () => {
    expect(isNewSince(newer, LAST_SEEN)).toBe(true)
    expect(isNewSince(sameMoment, LAST_SEEN)).toBe(false)
    expect(isNewSince(older, LAST_SEEN)).toBe(false)
    expect(isNewSince('garbage', LAST_SEEN)).toBe(false)
  })

  it('无基线（0/负数/NaN）一律不分界', () => {
    expect(isNewSince(newer, 0)).toBe(false)
    expect(isNewSince(newer, -1)).toBe(false)
    expect(isNewSince(newer, Number.NaN)).toBe(false)
    expect(countNewSince([{ time: newer }], 0)).toBe(0)
    expect(lastNewRowIndex([newer], 0)).toBe(-1)
  })

  it('countNewSince：按当前视图条目数计新增（组内成员也各计一条）', () => {
    expect(countNewSince([{ time: newer }, { time: newer }, { time: older }], LAST_SEEN)).toBe(2)
    expect(countNewSince([], LAST_SEEN)).toBe(0)
  })

  it('lastNewRowIndex：倒序列表取最后一条新行（界线插在其后）', () => {
    // 新/新/旧/旧 → 界线在第 1 行之后
    expect(lastNewRowIndex([newer, newer, older, older], LAST_SEEN)).toBe(1)
    // 全部为新 → 界线在末尾
    expect(lastNewRowIndex([newer, newer], LAST_SEEN)).toBe(1)
    // 全部为旧 → 不分界
    expect(lastNewRowIndex([older, older], LAST_SEEN)).toBe(-1)
    // 空列表
    expect(lastNewRowIndex([], LAST_SEEN)).toBe(-1)
  })
})
