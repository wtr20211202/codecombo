import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMPACT_TOPBAR_BREAKPOINT,
  NARROW_BREAKPOINT,
  resetNarrowLayoutForTests,
  useNarrowLayout,
} from '../../composables/useNarrowLayout'

/**
 * 窄屏形态组合式（P-20261019-7）：断点判定与只读编辑态的安全复位。
 * jsdom 没有 matchMedia，这里用按 query 分桶的可手动派发桩，锁住：
 *   - 700/900 两个断点各自独立（紧凑顶栏不连带窄屏工作区）；
 *   - 进入窄屏时编辑态复位为只读默认；
 *   - 显式 toggle 在窄屏内保持。
 */

type Listener = (event: MediaQueryListEvent) => void
interface QueryState { matches: boolean; listeners: Set<Listener> }

const queries = new Map<string, QueryState>()
const NARROW_QUERY = `(max-width: ${NARROW_BREAKPOINT}px)`
const COMPACT_QUERY = `(max-width: ${COMPACT_TOPBAR_BREAKPOINT}px)`

function installMatchMedia(values: Record<string, boolean>): void {
  queries.clear()
  vi.stubGlobal('matchMedia', (query: string) => {
    const state: QueryState = { matches: values[query] ?? false, listeners: new Set() }
    queries.set(query, state)
    return {
      get matches(): boolean { return state.matches },
      media: query,
      addEventListener: (_type: string, cb: Listener) => state.listeners.add(cb),
      removeEventListener: (_type: string, cb: Listener) => state.listeners.delete(cb),
      addListener: (cb: Listener) => state.listeners.add(cb),
      removeListener: (cb: Listener) => state.listeners.delete(cb),
    }
  })
}

function setQuery(query: string, matches: boolean): void {
  const state = queries.get(query)
  if (!state) throw new Error(`未安装的媒体查询：${query}`)
  state.matches = matches
  for (const cb of state.listeners) cb({ matches } as MediaQueryListEvent)
}

beforeEach(() => {
  resetNarrowLayoutForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useNarrowLayout 断点', () => {
  it('宽屏：700/900 均不命中 → narrow 与 compactTopbar 均为 false', () => {
    installMatchMedia({ [NARROW_QUERY]: false, [COMPACT_QUERY]: false })
    const { narrow, compactTopbar } = useNarrowLayout()
    expect(narrow.value).toBe(false)
    expect(compactTopbar.value).toBe(false)
  })

  it('平板档（701~900）：仅 compactTopbar 命中，工作区仍是桌面形态', () => {
    installMatchMedia({ [NARROW_QUERY]: false, [COMPACT_QUERY]: true })
    const { narrow, compactTopbar } = useNarrowLayout()
    expect(narrow.value).toBe(false)
    expect(compactTopbar.value).toBe(true)
  })

  it('窄屏档（≤700）：两个断点都命中，且响应媒体查询实时翻转', async () => {
    installMatchMedia({ [NARROW_QUERY]: true, [COMPACT_QUERY]: true })
    const { narrow, compactTopbar } = useNarrowLayout()
    expect(narrow.value).toBe(true)
    expect(compactTopbar.value).toBe(true)

    setQuery(NARROW_QUERY, false)
    await nextTick()
    expect(narrow.value).toBe(false)
  })
})

describe('窄屏编辑态', () => {
  it('进入窄屏即复位只读；窄屏内显式切换保持', async () => {
    installMatchMedia({ [NARROW_QUERY]: false, [COMPACT_QUERY]: false })
    const { narrow, narrowEditorEditing, toggleNarrowEditorEditing } = useNarrowLayout()
    toggleNarrowEditorEditing()
    expect(narrowEditorEditing.value).toBe(true)

    // 进入窄屏：安全默认复位只读
    setQuery(NARROW_QUERY, true)
    await nextTick()
    expect(narrow.value).toBe(true)
    expect(narrowEditorEditing.value).toBe(false)

    // 窄屏内用户显式切编辑：保持
    toggleNarrowEditorEditing()
    expect(narrowEditorEditing.value).toBe(true)

    // 离开再进入：重新回到只读默认
    setQuery(NARROW_QUERY, false)
    await nextTick()
    setQuery(NARROW_QUERY, true)
    await nextTick()
    expect(narrowEditorEditing.value).toBe(false)
  })
})
