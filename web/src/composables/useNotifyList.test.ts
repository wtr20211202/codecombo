import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref, isRef, type Ref } from 'vue'

// 被测 composable 的 store 为结构化注入（stub 直供）；仅滚动已读偏好内部用
// Pinia store（挂空 Pinia，默认关不触发 IntersectionObserver 链）。useNotifyList
// 经 useNotifyAutoRead 注册 onBeforeUnmount——走 withSetup 挂真 setup 上下文
//（P-20261007-5 配套基建），避免组件外生命周期注册告警
import { withSetup } from '../__tests__/mocks/withSetup'
import type { NotificationItem } from '../api/client'
import type { NavRow } from './useNotifyList'
import { useNotifyList } from './useNotifyList'

function item(partial: Partial<NotificationItem> & { id: string }): NotificationItem {
  return {
    type: 'info', category: 'system', title: `n-${partial.id}`, time: '2026-10-24T10:00:00Z', read: false,
    ...partial,
  }
}

function makeList(filtered: NotificationItem[] | Ref<NotificationItem[]>, overrides: Partial<Parameters<typeof useNotifyList>[0]> = {}) {
  const store = {
    handleClick: vi.fn(),
    markRead: vi.fn(),
    dismiss: vi.fn(),
    showPanel: ref(true),
  }
  const selectMode = ref(false)
  const toggleRowSelection = vi.fn()
  const filteredItems = isRef(filtered) ? filtered : ref(filtered)
  const { result: list } = withSetup(() => useNotifyList({
    store,
    filteredItems,
    rootRef: ref<HTMLElement | undefined>(undefined),
    listRef: ref<HTMLElement | undefined>(undefined),
    selectMode,
    toggleRowSelection,
    resetOn: [ref(0)], // 可写 ref 即合法 WatchSource；用例按需手动触发
    ...overrides,
  }))
  return { list, store, selectMode, toggleRowSelection }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 构造触摸事件桩（jsdom 无 TouchEvent：changedTouches 按契约给 [0]/item(i)/identifier） */
function touchEvent(touch: { identifier: number; clientX: number; clientY: number }): TouchEvent {
  return {
    changedTouches: {
      length: 1,
      0: { ...touch } as Touch,
      item: (i: number) => (i === 0 ? { ...touch } as Touch : null),
    },
    preventDefault: vi.fn(),
  } as unknown as TouchEvent
}

function swipe(list: ReturnType<typeof makeList>['list'], row: NavRow, dx: number): void {
  list.onTouchStart(touchEvent({ identifier: 1, clientX: 100, clientY: 100 }), row)
  list.onTouchMove(touchEvent({ identifier: 1, clientX: 100 + dx, clientY: 100 }), row)
  list.onTouchEnd(touchEvent({ identifier: 1, clientX: 100 + dx, clientY: 100 }), row)
}

describe('useNotifyList 组聚合（P-20261007-23 自组件迁入）', () => {
  it('type/category/title/body/projectName/runtime/action 全同才并组；组代表取最新一条', () => {
    const same = { title: 'dup', category: 'task', runtime: 'claude', body: 'b' }
    const { list } = makeList([
      item({ id: 'newer', ...same }),
      item({ id: 'other', title: 'dup', category: 'task', runtime: 'codex' }), // runtime 不同不并组
      item({ id: 'older', ...same, read: true }),
    ])
    expect(list.groupedItems.value.length).toBe(2)
    const g = list.groupedItems.value[0]!
    expect(g.item.id).toBe('newer') // 代表 = 首条（列表按时间倒序注入）
    expect(g.count).toBe(2)
    expect(g.members.map(m => m.id)).toEqual(['newer', 'older'])
    expect(g.anyUnread).toBe(true)

    // runtime 入键的边界：无 runtime 条目空段聚合行为不变
    const plain = makeList([
      item({ id: 'a', title: 'x' }),
      item({ id: 'b', title: 'x' }),
    ])
    expect(plain.list.groupedItems.value.length).toBe(1)
  })

  it('flatRows：组行 + 已展开组员行；toggleGroup 切换展开态', () => {
    const same = { title: 'dup', category: 'task' }
    const { list } = makeList([
      item({ id: 'a', ...same }),
      item({ id: 'b', ...same }),
      item({ id: 'solo', title: 'solo' }),
    ])
    expect(list.flatRows.value.length).toBe(2) // 两组行

    const dupRow = list.flatRows.value[0]!
    if (dupRow.kind !== 'group') throw new Error('expect group row')
    list.toggleGroup(dupRow.g.key)
    expect(list.flatRows.value.map(r => r.kind === 'group' ? r.g.item.id : r.m.id))
      .toEqual(['a', 'a', 'b', 'solo']) // 组行后跟两名组员
    list.toggleGroup(dupRow.g.key)
    expect(list.flatRows.value.length).toBe(2)
  })

  it('行序收缩时 activeIdx 钳到末行；resetActive 复位', async () => {
    const filtered = ref<NotificationItem[]>([item({ id: 'a' }), item({ id: 'b' })])
    const { list } = makeList(filtered)
    list.resetActive()
    expect(list.activeIdx.value).toBe(0)

    // 单条被清除 → 行数变 1 → activeIdx 钳制
    list.activeIdx.value = 5
    filtered.value = [item({ id: 'a' })]
    await nextTick()
    expect(list.activeIdx.value).toBe(0)
  })
})

describe('useNotifyList 激活语义（键盘导航与行点击共用链）', () => {
  it('有动作条目 → store.handleClick；无动作未读 → markRead；已读无动作不重复标', () => {
    const { list, store } = makeList([
      item({ id: 'act', action: 'terminal' }),
      item({ id: 'unread' }),
      item({ id: 'read', read: true }),
    ])
    const rows = list.flatRows.value
    list.activateItem(rows[0]!.kind === 'group' ? rows[0]!.g.item : rows[0]!.m)
    expect(store.handleClick).toHaveBeenCalled()
    expect(store.markRead).not.toHaveBeenCalled()

    list.activateItem(rows[1]!.kind === 'group' ? rows[1]!.g.item : rows[1]!.m)
    expect(store.markRead).toHaveBeenCalledWith('unread')

    list.activateItem(rows[2]!.kind === 'group' ? rows[2]!.g.item : rows[2]!.m)
    expect(store.markRead).toHaveBeenCalledTimes(1)
  })

  it('activateRow：组行点击展开/单条激活；多选模式让位勾选切换', () => {
    const same = { title: 'dup', category: 'task' }
    const { list, toggleRowSelection } = makeList([
      item({ id: 'a', ...same }),
      item({ id: 'b', ...same }),
      item({ id: 'solo', title: 'solo' }),
    ])
    const dup = list.flatRows.value[0]!
    const solo = list.flatRows.value[1]!
    if (dup.kind !== 'group' || solo.kind !== 'group') throw new Error('expect group rows')

    list.activateRow(dup)
    expect(list.flatRows.value.length).toBe(4) // 展开出全部组员（组行+2 组员+solo）
    list.activateRow(solo)
    // 单条组行激活 = activateItem（solo 无动作未读 → markRead 由上方用例覆盖，此处不重复断言）

    // 多选模式：激活语义让位勾选切换（组行整组）
    list.toggleGroup(dup.g.key) // 收起，保持行序可预测
    const selectMode = ref(true)
    const second = makeList(
      [item({ id: 'a', ...same }), item({ id: 'b', ...same })],
      { selectMode, toggleRowSelection },
    )
    const row = second.list.flatRows.value[0]!
    second.list.activateRow(row)
    expect(toggleRowSelection).toHaveBeenCalledWith(row)
    expect(second.store.markRead).not.toHaveBeenCalled()
  })

  it('resetOn 源变更 → activeIdx 归零（过滤维/免打扰视图变更的既有惯例）', async () => {
    const resetOn = ref(0)
    const { list } = makeList([item({ id: 'a' }), item({ id: 'b' })], { resetOn: [resetOn] })
    list.activeIdx.value = 1
    resetOn.value++
    await nextTick()
    expect(list.activeIdx.value).toBe(0)
  })
})

describe('useNotifyList 触屏滑动（P-98 自组件迁入）', () => {
  it('右滑未读 → 标已读；左滑已读 → 清除；未读不可左滑清除', () => {
    const { list, store } = makeList([item({ id: 'unread' }), item({ id: 'read', read: true })])
    const rows = list.flatRows.value
    const unreadRow = rows[0]!
    const readRow = rows[1]!

    swipe(list, unreadRow, 70) // 右滑 ≥60px
    expect(store.markRead).toHaveBeenCalledWith('unread')
    expect(store.dismiss).not.toHaveBeenCalled()

    swipe(list, readRow, -70) // 左滑 ≥60px（已读才可清）
    expect(store.dismiss).toHaveBeenCalledWith('read')

    swipe(list, unreadRow, -70) // 未读横扫不误删
    expect(store.dismiss).not.toHaveBeenCalledWith('unread')
  })

  it('位移不足阈值不分发；纵向为主让位原生滚动；多成员组行不启手势', () => {
    const { list, store } = makeList([
      item({ id: 'a', title: 'dup' }),
      item({ id: 'b', title: 'dup' }),
    ])
    const groupRow = list.flatRows.value[0]!
    if (groupRow.kind !== 'group') throw new Error('expect group row')

    swipe(list, groupRow, 90) // 组行（count>1）禁用手势
    expect(store.markRead).not.toHaveBeenCalled()
    expect(store.dismiss).not.toHaveBeenCalled()

    // 单条组行：小幅位移（<60px）不分发
    const solo = makeList([item({ id: 'solo' })])
    swipe(solo.list, solo.list.flatRows.value[0]!, 30)
    expect(solo.store.markRead).not.toHaveBeenCalled()

    // 纵向为主：不建立横向手势、不分发动作
    const vert = makeList([item({ id: 'v' })])
    const row = vert.list.flatRows.value[0]!
    vert.list.onTouchStart(touchEvent({ identifier: 2, clientX: 100, clientY: 100 }), row)
    vert.list.onTouchMove(touchEvent({ identifier: 2, clientX: 102, clientY: 160 }), row)
    vert.list.onTouchEnd(touchEvent({ identifier: 2, clientX: 102, clientY: 160 }), row)
    expect(vert.store.markRead).not.toHaveBeenCalled()

    // 手势视觉：横向手势中行体跟手位移，结束即回弹（undefined）
    const hor = makeList([item({ id: 'h' })])
    const hRow = hor.list.flatRows.value[0]!
    hor.list.onTouchStart(touchEvent({ identifier: 3, clientX: 100, clientY: 100 }), hRow)
    hor.list.onTouchMove(touchEvent({ identifier: 3, clientX: 140, clientY: 100 }), hRow)
    expect(hor.list.swipeStyle(hRow)).toBe('transform: translateX(40px)')
    expect(hor.list.isSwiping(hRow)).toBe(true)
    hor.list.onTouchEnd(touchEvent({ identifier: 3, clientX: 140, clientY: 100 }), hRow)
    expect(hor.list.swipeStyle(hRow)).toBeUndefined()
    expect(hor.list.isSwiping(hRow)).toBe(false)
  })
})
