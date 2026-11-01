import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// 本文件用例全是 fake timers + 即时 mock（useEditorBookmarks.test.ts 同款边界）：
// 外部依赖只有 ① uiState 持久化（get/save 留言表）② 实例身份（instanceId 变化
// = 跨实例切换重载）。utils/diffComments 纯函数单测另有文件，此处只测状态搬运
vi.setConfig({ testTimeout: 60_000 })

const { getCommentsMock, saveCommentsMock, instanceId } = vi.hoisted(() => ({
  getCommentsMock: vi.fn<() => Promise<Record<string, Record<string, unknown[]>>>>(),
  saveCommentsMock: vi.fn<(b: Record<string, Record<string, unknown[]>>) => Promise<void>>(),
  instanceId: { value: 'inst-1' },
}))

vi.mock('../stores/uiState', () => ({
  useUIStateStore: () => ({
    getDiffComments: getCommentsMock,
    saveDiffComments: saveCommentsMock,
  }),
}))

vi.mock('../stores/instance', () => ({
  useInstanceStore: () => ({ currentInstanceId: instanceId.value }),
}))

import type { useDiffComments as UseDiffComments } from './useDiffComments'
import type { DiffComment } from '../utils/diffComments'

/** 模块单例（byProject/loaded 为模块级状态）跨用例复位：resetModules + 动态重取 */
async function fresh(): Promise<ReturnType<typeof UseDiffComments>> {
  vi.resetModules()
  const m = await import('./useDiffComments')
  return m.useDiffComments()
}

function rawComment(overrides: Partial<DiffComment>): Record<string, unknown> {
  return { id: 'x1', line: 1, text: '这里要改', lineText: 'a', createdAt: 1, resolved: false, ...overrides }
}

beforeEach(() => {
  vi.useFakeTimers()
  getCommentsMock.mockReset().mockResolvedValue({})
  saveCommentsMock.mockReset().mockResolvedValue(undefined)
  instanceId.value = 'inst-1'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDiffComments diff 审阅留言（P-20261003-279）', () => {
  it('ensureLoaded 懒加载 + 形状防御；commentsFor/commentAt 直读', async () => {
    getCommentsMock.mockResolvedValue({
      p1: {
        'a.ts': [rawComment({ line: 3, lineText: 'l3' }), rawComment({ id: 'bad', line: -1 })],
      },
    })
    const dc = await fresh()
    await dc.ensureLoaded()
    expect(dc.commentsFor('p1', 'a.ts')).toHaveLength(1)
    expect(dc.commentAt('p1', 'a.ts', 3)?.lineText).toBe('l3')
    expect(dc.commentAt('p1', 'a.ts', 4)).toBeUndefined()
    expect(dc.commentsFor('p2', 'a.ts')).toEqual([])
    expect(dc.commentsFor('', 'a.ts')).toEqual([])
  })

  it('addComment：空文/越界行/一行一条拒绝；合法即写内存+即时落盘', async () => {
    const dc = await fresh()
    await dc.ensureLoaded()
    expect(dc.addComment('p1', 'a.ts', 0, 'x', 'l')).toBe(false)
    expect(dc.addComment('p1', 'a.ts', 2, '   ', 'l')).toBe(false)
    expect(dc.addComment('p1', 'a.ts', 2, 'x'.repeat(501), 'l')).toBe(false)
    expect(dc.addComment('p1', 'a.ts', 2, ' 这里要改 ', ' line 2 ')).toBe(true)
    expect(dc.addComment('p1', 'a.ts', 2, '第二条', 'l')).toBe(false)
    // trim 落库
    const c = dc.commentAt('p1', 'a.ts', 2)
    expect(c?.text).toBe('这里要改')
    expect(c?.lineText).toBe('line 2')
    expect(c?.resolved).toBe(false)
    // 即时落盘（schedulePersist(0)）
    await vi.advanceTimersByTimeAsync(0)
    expect(saveCommentsMock).toHaveBeenCalledTimes(1)
  })

  it('editComment/setCommentResolved/removeComment：id 身份寻址，删空表收键', async () => {
    const dc = await fresh()
    await dc.ensureLoaded()
    dc.addComment('p1', 'a.ts', 2, 'v1', 'l2')
    const c = dc.commentAt('p1', 'a.ts', 2)!
    expect(dc.editComment('p1', 'a.ts', c.id, 'v2')).toBe(true)
    expect(dc.commentAt('p1', 'a.ts', 2)?.text).toBe('v2')
    expect(dc.editComment('p1', 'a.ts', 'nope', 'v')).toBe(false)
    expect(dc.setCommentResolved('p1', 'a.ts', c.id, true)).toBe(true)
    expect(dc.commentAt('p1', 'a.ts', 2)?.resolved).toBe(true)
    expect(dc.removeComment('p1', 'a.ts', c.id)).toBe(true)
    expect(dc.commentsFor('p1', 'a.ts')).toEqual([])
    expect(dc.removeComment('p1', 'a.ts', c.id)).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    // 首次 save（add）后删空表时 byProject 已收敛——落盘快照不含空壳键
    const saved = saveCommentsMock.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(saved['p1']).toBeUndefined()
  })

  it('addComment 超上限：createdAt 最旧先淘汰（每项目 100 条）', async () => {
    getCommentsMock.mockResolvedValue({
      p1: { 'a.ts': Array.from({ length: 100 }, (_, i) => rawComment({ id: `o${i}`, line: i + 1, createdAt: i + 1 })) },
    })
    const dc = await fresh()
    await dc.ensureLoaded()
    expect(dc.addComment('p1', 'a.ts', 200, 'newest', 'l')).toBe(true)
    const list = dc.commentsFor('p1', 'a.ts')
    expect(list).toHaveLength(100)
    expect(list.some((x) => x.id === 'o0')).toBe(false) // 最旧被淘汰
    expect(list.some((x) => x.text === 'newest')).toBe(true)
  })

  it('reconcileDrift：内容锚找回 retarget + 防抖落盘；无变化零写', async () => {
    const dc = await fresh()
    await dc.ensureLoaded()
    dc.addComment('p1', 'a.ts', 2, 'look', 'target')
    dc.addComment('p1', 'a.ts', 5, 'stable', 'keep')
    const lines = (n: number) => (n === 4 ? 'target' : n === 5 ? 'keep' : `l${n}`)
    dc.reconcileDrift('p1', 'a.ts', 10, lines)
    expect(dc.commentAt('p1', 'a.ts', 4)?.text).toBe('look') // 找回
    expect(dc.commentAt('p1', 'a.ts', 5)?.text).toBe('stable') // 原地
    await vi.advanceTimersByTimeAsync(1500)
    expect(saveCommentsMock).toHaveBeenCalled()
    // 无变化再和解：零落盘
    saveCommentsMock.mockClear()
    dc.reconcileDrift('p1', 'a.ts', 10, lines)
    await vi.advanceTimersByTimeAsync(1500)
    expect(saveCommentsMock).not.toHaveBeenCalled()
  })

  it('跨实例切换：ensureLoaded 重拉新实例状态，不串槽', async () => {
    getCommentsMock.mockResolvedValue({ p1: { 'a.ts': [rawComment({ id: 'i1', line: 1 })] } })
    const dc = await fresh()
    await dc.ensureLoaded()
    expect(dc.commentAt('p1', 'a.ts', 1)?.id).toBe('i1')
    instanceId.value = 'inst-2'
    getCommentsMock.mockResolvedValue({ p1: { 'a.ts': [rawComment({ id: 'i2', line: 9 })] } })
    await dc.ensureLoaded()
    expect(dc.commentAt('p1', 'a.ts', 1)).toBeUndefined()
    expect(dc.commentAt('p1', 'a.ts', 9)?.id).toBe('i2')
  })

  it('version 随任意变更递增（另一实例同模块共享状态的重放触发器）', async () => {
    const dc = await fresh()
    await dc.ensureLoaded()
    const v0 = dc.version.value
    dc.addComment('p1', 'a.ts', 2, 'x', 'l')
    expect(dc.version.value).toBeGreaterThan(v0)
  })
})
