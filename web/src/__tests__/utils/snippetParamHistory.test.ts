import { describe, it, expect } from 'vitest'
import {
  SNIPPET_PARAM_HISTORY_KEY,
  SNIPPET_PARAM_HISTORY_MAX,
  loadSnippetParamHistory,
  saveSnippetParamHistory,
  recordSnippetParamValues,
  rememberSnippetParamValues,
  type SnippetParamHistory,
} from '@/utils/snippetParamHistory'

describe('recordSnippetParamValues（纯函数）', () => {
  it('合并非空白值；空白值不入史', () => {
    const h = recordSnippetParamValues({}, 's1', { host: 'web1', note: '  ', blank: '' })
    expect(h.s1).toEqual({ host: 'web1' })
  })

  it('同片段重复确认：新值覆盖旧值、其他片段不受影响', () => {
    let h = recordSnippetParamValues({}, 's1', { host: 'web1' })
    h = recordSnippetParamValues(h, 's2', { host: 'db1' })
    h = recordSnippetParamValues(h, 's1', { host: 'web2' })
    expect(h.s1).toEqual({ host: 'web2' })
    expect(h.s2).toEqual({ host: 'db1' })
  })

  it('全空白值不动历史（不产生空片段条目、不刷新 LRU 位次）', () => {
    const before: SnippetParamHistory = { s1: { a: '1' }, s2: { b: '2' } }
    expect(recordSnippetParamValues(before, 's1', { a: ' ' })).toBe(before)
    expect(recordSnippetParamValues(before, 's9', {})).toBe(before)
  })

  it('超上限按 LRU 淘汰最久未确认的片段；刚确认的不被挤出', () => {
    let h: SnippetParamHistory = {}
    for (let i = 0; i < SNIPPET_PARAM_HISTORY_MAX; i++) {
      h = recordSnippetParamValues(h, `s${i}`, { v: String(i) })
    }
    // 刷新最旧片段 s0 → 仍在上限内、存活
    h = recordSnippetParamValues(h, 's0', { v: 'refreshed' })
    expect(h.s0).toEqual({ v: 'refreshed' })
    expect(h.s1).toBeDefined()
    // 插入第 51 个新片段 → 淘汰此刻最久未确认的 s1，s0 因刚刷新存活
    h = recordSnippetParamValues(h, 's-new', { v: 'x' })
    expect(h.s1).toBeUndefined()
    expect(h.s0).toEqual({ v: 'refreshed' })
    expect(h['s-new']).toEqual({ v: 'x' })
    expect(Object.keys(h)).toHaveLength(SNIPPET_PARAM_HISTORY_MAX)
  })
})

describe('load/save（safeStorage 持久化）', () => {
  it('remember 落库后 load 读回一致', () => {
    rememberSnippetParamValues('snip-1', { host: 'web1', tag: 'v2' })
    expect(loadSnippetParamHistory()['snip-1']).toEqual({ host: 'web1', tag: 'v2' })
    expect(JSON.parse(localStorage.getItem(SNIPPET_PARAM_HISTORY_KEY) || '{}')).toHaveProperty('snip-1')
  })

  it('损坏 JSON / 非法结构逐条丢弃不抛错', () => {
    localStorage.setItem(SNIPPET_PARAM_HISTORY_KEY, '{oops')
    expect(loadSnippetParamHistory()).toEqual({})
    localStorage.setItem(SNIPPET_PARAM_HISTORY_KEY, JSON.stringify({
      good: { a: '1', bad: 42, empty: '' },
      arr: ['x'],
      num: 3,
    }))
    expect(loadSnippetParamHistory()).toEqual({ good: { a: '1' } })
  })

  it('save 写入的 map 原样读回', () => {
    saveSnippetParamHistory({ s: { k: 'v' } })
    expect(loadSnippetParamHistory()).toEqual({ s: { k: 'v' } })
  })
})
