import { describe, it, expect } from 'vitest'
import {
  RUNBOOK_PARAM_HISTORY_KEY,
  RUNBOOK_PARAM_VALUES_MAX,
  RUNBOOK_PARAM_HISTORY_MAX,
  loadRunbookParamHistory,
  saveRunbookParamHistory,
  recordRunbookParamValues,
  filterRunbookParamValues,
  clearRunbookParamValues,
  rememberRunbookParamValues,
  forgetRunbookParamValues,
  type RunbookParamHistory,
} from '@/utils/runbookParamHistory'

describe('recordRunbookParamValues（纯函数）', () => {
  it('非空白值入史；空白值跳过', () => {
    const h = recordRunbookParamValues({}, 'b1', { branch: 'main', note: '  ', blank: '' })
    expect(h.b1).toEqual({ branch: ['main'] })
  })

  it('环形去重置顶：重复提交同名值不产生重复条目、移到最新位', () => {
    let h = recordRunbookParamValues({}, 'b1', { branch: 'main' })
    h = recordRunbookParamValues(h, 'b1', { branch: 'feat' })
    h = recordRunbookParamValues(h, 'b1', { branch: 'main' })
    expect(h.b1.branch).toEqual(['main', 'feat'])
  })

  it('环形裁剪：超过每参数上限丢最旧值', () => {
    let h: RunbookParamHistory = {}
    for (const v of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']) {
      h = recordRunbookParamValues(h, 'b1', { tag: v })
    }
    expect(h.b1.tag).toEqual(['v6', 'v5', 'v4', 'v3', 'v2'])
    expect(h.b1.tag).toHaveLength(RUNBOOK_PARAM_VALUES_MAX)
  })

  it('同名参数其他书的环形互不影响；跨参数互不影响', () => {
    let h = recordRunbookParamValues({}, 'b1', { branch: 'main', env: 'prod' })
    h = recordRunbookParamValues(h, 'b2', { branch: 'dev' })
    h = recordRunbookParamValues(h, 'b1', { branch: 'hotfix' })
    expect(h.b1.branch).toEqual(['hotfix', 'main'])
    expect(h.b1.env).toEqual(['prod'])
    expect(h.b2.branch).toEqual(['dev'])
  })

  it('全空白值不动历史（不产生空书条目、不刷新 LRU 位次）', () => {
    const before: RunbookParamHistory = { b1: { a: ['1'] }, b2: { b: ['2'] } }
    expect(recordRunbookParamValues(before, 'b1', { a: ' ' })).toBe(before)
    expect(recordRunbookParamValues(before, 'b9', {})).toBe(before)
  })

  it('空 bookId 拒收（防脏键入史）', () => {
    const before: RunbookParamHistory = { b1: { a: ['1'] } }
    expect(recordRunbookParamValues(before, '', { a: 'x' })).toBe(before)
  })

  it('书数超上限按 LRU 淘汰最久未提交的书；刚提交的不被挤出', () => {
    let h: RunbookParamHistory = {}
    for (let i = 0; i < RUNBOOK_PARAM_HISTORY_MAX; i++) {
      h = recordRunbookParamValues(h, `b${i}`, { v: String(i) })
    }
    // 刷新最旧书 b0 → 仍在上限内、存活（环形语义：新值置顶，旧值仍在环内）
    h = recordRunbookParamValues(h, 'b0', { v: 'refreshed' })
    expect(h.b0).toEqual({ v: ['refreshed', '0'] })
    // 插入第 51 本新书 → 淘汰此刻最久未提交的 b1，b0 因刚刷新存活
    h = recordRunbookParamValues(h, 'b-new', { v: 'x' })
    expect(h.b1).toBeUndefined()
    expect(Object.keys(h)).toHaveLength(RUNBOOK_PARAM_HISTORY_MAX)
  })
})

describe('filterRunbookParamValues（useSearchHistory 前缀过滤同口径）', () => {
  const ring = ['feature/rbp', 'Feature/x', 'main', 'dev']
  it('空前缀返回副本（调用方改动不影响原环形）', () => {
    const out = filterRunbookParamValues(ring, '  ')
    expect(out).toEqual(ring)
    expect(out).not.toBe(ring)
  })
  it('大小写不敏感前缀过滤', () => {
    expect(filterRunbookParamValues(ring, 'feat')).toEqual(['feature/rbp', 'Feature/x'])
    expect(filterRunbookParamValues(ring, 'FEATURE/')).toEqual(['feature/rbp', 'Feature/x'])
    expect(filterRunbookParamValues(ring, 'ma')).toEqual(['main'])
    expect(filterRunbookParamValues(ring, 'zzz')).toEqual([])
  })
})

describe('clearRunbookParamValues（纯函数）', () => {
  it('只摘目标参数；同书其他参数保留', () => {
    const before: RunbookParamHistory = { b1: { branch: ['main'], env: ['prod'] } }
    expect(clearRunbookParamValues(before, 'b1', 'branch')).toEqual({ b1: { env: ['prod'] } })
  })
  it('书内最后一个参数清掉后连书条目一并摘除；不存在的书/参数原样返回', () => {
    const before: RunbookParamHistory = { b1: { branch: ['main'] }, b2: { env: ['prod'] } }
    const after = clearRunbookParamValues(before, 'b1', 'branch')
    expect(after).toEqual({ b2: { env: ['prod'] } })
    expect(clearRunbookParamValues(after, 'b1', 'branch')).toBe(after)
    expect(clearRunbookParamValues(after, 'nope', 'x')).toBe(after)
  })
})

describe('load/save（safeStorage 持久化）', () => {
  it('remember 落库后 load 读回一致（环形序保持）', () => {
    rememberRunbookParamValues('book-1', { branch: 'main' })
    rememberRunbookParamValues('book-1', { branch: 'feat' })
    expect(loadRunbookParamHistory()['book-1']).toEqual({ branch: ['feat', 'main'] })
    expect(JSON.parse(localStorage.getItem(RUNBOOK_PARAM_HISTORY_KEY) || '{}')).toHaveProperty('book-1')
  })

  it('损坏 JSON / 非法结构逐条丢弃不抛错', () => {
    localStorage.setItem(RUNBOOK_PARAM_HISTORY_KEY, '{oops')
    expect(loadRunbookParamHistory()).toEqual({})
    localStorage.setItem(RUNBOOK_PARAM_HISTORY_KEY, JSON.stringify({
      good: { branch: ['main'], bad: 42, empty: [], mixed: ['ok', 3, ''] },
      arr: ['x'],
      num: 3,
    }))
    expect(loadRunbookParamHistory()).toEqual({ good: { branch: ['main'], mixed: ['ok'] } })
  })

  it('forget 落库后该书参数从存储消失', () => {
    rememberRunbookParamValues('book-2', { branch: 'main', env: 'prod' })
    forgetRunbookParamValues('book-2', 'branch')
    expect(loadRunbookParamHistory()['book-2']).toEqual({ env: ['prod'] })
  })

  it('save 写入的 map 原样读回', () => {
    saveRunbookParamHistory({ b: { k: ['v'] } })
    expect(loadRunbookParamHistory()).toEqual({ b: { k: ['v'] } })
  })
})
