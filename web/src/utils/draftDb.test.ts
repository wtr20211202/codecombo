import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import {
  saveDraft, readDraft, removeDraft, removeProjectDrafts, DRAFT_MAX_CHARS,
  saveUntitledDraft, listUntitledDrafts, removeUntitledDraft,
  listFileDrafts, removeDrafts, type DraftRecord,
} from '@/utils/draftDb'

/**
 * draftDb 防御语义单测（jsdom 无 indexedDB）：草稿是纯增益能力，环境不可用
 * 必须静默降级（写 false / 读 null / 删除不抛错），绝不能打断编辑主流程。
 * 真实 IndexedDB 链路由 e2e editor-draft-recovery.spec.ts 覆盖。
 */
describe('draftDb（无 indexedDB 环境静默降级）', () => {
  it('saveDraft 返回 false 不抛错', async () => {
    await expect(saveDraft('p1', '/a.ts', { content: 'x', savedAt: 1 })).resolves.toBe(false)
  })

  it('readDraft 返回 null 不抛错', async () => {
    await expect(readDraft('p1', '/a.ts')).resolves.toBeNull()
  })

  it('removeDraft / removeProjectDrafts 静默完成', async () => {
    await expect(removeDraft('p1', '/a.ts')).resolves.toBeUndefined()
    await expect(removeProjectDrafts('p1')).resolves.toBeUndefined()
  })

  it('超限内容直接拒写（不触达存储层，防大文件塞爆配额）', async () => {
    const big = 'x'.repeat(DRAFT_MAX_CHARS + 1)
    await expect(saveDraft('p1', '/big.ts', { content: big, savedAt: 1 })).resolves.toBe(false)
  })

  it('untitled 命名空间同款降级：写 false / 列空 / 删不抛错（P-20261003-97）', async () => {
    await expect(saveUntitledDraft('p1', 'untitled://1', { content: 'x', savedAt: 1 })).resolves.toBe(false)
    await expect(listUntitledDrafts('p1')).resolves.toEqual([])
    await expect(removeUntitledDraft('p1', 'untitled://1')).resolves.toBeUndefined()
  })

  it('untitled 超限内容同款拒写', async () => {
    const big = 'x'.repeat(DRAFT_MAX_CHARS + 1)
    await expect(saveUntitledDraft('p1', 'untitled://1', { content: big, savedAt: 1 })).resolves.toBe(false)
  })

  it('陈旧对账原语同款降级（P-20261003-152）：列表空 / 批量删不抛错', async () => {
    await expect(listFileDrafts('p1')).resolves.toEqual([])
    await expect(removeDrafts('p1', ['/a.ts', '/b.ts'])).resolves.toBeUndefined()
    await expect(removeDrafts('p1', [])).resolves.toBeUndefined()
  })
})

// ── 内存 IDB 桩下的真实读写链路 ──
// draftDb 模块级 dbPromise/disabled 状态经 vi.resetModules 逐用例重建；桩只实现
// draftDb 用到的 IDB 面（open/upgrade/transaction/put/get/delete/openCursor/bound，
// 事件走微任务投递对齐「先挂 handler 后触发」的 IDB 时序），完整 IDB 语义仍以
// e2e 真实 IndexedDB 为准——桩的价值是让读写/前缀游标/双 NUL 命名空间隔离的
// 键控契约在单测层可回归。

let dbData: Map<string, unknown>
let origIndexedDB: unknown
let origKeyRange: unknown
let breakTransactions = false

function installFakeIdb(): void {
  ;(globalThis as unknown as Record<string, unknown>).indexedDB = {
    open: () => {
      const openReq: {
        result: unknown
        onupgradeneeded: (() => void) | null
        onsuccess: (() => void) | null
        onerror: (() => void) | null
        onblocked: (() => void) | null
      } = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null }
      queueMicrotask(() => {
        openReq.result = {
          objectStoreNames: { contains: (_n: string) => true },
          transaction(_store: string, _mode: string) {
            if (breakTransactions) throw new TypeError('tx boom')
            const tx = {
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
              onabort: null as (() => void) | null,
              objectStore(_name: string) {
                return {
                  put(value: unknown, key: string) { dbData.set(key, value) },
                  delete(key: string | { lower: string; upper: string }) {
                    if (typeof key === 'string') { dbData.delete(key); return }
                    for (const k of [...dbData.keys()]) {
                      if (k >= key.lower && k <= key.upper) dbData.delete(k)
                    }
                  },
                  get(key: string) {
                    const r: { result: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = { result: null, onsuccess: null, onerror: null }
                    queueMicrotask(() => {
                      r.result = dbData.get(key)
                      r.onsuccess?.()
                    })
                    return r
                  },
                  openCursor(range: { lower: string; upper: string }) {
                    const keys = [...dbData.keys()].filter(k => k >= range.lower && k <= range.upper).sort()
                    let i = 0
                    const r: { result: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = { result: null, onsuccess: null, onerror: null }
                    const step = () => {
                      if (i < keys.length) {
                        const key = keys[i]!
                        i++
                        r.result = { key, value: dbData.get(key), continue: () => queueMicrotask(step) }
                      } else {
                        r.result = null
                      }
                      queueMicrotask(() => r.onsuccess?.())
                    }
                    queueMicrotask(step)
                    return r
                  },
                }
              },
            }
            queueMicrotask(() => tx.oncomplete?.())
            return tx
          },
        }
        openReq.onsuccess?.()
      })
      return openReq
    },
  }
  ;(globalThis as unknown as Record<string, unknown>).IDBKeyRange = {
    bound: (lo: string, hi: string) => ({ lower: lo, upper: hi }),
  }
}

/** resetModules 拿到全新 draftDb 模块实例（无 disabled 锁、无建连缓存） */
function freshDraftDb(): Promise<typeof import('@/utils/draftDb')> {
  vi.resetModules()
  return import('@/utils/draftDb')
}

function rec(content: string, baseHash?: string): DraftRecord {
  return { content, savedAt: 42, ...(baseHash ? { baseHash } : {}) }
}

describe('draftDb（内存 IDB 桩：读写链路）', () => {
  beforeEach(() => {
    dbData = new Map()
    origIndexedDB = (globalThis as unknown as Record<string, unknown>).indexedDB
    origKeyRange = (globalThis as unknown as Record<string, unknown>).IDBKeyRange
    breakTransactions = false
    installFakeIdb()
  })

  afterEach(() => {
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = origIndexedDB
    ;(globalThis as unknown as Record<string, unknown>).IDBKeyRange = origKeyRange
  })

  it('写读 round-trip：记录逐字段保真（content/savedAt/baseHash）', async () => {
    const db = await freshDraftDb()
    await expect(db.saveDraft('p1', '/a.ts', rec('dirty text', 'sha-abc'))).resolves.toBe(true)
    await expect(db.readDraft('p1', '/a.ts')).resolves.toEqual(rec('dirty text', 'sha-abc'))
  })

  it('同键覆写取最新；删除后读 null', async () => {
    const db = await freshDraftDb()
    await db.saveDraft('p1', '/a.ts', rec('v1'))
    await db.saveDraft('p1', '/a.ts', rec('v2'))
    await expect(db.readDraft('p1', '/a.ts')).resolves.toEqual(rec('v2'))
    await db.removeDraft('p1', '/a.ts')
    await expect(db.readDraft('p1', '/a.ts')).resolves.toBeNull()
  })

  it('未写过的键读 null（IDB get miss → undefined ?? null）', async () => {
    const db = await freshDraftDb()
    await expect(db.readDraft('p1', '/never.ts')).resolves.toBeNull()
  })

  it('listFileDrafts：文件行剥前缀取 path；untitled 双 NUL 键不入列；跨项目隔离', async () => {
    const db = await freshDraftDb()
    await db.saveDraft('p1', '/a.ts', rec('a'))
    await db.saveDraft('p1', '/dir/b.ts', rec('b'))
    await db.saveUntitledDraft('p1', 'untitled://1', rec('u'))
    await db.saveDraft('p2', '/other.ts', rec('o'))
    const rows = await db.listFileDrafts('p1')
    expect(rows.map(r => `${r.path}:${r.record.content}`)).toEqual(['/a.ts:a', '/dir/b.ts:b'])
  })

  it('listUntitledDrafts：key 剥命名空间前缀；与文件草稿互斥', async () => {
    const db = await freshDraftDb()
    await db.saveUntitledDraft('p1', 'untitled://2', rec('u2'))
    await db.saveUntitledDraft('p1', 'untitled://1', rec('u1'))
    await db.saveDraft('p1', '/a.ts', rec('a'))
    const rows = await db.listUntitledDrafts('p1')
    expect(rows.map(r => `${r.key}:${r.record.content}`)).toEqual(['untitled://1:u1', 'untitled://2:u2'])
  })

  it('removeProjectDrafts：双命名空间整项目清账，其他项目不动', async () => {
    const db = await freshDraftDb()
    await db.saveDraft('p1', '/a.ts', rec('a'))
    await db.saveUntitledDraft('p1', 'untitled://1', rec('u'))
    await db.saveDraft('p2', '/keep.ts', rec('k'))
    await db.removeProjectDrafts('p1')
    await expect(db.listFileDrafts('p1')).resolves.toEqual([])
    await expect(db.listUntitledDrafts('p1')).resolves.toEqual([])
    await expect(db.readDraft('p2', '/keep.ts')).resolves.toEqual(rec('k'))
  })

  it('removeDrafts 批量删：单事务清指定键集', async () => {
    const db = await freshDraftDb()
    await db.saveDraft('p1', '/a.ts', rec('a'))
    await db.saveDraft('p1', '/b.ts', rec('b'))
    await db.saveDraft('p1', '/c.ts', rec('c'))
    await db.removeDrafts('p1', ['/a.ts', '/c.ts'])
    await expect(db.readDraft('p1', '/a.ts')).resolves.toBeNull()
    await expect(db.readDraft('p1', '/b.ts')).resolves.toEqual(rec('b'))
    await expect(db.readDraft('p1', '/c.ts')).resolves.toBeNull()
  })

  it('事务抛错静默 false（调用方 catch 面）', async () => {
    const db = await freshDraftDb()
    breakTransactions = true
    await expect(db.saveDraft('p1', '/x.ts', rec('x'))).resolves.toBe(false)
    await expect(db.readDraft('p1', '/x.ts')).resolves.toBeNull()
  })

  // ── 跨标签信标（P-20261006-08）：写路径成功分支广播、失败/拒写静默 ──

  it('saveDraft 成功广播信标：载荷含 project/path/savedAt（P-20261006-08）', async () => {
    const db = await freshDraftDb()
    await db.saveDraft('p1', '/a.ts', rec('dirty', 'sha-a'))
    const raw = localStorage.getItem(db.DRAFT_SAVED_BEACON_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({ project: 'p1', path: '/a.ts', savedAt: 42 })
  })

  it('事务失败/超限拒写不广播（信标只在真落库后发）', async () => {
    const db = await freshDraftDb()
    breakTransactions = true
    await db.saveDraft('p1', '/a.ts', rec('x'))
    expect(localStorage.getItem(db.DRAFT_SAVED_BEACON_KEY)).toBeNull()
    breakTransactions = false
    await db.saveDraft('p1', '/big.ts', { content: 'x'.repeat(DRAFT_MAX_CHARS + 1), savedAt: 43 })
    expect(localStorage.getItem(db.DRAFT_SAVED_BEACON_KEY)).toBeNull()
  })

  it('untitled 写路径同挂信标（两条写路径全覆盖，path 为内部键）', async () => {
    const db = await freshDraftDb()
    await db.saveUntitledDraft('p1', 'untitled://1', { content: 'u', savedAt: 7 })
    expect(JSON.parse(localStorage.getItem(db.DRAFT_SAVED_BEACON_KEY)!))
      .toEqual({ project: 'p1', path: 'untitled://1', savedAt: 7 })
  })

  it('readUntitledDraft：单条读与 save/remove 对称（P-20261006-08 重载原语）', async () => {
    const db = await freshDraftDb()
    await expect(db.readUntitledDraft('p1', 'untitled://1')).resolves.toBeNull()
    await db.saveUntitledDraft('p1', 'untitled://1', rec('u1'))
    await expect(db.readUntitledDraft('p1', 'untitled://1')).resolves.toEqual(rec('u1'))
    await db.removeUntitledDraft('p1', 'untitled://1')
    await expect(db.readUntitledDraft('p1', 'untitled://1')).resolves.toBeNull()
  })
})
