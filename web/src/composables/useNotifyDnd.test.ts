import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'

// 被测模块零 Pinia/naive-ui/i18n 依赖（prefs 与 store 动作均为注入），直测无需 mock
import type { NotificationItem } from '../api/client'
import type { DndWindow } from '../utils/dndSchedule'
import { useNotifyDnd } from './useNotifyDnd'

function item(partial: Partial<NotificationItem> & { id: string; time: string }): NotificationItem {
  return {
    type: 'info', category: 'system', title: `n-${partial.id}`, read: false,
    ...partial,
  }
}

/** 同日窗（10:00–11:00）且当前时刻在窗后（11:30）：窗已解除 → [今天10:00, 11:00) */
function endedWindowPrefs(): DndWindow {
  return { enabled: true, start: '10:00', end: '11:00', exceptError: true }
}
function windowItem(id: string, h: number, extra: Partial<NotificationItem> = {}): NotificationItem {
  return item({ id, time: new Date(2026, 9, 24, h, 0, 0).toISOString(), ...extra })
}

/** 固定「现在 = 2026-10-24 11:30」的时钟：dndWindow 由 nowMs ref 驱动 */
function mountDnd(prefs: DndWindow, baseItems: NotificationItem[]) {
  const store = { isSnoozed: (n: NotificationItem) => !!n.snoozeUntil }
  const dnd = useNotifyDnd({
    store,
    prefs: () => prefs,
    baseItems: () => baseItems,
  })
  dnd.nowMs.value = new Date(2026, 9, 24, 11, 30, 0).getTime()
  return dnd
}

describe('useNotifyDnd 免打扰域（P-20261003-64 自组件迁入）', () => {
  it('未启用/仍在窗内 → 无窗口无摘要；解除后 → 窗口与计数出现', () => {
    const off = mountDnd({ ...endedWindowPrefs(), enabled: false }, [])
    expect(off.dndWindow.value).toBeNull()
    expect(off.showDndSummary.value).toBe(false)

    // 11:30 仍在窗内（窗 11:00 开始的假设不成立——本窗 10-11 点，11:30 已出窗）；
    // 换当前时刻 10:30 = 在窗内 → null
    const inWindow = mountDnd(endedWindowPrefs(), [])
    inWindow.nowMs.value = new Date(2026, 9, 24, 10, 30, 0).getTime()
    expect(inWindow.dndWindow.value).toBeNull()

    const ended = mountDnd(endedWindowPrefs(), [
      windowItem('in', 10), windowItem('out', 12),
    ])
    expect(ended.dndWindow.value).not.toBeNull()
    expect(ended.dndMissedCount.value).toBe(1)
    expect(ended.showDndSummary.value).toBe(true)
  })

  it('摘要计数口径 = 窗口内 ∩ 过滤子集 ∩ 非延后中（已读也计——错过即错过）', () => {
    const dnd = mountDnd(endedWindowPrefs(), [
      windowItem('in-unread', 10),
      windowItem('in-read', 10, { read: true }),
      windowItem('in-snoozed', 10, { snoozeUntil: '2026-10-25T10:00:00Z' }),
      windowItem('out', 12),
    ])
    // baseItems 传全量模拟「无项目/runtime 过滤」：计数只看窗口内且未延后
    expect(dnd.dndMissedCount.value).toBe(2)
  })

  it('点击摘要切换过滤视图，退出即按 endMs 记账消隐；同窗重开不复现', async () => {
    const dnd = mountDnd(endedWindowPrefs(), [windowItem('in', 10)])
    expect(dnd.showDndSummary.value).toBe(true)

    dnd.toggleDndOnly()
    expect(dnd.dndOnly.value).toBe(true)
    expect(dnd.showDndSummary.value).toBe(true) // 过滤态下保留作激活指示

    dnd.toggleDndOnly() // 退出过滤视图 = 已查看
    expect(dnd.dndOnly.value).toBe(false)
    expect(dnd.showDndSummary.value).toBe(false)

    // 同一窗口内重开不再出现（dismissed 按 endMs 相等判定）
    await nextTick()
    expect(dnd.showDndSummary.value).toBe(false)
  })

  it('手动关闭连过滤态一起退出，不留不可见的过滤视图', () => {
    const dnd = mountDnd(endedWindowPrefs(), [windowItem('in', 10)])
    dnd.toggleDndOnly()
    expect(dnd.dndOnly.value).toBe(true)
    dnd.closeDndSummary()
    expect(dnd.dndOnly.value).toBe(false)
    expect(dnd.showDndSummary.value).toBe(false)
  })

  it('窗口失效（偏好禁用）或窗口内条目清零 → 过滤态自动退出并消隐', async () => {
    const prefs = ref<DndWindow>(endedWindowPrefs())
    const baseItems = ref<NotificationItem[]>([windowItem('in', 10)])
    const store = { isSnoozed: (n: NotificationItem) => !!n.snoozeUntil }
    const dnd = useNotifyDnd({ store, prefs: () => prefs.value, baseItems: () => baseItems.value })
    dnd.nowMs.value = new Date(2026, 9, 24, 11, 30, 0).getTime()
    // 先跑一拍对齐 watch 旧值基线：composable 内部 nowMs 初值取真实墙钟
    // （Date.now()），自动退出 watch 以注册时刻的采样为基线——若套件恰在
    // 本夹具窗口（10:00–11:00）内运行，基线为 [null, 0]，随后的「置钟出窗→
    // 禁用偏好」落在同一 flush 周期内，净效果仍是 [null, 0]，watch 逐元素
    // 比较判无变化不触发，自动退出不会发生（生产中窗口状态只随用户动作
    // 推进、动作间逐次 flush 采样，无此盲区）。对齐后基线恒为 [窗口, 1]，
    // 后续断言与运行时刻解耦
    await nextTick()
    dnd.toggleDndOnly()
    expect(dnd.dndOnly.value).toBe(true)

    prefs.value = { ...endedWindowPrefs(), enabled: false } // 窗口失效
    await nextTick()
    expect(dnd.dndOnly.value).toBe(false)
    expect(dnd.showDndSummary.value).toBe(false)

    // 条目清零同口径（重新启用窗 + 计数归零）
    prefs.value = endedWindowPrefs()
    await nextTick()
    dnd.toggleDndOnly()
    expect(dnd.dndOnly.value).toBe(true)
    baseItems.value = [] // 计数归零 → 自动退出
    await nextTick()
    expect(dnd.dndOnly.value).toBe(false)
  })

  it('refreshClock：面板打开时刷新时钟锚（窗口按打开时刻重算）', () => {
    const dnd = mountDnd(endedWindowPrefs(), [])
    const before = dnd.nowMs.value
    dnd.refreshClock()
    expect(dnd.nowMs.value).not.toBe(before)
    expect(Math.abs(dnd.nowMs.value - Date.now())).toBeLessThan(1000)
  })
})
