import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { useTerminalSearch } from '@/composables/useTerminalSearch'
import type { TermInstance } from '@/composables/useTerminalInstances'
import type { Terminal } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'

// ── mock 边界：只隔离 safeStorage（Map 兜底语义同 utils/storage 的内存路径），
// 查询历史（P-20261004-109）的落盘断言与跨用例隔离都走它 ──
const backing = vi.hoisted(() => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
})

vi.mock('@/utils/storage', () => ({
  safeStorage: backing,
}))

// 选中词预填（P-20261004-87）：openSearch 读当前终端选区——非空即预填查询词并
// 立即首搜（跳过输入防抖），多行取首行、剥首尾空白、超长截断。用最小 xterm 桩
// （getSelection + buffer.active 行扫描）直接驱动 composable 断言状态与 addon 调用。

/** 最小 xterm 实例桩：makeHarness（静态导入）与历史域 fresh 桩共用，避免桩体双份 */
function makeInst(selection: string, bufferLines: string[]) {
  const findNext = vi.fn()
  const findPrevious = vi.fn()
  const inst = {
    term: {
      getSelection: () => selection,
      buffer: {
        active: {
          length: bufferLines.length,
          getLine: (i: number) =>
            i >= 0 && i < bufferLines.length
              ? { translateToString: () => bufferLines[i] }
              : null,
        },
      },
    } as unknown as Terminal,
    search: { findNext, findPrevious, clearActiveDecoration: vi.fn() } as unknown as SearchAddon,
  } as unknown as TermInstance
  return { inst, findNext, findPrevious }
}

function makeHarness(selection: string, bufferLines: string[] = ['hello SCXYZ world SCXYZ']) {
  const { inst, findNext, findPrevious } = makeInst(selection, bufferLines)
  const api = useTerminalSearch({
    termInstances: new Map([['s1', inst]]),
    getActiveTabId: () => 's1',
  })
  return { api, findNext, findPrevious }
}

describe('useTerminalSearch 选中词预填（P-20261004-87）', () => {
  it('有选区打开：预填查询词 + 立即首搜 + 计数同步（不走输入防抖）', () => {
    const { api, findNext } = makeHarness('SCXYZ')
    api.openSearch()
    expect(api.searchQuery.value).toBe('SCXYZ')
    expect(api.showSearch.value).toBe(true)
    expect(findNext).toHaveBeenCalledTimes(1)
    expect(findNext).toHaveBeenCalledWith('SCXYZ', { caseSensitive: false, regex: false })
    expect(api.searchResultCount.value).toBe(2)
  })

  it('无选区打开：空框照旧（既有行为零回归），不触发首搜', () => {
    const { api, findNext } = makeHarness('')
    api.openSearch()
    expect(api.searchQuery.value).toBe('')
    expect(api.searchResultCount.value).toBeNull()
    expect(findNext).not.toHaveBeenCalled()
  })

  it('多行选区取首行（行内搜索语义）：跨行部分不进查询词', () => {
    const { api, findNext } = makeHarness('first-token tail\nsecond line here')
    api.openSearch()
    expect(api.searchQuery.value).toBe('first-token tail')
    expect(findNext).toHaveBeenCalledWith('first-token tail', { caseSensitive: false, regex: false })
  })

  it('首尾空白剥离；纯空白/换行选区视为无选区', () => {
    const { api, findNext } = makeHarness('  SCXYZ  ')
    api.openSearch()
    expect(api.searchQuery.value).toBe('SCXYZ')

    const blank = makeHarness('   \n   ')
    blank.api.openSearch()
    expect(blank.api.searchQuery.value).toBe('')
    expect(blank.findNext).not.toHaveBeenCalled()
  })

  it('超长选区截断到预填上限：截断只影响默认值，不炸输入框', () => {
    const long = 'x'.repeat(250)
    const { api, findNext } = makeHarness(`  ${long}  `)
    api.openSearch()
    expect(api.searchQuery.value).toBe('x'.repeat(200))
    expect(findNext).toHaveBeenCalledWith('x'.repeat(200), { caseSensitive: false, regex: false })
  })

  it('选区合法性不改变既有链路：预填后 closeSearch 清计数与装饰', () => {
    const { api } = makeHarness('SCXYZ')
    api.openSearch()
    expect(api.searchResultCount.value).toBe(2)
    api.closeSearch()
    expect(api.showSearch.value).toBe(false)
    expect(api.searchResultCount.value).toBeNull()
  })
})

// ── 查询历史（P-20261004-109）：历史域是按通道键的模块单例，跨用例复位走
// resetModules + 动态重取（useSearchHistory.test.ts 同式）；交互语义沿 P-48 惯例 ──

/** 历史域专属 fresh 桩：复位模块图后动态取 composable，历史从零起步 */
async function freshHistoryHarness(selection = '', bufferLines: string[] = ['hello SCXYZ world SCXYZ']) {
  vi.resetModules()
  const m = await import('@/composables/useTerminalSearch')
  const { inst, findNext, findPrevious } = makeInst(selection, bufferLines)
  const api = m.useTerminalSearch({
    termInstances: new Map([['s1', inst]]),
    getActiveTabId: () => 's1',
  })
  return { api, findNext, findPrevious }
}

beforeEach(() => {
  backing.clear()
})

describe('useTerminalSearch 查询历史（P-20261004-109）', () => {
  it('commitSearch 记录承诺词（去重置顶）+ 环形 5 条 + 独立通道落盘', async () => {
    const { api } = await freshHistoryHarness()
    api.searchQuery.value = 'error8080'
    api.commitSearch('next')
    api.searchQuery.value = 'timeout'
    api.commitSearch('next')
    api.searchQuery.value = 'error8080'
    api.commitSearch('next')
    api.searchQuery.value = ''
    expect(api.historyItems.value).toEqual(['error8080', 'timeout'])
    expect(backing.getItem('terminal-search-history')).toBe(
      JSON.stringify(['error8080', 'timeout']),
    )
    for (let i = 0; i < 6; i++) {
      api.searchQuery.value = `t${i}`
      api.commitSearch('next')
    }
    api.searchQuery.value = ''
    expect(api.historyItems.value.length).toBe(5)
    expect(api.historyItems.value[0]).toBe('t5')
    expect(api.historyItems.value).not.toContain('t0')
  })

  it('closeSearch 落账框内词；空查询关闭零副作用', async () => {
    const { api } = await freshHistoryHarness()
    api.openSearch()
    api.searchQuery.value = 'panic'
    api.closeSearch()
    expect(backing.getItem('terminal-search-history')).toBe(JSON.stringify(['panic']))
    api.openSearch()
    api.closeSearch()
    expect(backing.getItem('terminal-search-history')).toBe(JSON.stringify(['panic']))
  })

  it('前缀过滤大小写不敏感；过滤全空给空态提示', async () => {
    const { api } = await freshHistoryHarness()
    for (const term of ['ParseError', 'parseOpts', 'unrelated']) {
      api.searchQuery.value = term
      api.commitSearch('next')
    }
    api.searchQuery.value = 'PAR'
    expect(api.historyItems.value).toEqual(['parseOpts', 'ParseError'])
    api.searchQuery.value = 'zzz'
    expect(api.historyItems.value).toEqual([])
    api.onSearchInputFocus()
    expect(api.historyAllFilteredOut.value).toBe(true)
  })

  it('Esc 分层：下拉开着先收下拉（搜索条保留），再按才关搜索条', async () => {
    const { api } = await freshHistoryHarness()
    api.openSearch()
    api.onSearchInputFocus()
    api.searchQuery.value = 'err'
    api.commitSearch('next')
    // 提交后输入仍聚焦且前缀命中历史 → 下拉开着（P-48 同款状态）
    expect(api.historyVisible.value).toBe(true)
    api.onSearchEscape()
    expect(api.historyVisible.value).toBe(false)
    expect(api.showSearch.value).toBe(true)
    api.onSearchEscape()
    expect(api.showSearch.value).toBe(false)
  })

  it('回填即搜：点选绕输入链直接 findNext，下拉收起且不因回填重开', async () => {
    const { api, findNext } = await freshHistoryHarness()
    api.onSearchInputFocus()
    api.searchQuery.value = 'port'
    api.commitSearch('next')
    api.searchQuery.value = 'timeout'
    await nextTick()
    expect(api.historyVisible.value).toBe(true)
    api.applyHistory('port')
    expect(api.searchQuery.value).toBe('port')
    expect(findNext).toHaveBeenLastCalledWith('port', { caseSensitive: false, regex: false })
    expect(api.historyVisible.value).toBe(false)
    await nextTick()
    // watch(searchQuery) 的重开被 suppress 消化：回填后补全不回弹
    expect(api.historyVisible.value).toBe(false)
  })

  it('预填 × 历史并存互不扰（P-20261004-87 交接）：预填打开不弹下拉，点击可重新唤出', async () => {
    const { api } = await freshHistoryHarness('SCXYZ')
    api.openSearch()
    api.searchQuery.value = 'oldterm'
    api.closeSearch()
    // 带选区再开：预填 + 首搜照旧（P-87 语义零回归），且历史下拉不弹出
    api.openSearch()
    expect(api.searchQuery.value).toBe('SCXYZ')
    await nextTick()
    await nextTick()
    expect(api.historyVisible.value).toBe(false)
    // 点击输入框重新唤出（前缀 scxyz 无匹配 → 空态提示，下拉本体仍在）
    api.onSearchInputFocus()
    expect(api.historyVisible.value).toBe(true)
    expect(api.historyAllFilteredOut.value).toBe(true)
    // 预填词随 closeSearch 落账：搜过即承诺，与显式输入同口径
    api.closeSearch()
    expect(backing.getItem('terminal-search-history')).toBe(JSON.stringify(['SCXYZ', 'oldterm']))
  })
})
