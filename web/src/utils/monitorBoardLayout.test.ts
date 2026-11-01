import { describe, it, expect } from 'vitest'
import {
  MONITOR_CARD_IDS,
  isMonitorCardId,
  mergeMonitorCardOrder,
  monitorCardLabelKey,
  moveMonitorCard,
  normalizeMonitorCardOrder,
  normalizeMonitorHiddenCards,
  splitMonitorVisibility,
  type MonitorCardId,
} from './monitorBoardLayout'

/** 值班大屏卡片类目布局纯函数（P-20261004-18）：形状防御 / 拖拽语义 /
 *  隐藏类目临时置顶的裁决面——持久化数据不可信，防御逻辑全在此层单测覆盖 */
describe('normalizeMonitorCardOrder（顺序表形状防御）', () => {
  it('非数组/空表 → null（= 未定制，回落内置序）', () => {
    expect(normalizeMonitorCardOrder(undefined)).toBeNull()
    expect(normalizeMonitorCardOrder(null)).toBeNull()
    expect(normalizeMonitorCardOrder('fleet')).toBeNull()
    expect(normalizeMonitorCardOrder({})).toBeNull()
    expect(normalizeMonitorCardOrder([])).toBeNull()
  })

  it('剔除未知 id 与脏类型条目，去重保序', () => {
    expect(normalizeMonitorCardOrder(['approvals', 'tasks', 'approvals', 42, 'bogus', null]))
      .toEqual(['approvals', 'tasks'])
  })

  it('全脏表 → null（不落成空定制）', () => {
    expect(normalizeMonitorCardOrder(['bogus', 1, [2]])).toBeNull()
  })
})

describe('normalizeMonitorHiddenCards（隐藏集形状防御）', () => {
  it('非数组 → 空表（= 全显示）', () => {
    expect(normalizeMonitorHiddenCards(undefined)).toEqual([])
    expect(normalizeMonitorHiddenCards('tasks')).toEqual([])
  })

  it('只留已知 id、去重', () => {
    expect(normalizeMonitorHiddenCards(['asks', 'nope', 'asks', 7])).toEqual(['asks'])
  })
})

describe('mergeMonitorCardOrder（手动表合成渲染序）', () => {
  it('无手动表 = 内置序', () => {
    expect(mergeMonitorCardOrder(null)).toEqual([...MONITOR_CARD_IDS])
    expect(mergeMonitorCardOrder([])).toEqual([...MONITOR_CARD_IDS])
  })

  it('手动表在前，未收录类目按内置序续尾（定制不吞新类目）', () => {
    expect(mergeMonitorCardOrder(['sessions', 'approvals'])).toEqual([
      'sessions', 'approvals', 'fleet', 'asks', 'tasks',
    ])
    expect(mergeMonitorCardOrder(['tasks'])).toEqual(['tasks', 'fleet', 'approvals', 'asks', 'sessions'])
  })

  it('手动表内的未知 id 过滤（纯函数不信任入参）', () => {
    expect(mergeMonitorCardOrder(['bogus', 'asks'])).toEqual(['asks', 'fleet', 'approvals', 'tasks', 'sessions'])
  })
})

describe('moveMonitorCard（insert-before 拖拽语义）', () => {
  const base = ['fleet', 'approvals', 'asks', 'tasks', 'sessions']

  it('向后拖：拖到目标 = 移到其前', () => {
    expect(moveMonitorCard(base, 'fleet', 'tasks')).toEqual(['approvals', 'asks', 'fleet', 'tasks', 'sessions'])
  })

  it('向前拖：同样 insert-before', () => {
    expect(moveMonitorCard(base, 'sessions', 'approvals')).toEqual(['fleet', 'sessions', 'approvals', 'asks', 'tasks'])
  })

  it('相邻后继拖拽 = 无变化 → null（免空写）', () => {
    expect(moveMonitorCard(base, 'fleet', 'approvals')).toBeNull()
  })

  it('同名/未知 id/缺参 → null', () => {
    expect(moveMonitorCard(base, 'fleet', 'fleet')).toBeNull()
    expect(moveMonitorCard(base, 'bogus', 'asks')).toBeNull()
    expect(moveMonitorCard(base, '', 'asks')).toBeNull()
    expect(moveMonitorCard(base, 'fleet', '')).toBeNull()
  })
})

describe('splitMonitorVisibility（隐藏类目防漏看护栏）', () => {
  const merged: MonitorCardId[] = ['fleet', 'approvals', 'asks', 'tasks', 'sessions']

  it('未隐藏 → 全常驻、无临时块', () => {
    const r = splitMonitorVisibility(merged, [], new Set(['approvals']))
    expect(r.shown).toEqual([...MONITOR_CARD_IDS])
    expect(r.tempShown).toEqual([])
  })

  it('隐藏且无 pending → 不渲染', () => {
    const r = splitMonitorVisibility(merged, ['tasks', 'sessions'], new Set())
    expect(r.shown).toEqual(['fleet', 'approvals', 'asks'])
    expect(r.tempShown).toEqual([])
  })

  it('隐藏但有 pending → 临时置顶，且按内置序（多类目触发时确定性）', () => {
    const r = splitMonitorVisibility(merged, ['tasks', 'asks', 'sessions'], new Set(['sessions', 'asks']))
    expect(r.shown).toEqual(['fleet', 'approvals'])
    // 内置序 fleet→approvals→asks→tasks→sessions 中 asks 在 tasks 前
    expect(r.tempShown).toEqual(['asks', 'sessions'])
  })

  it('渲染序 = 临时块在前（宿主拼接语义）：先急事后日常', () => {
    const r = splitMonitorVisibility(merged, ['approvals'], new Set(['approvals']))
    expect([...r.tempShown, ...r.shown]).toEqual(['approvals', 'fleet', 'asks', 'tasks', 'sessions'])
  })
})

describe('注册表辅助', () => {
  it('isMonitorCardId 只认注册表五类目', () => {
    expect(isMonitorCardId('approvals')).toBe(true)
    expect(isMonitorCardId('bogus')).toBe(false)
    expect(isMonitorCardId(42)).toBe(false)
  })

  it('monitorCardLabelKey 返回 i18n key；未知 id 空串', () => {
    expect(monitorCardLabelKey('fleet')).toBe('monitorBoard.layout.catFleet')
    expect(monitorCardLabelKey('nope')).toBe('')
  })
})
