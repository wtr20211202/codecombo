import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

// ── mock 边界：safeStorage（Map 兜底，同 useNotifyFilterPrefs.test.ts 形态）
// + vue-i18n/naive-ui（naiveRuntime 一站式工厂，t=key 直通；confirmDialog 走
// discrete dialog 记录器，按钮回调现场触发resolve）──
const backing = vi.hoisted(() => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
})

vi.mock('../utils/storage', () => ({ safeStorage: backing }))
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()))
vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()))

import { dialogMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'
import type { NotificationItem } from '../api/client'
import { useNotifyFilters } from './useNotifyFilters'

function item(partial: Partial<NotificationItem> & { id: string }): NotificationItem {
  return {
    type: 'info', category: 'system', title: `n-${partial.id}`, time: '2026-10-24T10:00:00Z', read: false,
    ...partial,
  }
}

function makeStore(items: NotificationItem[]) {
  return {
    items: ref(items),
    isSnoozed: (n: NotificationItem) => !!n.snoozeUntil,
    clear: vi.fn(),
    dismissMany: vi.fn(),
  }
}

/** 触发 confirmDialog 桩的按钮回调（记录器第 N 次 warning 调用的回调集） */
function confirmResolve(which: 'positive' | 'negative'): void {
  const opts = dialogMock.warning.mock.calls.at(-1)?.[0] as Record<string, () => void>
  opts[which === 'positive' ? 'onPositiveClick' : 'onNegativeClick']!()
}

beforeEach(() => {
  backing.clear()
  resetNaiveRuntimeMocks()
})

describe('useNotifyFilters 三维过滤流水线（P-20261007-23 自组件迁入）', () => {
  it('分类/项目/runtime 三维正交 AND 叠加；无 runtime 条目穿透 runtime 过滤', () => {
    const store = makeStore([
      item({ id: 'a', category: 'error', projectId: 'p1', projectName: 'P1', read: false, runtime: 'claude' }),
      item({ id: 'b', category: 'error', projectId: 'p2', projectName: 'P2', read: false, runtime: 'codex' }),
      item({ id: 'c', category: 'task', projectId: 'p1', projectName: 'P1', read: false }), // 无 runtime
      item({ id: 'd', category: 'git', read: true }), // 无归属项目
    ])
    const { activeFilter, activeProject, activeRuntime, filteredItems, runtimeOptions, projectOptions } =
      useNotifyFilters({ store, dnd: { dndOnly: ref(false), inDndWindow: () => true } })

    expect(filteredItems.value.map(n => n.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(projectOptions.value.map(o => o.id)).toEqual(['p1', 'p2'])
    expect(runtimeOptions.value).toEqual(['claude', 'codex'])

    activeFilter.value = 'error'
    expect(filteredItems.value.map(n => n.id)).toEqual(['a', 'b'])
    activeProject.value = 'p1'
    expect(filteredItems.value.map(n => n.id)).toEqual(['a'])
    activeRuntime.value = 'claude'
    expect(filteredItems.value.map(n => n.id)).toEqual(['a'])

    // 只选 runtime：无归属条目（c/d 均「记录无 runtime」）不被藏掉
    activeFilter.value = 'all'
    activeProject.value = ''
    expect(filteredItems.value.map(n => n.id)).toEqual(['a', 'c', 'd'])
  })

  it('延后维：延后中条目只入「已延后」页签，常规流隐藏', () => {
    const store = makeStore([
      item({ id: 'a', snoozeUntil: '2026-10-25T10:00:00Z' }),
      item({ id: 'b' }),
    ])
    const { activeFilter, filteredItems } =
      useNotifyFilters({ store, dnd: { dndOnly: ref(false), inDndWindow: () => true } })
    expect(filteredItems.value.map(n => n.id)).toEqual(['b'])
    activeFilter.value = 'snoozed'
    expect(filteredItems.value.map(n => n.id)).toEqual(['a'])
  })

  it('dnd gate：dndOnly 时流水线末端仅留窗口内条目（叠加在分类维之上）', () => {
    const store = makeStore([
      item({ id: 'in', category: 'error' }),
      item({ id: 'out', category: 'error' }),
    ])
    const { activeFilter, filteredItems } = useNotifyFilters({
      store,
      dnd: { dndOnly: ref(true), inDndWindow: n => n.id === 'in' },
    })
    activeFilter.value = 'error'
    expect(filteredItems.value.map(n => n.id)).toEqual(['in'])
  })

  it('页签计数：未读=未读且未延后，已延后=延后数，分类=该类总数（延后中不计分类）；runtime 叠加按子集', () => {
    const store = makeStore([
      item({ id: 'a', category: 'error', read: false, runtime: 'claude' }),
      item({ id: 'b', category: 'error', read: true, runtime: 'codex' }),
      item({ id: 'c', category: 'git', read: false, snoozeUntil: '2026-10-25T10:00:00Z' }),
    ])
    const { activeRuntime, filterCounts } = useNotifyFilters({
      store, dnd: { dndOnly: ref(false), inDndWindow: () => true },
    })
    expect(filterCounts.value).toMatchObject({ unread: 1, snoozed: 1, error: 2 })
    expect(filterCounts.value.git).toBeUndefined() // 延后中的条目不入分类计数
    activeRuntime.value = 'claude'
    // c（无 runtime）穿透 runtime 过滤：仍在子集里，snoozed 计数不消失
    expect(filterCounts.value).toMatchObject({ unread: 1, snoozed: 1, error: 1 })
  })

  it('候选对账回落：项目条目清空 → activeProject 回落「全部」；runtime 候选消失同口径', async () => {
    const store = makeStore([item({ id: 'a', projectId: 'p1', runtime: 'claude' })])
    const { activeProject, activeRuntime } = useNotifyFilters({
      store, dnd: { dndOnly: ref(false), inDndWindow: () => true },
    })
    activeProject.value = 'p1'
    activeRuntime.value = 'claude'
    await nextTick()
    expect(backing.getItem('notify-filter')).toBeTruthy() // 选择已落盘

    store.items.value = [] // 项目/runtime 候选随之消失
    await nextTick()
    expect(activeProject.value).toBe('')
    expect(activeRuntime.value).toBe('')
    await nextTick()
    // 回落态写回持久层：陈旧选择不复活（P-173 契约）
    expect(backing.getItem('notify-filter')).toBe(JSON.stringify({ filter: 'all', project: '', runtime: '' }))
  })

  it('持久化恢复：合法存档原样起步，无效页签键回落 all', () => {
    backing.setItem('notify-filter', JSON.stringify({ filter: 'error', project: 'p1', runtime: 'codex' }))
    const { activeFilter, activeProject, activeRuntime } = useNotifyFilters({
      store: makeStore([]), dnd: { dndOnly: ref(false), inDndWindow: () => true },
    })
    expect(activeFilter.value).toBe('error')
    expect(activeProject.value).toBe('p1')
    expect(activeRuntime.value).toBe('codex')

    backing.setItem('notify-filter', JSON.stringify({ filter: 'bogus', project: '', runtime: '' }))
    const second = useNotifyFilters({ store: makeStore([]), dnd: { dndOnly: ref(false), inDndWindow: () => true } })
    expect(second.activeFilter.value).toBe('all')
  })

  it('清空语义：无任何过滤 = clear 全量；任一过滤生效 = 只清当前筛选结果', async () => {
    const store = makeStore([
      item({ id: 'a', category: 'error', projectId: 'p1' }),
      item({ id: 'b', category: 'git' }),
    ])
    const f = useNotifyFilters({ store, dnd: { dndOnly: ref(false), inDndWindow: () => true } })

    // 全部视图：确认后走 store.clear
    expect(f.clearTitle.value).toBe('notification.clearAll')
    void f.clearCurrent()
    await vi.waitFor(() => expect(dialogMock.warning).toHaveBeenCalled())
    confirmResolve('positive')
    await vi.waitFor(() => expect(store.clear).toHaveBeenCalled())

    // error 页签：确认后走 dismissMany 且只带可见条目
    store.clear.mockClear()
    store.dismissMany.mockClear()
    f.activeFilter.value = 'error'
    expect(f.clearTitle.value).toBe('notification.clearFiltered:{"n":1}')
    void f.clearCurrent()
    await vi.waitFor(() => expect(dialogMock.warning).toHaveBeenCalledTimes(2))
    confirmResolve('negative') // 取消：不动
    await vi.waitFor(() => expect(store.dismissMany).not.toHaveBeenCalled())
    void f.clearCurrent()
    await vi.waitFor(() => expect(dialogMock.warning).toHaveBeenCalledTimes(3))
    confirmResolve('positive')
    await vi.waitFor(() => expect(store.dismissMany).toHaveBeenCalledWith(['a']))
    expect(store.clear).not.toHaveBeenCalled()
  })

  it('列表为空时清空动作直接短路（不弹确认）', async () => {
    const store = makeStore([])
    const { clearCurrent } = useNotifyFilters({ store, dnd: { dndOnly: ref(false), inDndWindow: () => true } })
    await clearCurrent()
    expect(dialogMock.warning).not.toHaveBeenCalled()
  })
})
