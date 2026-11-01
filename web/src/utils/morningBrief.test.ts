import { beforeEach, describe, expect, it } from 'vitest'
import {
  briefTodayKey,
  dismissBriefItem,
  morningBriefStorageKey,
  readBriefDismissed,
  visibleBriefItems,
} from './morningBrief'
import type { MorningBrief } from '../api/domains/system'

// 当日显示纪律纯函数层（P-20261005-219）：显隐判定/当日已阅读写/降级缺席语义
// 是「不做每日重复骚扰」的契约面。safeStorage 真通道跑在 jsdom localStorage 上。

const brief = (patch: Partial<MorningBrief> = {}): MorningBrief => ({
  date: '2026-10-15',
  unpushed: { count: 3, projects: [{ id: 'p1', name: 'A', ahead: 3 }] },
  runningAgents: { count: 2 },
  unread: { count: 1, notifications: 1, approvals: 0 },
  ...patch,
})

beforeEach(() => {
  localStorage.clear()
})

describe('briefTodayKey', () => {
  it('本地日期零填充 yyyy-MM-dd（当日语义单一事实源）', () => {
    expect(briefTodayKey(new Date(2026, 9, 15, 8, 30))).toBe('2026-10-15')
    expect(briefTodayKey(new Date(2026, 0, 3, 23, 59))).toBe('2026-01-03')
  })
})

describe('readBriefDismissed / dismissBriefItem', () => {
  it('无存储 = 未已阅空清单', () => {
    expect(readBriefDismissed('2026-10-15')).toEqual([])
  })

  it('单项已阅幂等累积；跨日 key 隔离（按日轮换自然失效）', () => {
    dismissBriefItem('2026-10-15', 'unpushed')
    dismissBriefItem('2026-10-15', 'unpushed')
    expect(readBriefDismissed('2026-10-15')).toEqual(['unpushed'])
    expect(readBriefDismissed('2026-10-16')).toEqual([])
  })

  it('整卡已阅后单项写入不再扩清单', () => {
    dismissBriefItem('2026-10-15', 'all')
    dismissBriefItem('2026-10-15', 'unread')
    expect(readBriefDismissed('2026-10-15')).toEqual(['all'])
  })

  it('损坏 JSON / 形态不符回落空清单（宁多重提醒不吞待办）', () => {
    localStorage.setItem(morningBriefStorageKey('2026-10-15'), '{broken')
    expect(readBriefDismissed('2026-10-15')).toEqual([])
    localStorage.setItem(morningBriefStorageKey('2026-10-15'), JSON.stringify({ all: true }))
    expect(readBriefDismissed('2026-10-15')).toEqual([])
    localStorage.setItem(morningBriefStorageKey('2026-10-15'), JSON.stringify(['all', 3, null]))
    expect(readBriefDismissed('2026-10-15')).toEqual(['all'])
  })
})

describe('visibleBriefItems', () => {
  it('三源齐全非零：按未推送→会话→未读保序全显', () => {
    expect(visibleBriefItems(brief(), [])).toEqual(['unpushed', 'runningAgents', 'unread'])
  })

  it('零值或源缺席（降级）不计——全零 = 零打扰', () => {
    expect(visibleBriefItems(brief({ unpushed: { count: 0, projects: [] } }), [])).toEqual(['runningAgents', 'unread'])
    expect(visibleBriefItems(brief({ runningAgents: undefined, unread: undefined }), [])).toEqual(['unpushed'])
    expect(
      visibleBriefItems(brief({ unpushed: { count: 0, projects: [] }, runningAgents: { count: 0 }, unread: { count: 0, notifications: 0, approvals: 0 } }), []),
    ).toEqual([])
  })

  it('brief 未载入（null/undefined）= 不显示', () => {
    expect(visibleBriefItems(null, [])).toEqual([])
    expect(visibleBriefItems(undefined, [])).toEqual([])
  })

  it('整卡已阅全隐；单项已阅只隐该项', () => {
    expect(visibleBriefItems(brief(), ['all'])).toEqual([])
    expect(visibleBriefItems(brief(), ['unpushed'])).toEqual(['runningAgents', 'unread'])
    expect(visibleBriefItems(brief(), ['unread', 'runningAgents'])).toEqual(['unpushed'])
  })
})
