import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock 边界：只隔离 safeStorage（Map 兜底语义同 utils/storage 的内存路径），
// composable 本体零外部依赖，直接真身跑 ──
const backing = vi.hoisted(() => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
})

vi.mock('../utils/storage', () => ({
  safeStorage: backing,
}))

import type { useSearchHistory as UseSearchHistory, SearchHistoryOptions } from './useSearchHistory'

/** 模块单例（history 为模块级状态）跨用例复位：resetModules + 动态重取 */
async function fresh(options?: Partial<SearchHistoryOptions>): Promise<ReturnType<typeof UseSearchHistory>> {
  vi.resetModules()
  const m = await import('./useSearchHistory')
  return m.useSearchHistory(options)
}

beforeEach(() => {
  backing.clear()
})

describe('useSearchHistory 项目搜索查询历史（P-20261003-48）', () => {
  it('recordQuery 去重置顶：重复查询移到最近位，不产生双条目', async () => {
    const h = await fresh()
    h.recordQuery('foo')
    h.recordQuery('bar')
    h.recordQuery('foo')
    expect(h.history.value).toEqual(['foo', 'bar'])
    expect(backing.getItem('project-search-history')).toBe(JSON.stringify(['foo', 'bar']))
  })

  it('recordQuery 环形 ≤15：超容裁最旧；空白串忽略；写入前 trim', async () => {
    const h = await fresh()
    for (let i = 0; i < 16; i++) h.recordQuery(`term-${i} `)
    expect(h.history.value.length).toBe(15)
    expect(h.history.value[0]).toBe('term-15')
    expect(h.history.value).not.toContain('term-0')
    h.recordQuery('   ')
    expect(h.history.value.length).toBe(15)
  })

  it('filterByPrefix 大小写不敏感前缀匹配；空前缀返回全部', async () => {
    const h = await fresh()
    h.recordQuery('ParseError')
    h.recordQuery('parseOpts')
    h.recordQuery('unrelated')
    expect(h.filterByPrefix('PAR')).toEqual(['parseOpts', 'ParseError'])
    expect(h.filterByPrefix('  parse ')).toEqual(['parseOpts', 'ParseError'])
    expect(h.filterByPrefix('')).toEqual(['unrelated', 'parseOpts', 'ParseError'])
    expect(h.filterByPrefix('zzz')).toEqual([])
  })

  it('clearHistory 内存态与持久层同清', async () => {
    const h = await fresh()
    h.recordQuery('foo')
    expect(backing.getItem('project-search-history')).not.toBeNull()
    h.clearHistory()
    expect(h.history.value).toEqual([])
    expect(backing.getItem('project-search-history')).toBeNull()
  })

  it('脏存储容错：非 JSON / 非字符串数组 → 空历史起步', async () => {
    backing.setItem('project-search-history', '{not-json')
    let h = await fresh()
    expect(h.history.value).toEqual([])

    backing.setItem('project-search-history', JSON.stringify(['ok', 3, null, '  ']))
    h = await fresh()
    expect(h.history.value).toEqual(['ok'])
  })
})

describe('useSearchHistory 多域参数化（P-20261004-109）', () => {
  it('自定义通道键与容量：终端域独立落盘、环形 5 条，与项目搜索域互不串味', async () => {
    const p = await fresh()
    p.recordQuery('proj-term')
    const t = await fresh({ storageKey: 'terminal-search-history', maxHistory: 5 })
    t.recordQuery('t0 ')
    for (let i = 1; i <= 6; i++) t.recordQuery(`t${i}`)
    expect(t.history.value.length).toBe(5)
    expect(t.history.value[0]).toBe('t6')
    expect(t.history.value).not.toContain('t0')
    // 写入走自己的通道键，不触碰缺省域的通道
    expect(backing.getItem('terminal-search-history')).toBe(
      JSON.stringify(['t6', 't5', 't4', 't3', 't2']),
    )
    expect(backing.getItem('project-search-history')).toBe(JSON.stringify(['proj-term']))
  })

  it('同键共享同一份内存态：多消费者（多终端 pane）记录互相可见', async () => {
    vi.resetModules()
    const m = await import('./useSearchHistory')
    const a = m.useSearchHistory({ storageKey: 'terminal-search-history', maxHistory: 5 })
    const b = m.useSearchHistory({ storageKey: 'terminal-search-history', maxHistory: 5 })
    a.recordQuery('shared')
    expect(b.history.value).toEqual(['shared'])
    expect(b.filterByPrefix('sha')).toEqual(['shared'])
  })

  it('自定义域的 clearHistory 只清自己的通道', async () => {
    const p = await fresh()
    p.recordQuery('keep-me')
    const t = await fresh({ storageKey: 'terminal-search-history', maxHistory: 5 })
    t.recordQuery('drop-me')
    t.clearHistory()
    expect(t.history.value).toEqual([])
    expect(backing.getItem('terminal-search-history')).toBeNull()
    expect(backing.getItem('project-search-history')).toBe(JSON.stringify(['keep-me']))
  })
})
