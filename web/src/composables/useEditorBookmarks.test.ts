import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// 本文件用例全是 fake timers + 即时 mock，逻辑毫秒级（隔离实测 6 例 3.8s），
// 但满载下（多 worktree e2e 实例并行构建抢占 CPU，vitest maxWorkers=2 也挡不住
// 调度抖动）首例墙钟时间间歇性顶过全局默认 5000ms——三次全量跑两超时一通过、
// 隔离/复跑全绿，实为负载 flaky 非逻辑回归。文件级放宽到 20s 后满载仍有一超
//（P-20261003-304 批次 npm run check 实测 >20s，首例 fresh() 的 resetModules
// 动态重导入纯吃调度抖动，与本测试模块图不含任何改动文件），
// 再抬到 60s 只抬等待上限、不改任何断言与语义：hung 用例仍有界，抖动不再翻红
// check 门禁
vi.setConfig({ testTimeout: 60_000 })

// ── mock 边界：本组合式的外部依赖只有 ① uiState 持久化（get/save 书签表）
// ② 实例身份（instanceId 变化 = 跨实例切换重载）③ useOpenFiles 的路径判定
// （避免拖入 useOpenFiles 的整条 shell 依赖链）──
const { getBookmarksMock, saveBookmarksMock, instanceId } = vi.hoisted(() => ({
  getBookmarksMock: vi.fn<() => Promise<Record<string, Record<string, Array<{ line: number, anchor?: string } | number>>>>>(),
  saveBookmarksMock: vi.fn<(b: Record<string, Record<string, Array<{ line: number, anchor?: string }>>>) => Promise<void>>(),
  instanceId: { value: 'inst-1' },
}))

vi.mock('../stores/uiState', () => ({
  useUIStateStore: () => ({
    getEditorBookmarks: getBookmarksMock,
    saveEditorBookmarks: saveBookmarksMock,
  }),
}))

vi.mock('../stores/instance', () => ({
  useInstanceStore: () => ({ currentInstanceId: instanceId.value }),
}))

vi.mock('./useOpenFiles', () => ({
  isUntitledPath: (p: string) => p.startsWith('untitled://'),
}))

// remoteEditorPath 同文件底部携 ../api/client 整条域桶（axios+全部领域模块），
// 不 mock 的话 fresh() 首次 resetModules 要重执行整图（实测 ~2.7s，全量并行
// 负载下顶穿 5s 用例超时）。组合式只消费路径分类，按前缀保真即可
vi.mock('../utils/remoteEditorPath', () => ({
  isRemoteEditorPath: (p: string) => p.startsWith('remote:'),
}))

import type { useEditorBookmarks as UseEditorBookmarks, BookmarkLocation } from './useEditorBookmarks'

/** 记录表构造捷径（断言可读性） */
const recs = (lines: number[]): Array<{ line: number, anchor?: string }> => lines.map(line => ({ line }))

/** 模块单例（byProject/loaded 为模块级状态）跨用例复位：resetModules + 动态重取 */
async function fresh(): Promise<ReturnType<typeof UseEditorBookmarks>> {
  vi.resetModules()
  const m = await import('./useEditorBookmarks')
  return m.useEditorBookmarks()
}

beforeEach(() => {
  vi.useFakeTimers()
  getBookmarksMock.mockReset().mockResolvedValue({})
  saveBookmarksMock.mockReset().mockResolvedValue(undefined)
  instanceId.value = 'inst-1'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useEditorBookmarks 编辑器书签锚（P-20261002-131 / P-20261004-105 锚自愈）', () => {
  it('ensureLoaded 懒加载持久化状态（旧 number[] 与新记录双形态）；listBookmarksOf 按路径字典序 × 行升序展开', async () => {
    getBookmarksMock.mockResolvedValue({
      p1: { 'b/b.ts': [20, 3], 'a/a.ts': [{ line: 7, anchor: 'alpha' }] },
    })
    const bm = await fresh()
    await bm.ensureLoaded()
    // 旧纯行号降级为无锚记录（向后兼容，不要求清数据升级）
    expect(bm.bookmarksFor('p1', 'b/b.ts')).toEqual(recs([3, 20]))
    expect(bm.listBookmarksOf('p1')).toEqual([
      { path: 'a/a.ts', line: 7, anchor: 'alpha' },
      { path: 'b/b.ts', line: 3 },
      { path: 'b/b.ts', line: 20 },
    ] satisfies BookmarkLocation[])
    // 其他项目/未知文件回落空表
    expect(bm.bookmarksFor('p2', 'a/a.ts')).toEqual([])
    expect(bm.listBookmarksOf('p2')).toEqual([])
  })

  it('toggle 加/删书签（捕获行内容锚）：升序插入、即时落盘；重复 toggle 幂等移除', async () => {
    const bm = await fresh()
    await bm.ensureLoaded()

    expect(bm.toggleBookmark('p1', 'f.ts', 30, '  third  line ')).toBe(true)
    expect(bm.toggleBookmark('p1', 'f.ts', 10)).toBe(true)
    // 锚规范化（压缩空白/去首尾）；无锚 toggle 保持降级形态
    expect(bm.bookmarksFor('p1', 'f.ts')).toEqual([{ line: 10 }, { line: 30, anchor: 'third line' }])
    // toggle 即时写（delay=0 的宏任务）
    await vi.advanceTimersByTimeAsync(0)
    expect(saveBookmarksMock).toHaveBeenCalledTimes(1)
    expect(saveBookmarksMock.mock.calls[0]![0]).toEqual({ p1: { 'f.ts': [{ line: 10 }, { line: 30, anchor: 'third line' }] } })

    // 删除后文件/项目空表收敛
    expect(bm.toggleBookmark('p1', 'f.ts', 10)).toBe(false)
    expect(bm.toggleBookmark('p1', 'f.ts', 30)).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(saveBookmarksMock).toHaveBeenLastCalledWith({})
  })

  it('toggle 守卫：未命名草稿/diff 伪键/非法行号不落任何状态', async () => {
    const { isBookmarkablePath } = await import('./useEditorBookmarks')
    const bm = await fresh()
    await bm.ensureLoaded()
    expect(isBookmarkablePath('untitled://1')).toBe(false)
    expect(isBookmarkablePath('diff:HEAD~1')).toBe(false)
    expect(isBookmarkablePath('src/a.ts')).toBe(true)
    expect(bm.toggleBookmark('p1', 'untitled://1', 3)).toBe(false)
    expect(bm.toggleBookmark('p1', 'diff:HEAD~1', 3)).toBe(false)
    expect(bm.toggleBookmark('p1', 'src/a.ts', 0)).toBe(false)
    expect(bm.toggleBookmark('', 'src/a.ts', 3)).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(saveBookmarksMock).not.toHaveBeenCalled()
  })

  it('replaceRecords 行漂移回写：归一（去重/升序/裁非法）后更新，内容不变跳过', async () => {
    const bm = await fresh()
    await bm.ensureLoaded()
    bm.replaceRecords('p1', 'f.ts', [{ line: 9 }, { line: 2 }, { line: 2 }, { line: 0 }, { line: -1 }])
    expect(bm.bookmarksFor('p1', 'f.ts')).toEqual(recs([2, 9]))
    await vi.advanceTimersByTimeAsync(1500)
    expect(saveBookmarksMock).toHaveBeenCalledTimes(1)

    // 相同内容不重复落盘（行 + 锚逐条比对）
    bm.replaceRecords('p1', 'f.ts', [{ line: 2 }, { line: 9 }])
    await vi.advanceTimersByTimeAsync(3000)
    expect(saveBookmarksMock).toHaveBeenCalledTimes(1)

    // 漂移到空（书签行被删光的场景）收敛整键
    bm.replaceRecords('p1', 'f.ts', [])
    expect(bm.bookmarksFor('p1', 'f.ts')).toEqual([])
    await vi.advanceTimersByTimeAsync(1500)
    expect(saveBookmarksMock).toHaveBeenLastCalledWith({})
  })

  it('失效弱标（会话内派生，不落盘）：setStaleAnchors 整文件改写、listBookmarksOf 投影、toggle 加书签摘除、实例切换清空', async () => {
    getBookmarksMock.mockResolvedValue({ p1: { 'a.ts': [{ line: 5, anchor: 'ghost' }, { line: 9, anchor: 'alive' }] } })
    const bm = await fresh()
    await bm.ensureLoaded()

    bm.setStaleAnchors('p1', 'a.ts', ['ghost', 'ghost'])
    expect(bm.listBookmarksOf('p1')).toEqual([
      { path: 'a.ts', line: 5, anchor: 'ghost', stale: true },
      { path: 'a.ts', line: 9, anchor: 'alive' },
    ] satisfies BookmarkLocation[])
    expect(bm.staleAnchorSet('p1', 'a.ts').has('ghost')).toBe(true)

    // 失效标是派生态：持久化快照里从不出现（行漂移真实变化后落盘，快照无 stale 字段）
    bm.replaceRecords('p1', 'a.ts', [{ line: 5, anchor: 'ghost' }, { line: 10, anchor: 'alive' }])
    await vi.advanceTimersByTimeAsync(1500)
    expect(saveBookmarksMock).toHaveBeenLastCalledWith({ p1: { 'a.ts': [{ line: 5, anchor: 'ghost' }, { line: 10, anchor: 'alive' }] } })
    // 失效判定不受行漂移回写影响（失效集按锚记，未重判定前保持）
    expect(bm.staleAnchorSet('p1', 'a.ts').has('ghost')).toBe(true)

    // 显式加书签 = 用户最新意图：同锚从失效集摘除（防重锚到曾判失效的内容行被误标）
    expect(bm.toggleBookmark('p1', 'a.ts', 12, 'ghost')).toBe(true)
    expect(bm.staleAnchorSet('p1', 'a.ts').has('ghost')).toBe(false)

    // 实例切换重载清空失效标（派生态随会话重建）
    bm.setStaleAnchors('p1', 'a.ts', ['alive'])
    instanceId.value = 'inst-2'
    getBookmarksMock.mockResolvedValue({ p1: { 'b.ts': [{ line: 8 }] } })
    await bm.ensureLoaded()
    expect(bm.listBookmarksOf('p1')).toEqual([{ path: 'b.ts', line: 8 }] satisfies BookmarkLocation[])
    expect(bm.staleAnchorSet('p1', 'a.ts').size).toBe(0)
  })

  it('每项目上限 100：加书签触顶后按文件键插入序 × 行升序淘汰最早条目', async () => {
    const { BOOKMARKS_MAX_PER_PROJECT } = await import('./useEditorBookmarks')
    const bm = await fresh()
    await bm.ensureLoaded()
    // 预置 100 条：a.ts 60 条（1..60）、b.ts 40 条（1..40）
    for (let i = 1; i <= 60; i++) bm.toggleBookmark('p1', 'a.ts', i)
    for (let i = 1; i <= 40; i++) bm.toggleBookmark('p1', 'b.ts', i)
    await vi.advanceTimersByTimeAsync(0)
    saveBookmarksMock.mockClear()

    // 第 101 条 → a.ts 首行（文件键插入序最先 × 行最小）被淘汰，总量回到 100
    expect(bm.toggleBookmark('p1', 'b.ts', 999)).toBe(true)
    expect(bm.bookmarksFor('p1', 'a.ts')).toEqual(Array.from({ length: 59 }, (_, i) => ({ line: i + 2 })))
    expect(bm.bookmarksFor('p1', 'b.ts')).toEqual([...Array.from({ length: 40 }, (_, i) => ({ line: i + 1 })), { line: 999 }])
    const total =
      bm.bookmarksFor('p1', 'a.ts').length + bm.bookmarksFor('p1', 'b.ts').length
    expect(total).toBe(BOOKMARKS_MAX_PER_PROJECT)
  })

  it('实例切换后重载新实例的持久化状态（防旧实例状态串写）', async () => {
    getBookmarksMock.mockResolvedValue({ p1: { 'a.ts': [5] } })
    const bm = await fresh()
    await bm.ensureLoaded()
    expect(bm.bookmarksFor('p1', 'a.ts')).toEqual(recs([5]))

    instanceId.value = 'inst-2'
    getBookmarksMock.mockResolvedValue({ p1: { 'b.ts': [8] } })
    await bm.ensureLoaded()
    expect(bm.bookmarksFor('p1', 'a.ts')).toEqual([])
    expect(bm.bookmarksFor('p1', 'b.ts')).toEqual(recs([8]))
  })
})

describe('neighborBookmark 书签环形跳转（P-20261004-102）', () => {
  /** 环形序夹具（listBookmarksOf 产物同形：路径字典序 × 行升序） */
  const RING: BookmarkLocation[] = [
    { path: 'a.ts', line: 10 },
    { path: 'a.ts', line: 50 },
    { path: 'b/b.ts', line: 3 },
    { path: 'c.ts', line: 7 },
  ]
  let neighborBookmark: typeof import('./useEditorBookmarks').neighborBookmark

  beforeEach(async () => {
    vi.resetModules()
    neighborBookmark = (await import('./useEditorBookmarks')).neighborBookmark
  })

  it('next：同文件取行号更大的，跨文件按路径序，环尾回绕表头', () => {
    expect(neighborBookmark(RING, { path: 'a.ts', line: 10 }, 1)).toEqual({ path: 'a.ts', line: 50 })
    // a.ts:50 之后同文件无更大行 → 下一个文件 b/b.ts:3
    expect(neighborBookmark(RING, { path: 'a.ts', line: 50 }, 1)).toEqual({ path: 'b/b.ts', line: 3 })
    // 锚点文件不在表中（bb.ts 严格介于 b/b.ts 与 c.ts 之间）→ 按路径序取更大文件
    expect(neighborBookmark(RING, { path: 'bb.ts', line: 1 }, 1)).toEqual({ path: 'c.ts', line: 7 })
    // 严格比较不粘滞：落在书签行上再按 next 推进到下一个
    expect(neighborBookmark(RING, { path: 'c.ts', line: 7 }, 1)).toEqual({ path: 'a.ts', line: 10 })
  })

  it('prev：next 的镜像（严格更小，环头回绕表尾）', () => {
    expect(neighborBookmark(RING, { path: 'a.ts', line: 50 }, -1)).toEqual({ path: 'a.ts', line: 10 })
    expect(neighborBookmark(RING, { path: 'a.ts', line: 10 }, -1)).toEqual({ path: 'c.ts', line: 7 })
    expect(neighborBookmark(RING, { path: 'bb.ts', line: 1 }, -1)).toEqual({ path: 'b/b.ts', line: 3 })
  })

  it('无锚点（不可书签形态/无活跃文件）取表头（next）/表尾（prev）；空表返回 null', () => {
    expect(neighborBookmark(RING, null, 1)).toEqual({ path: 'a.ts', line: 10 })
    expect(neighborBookmark(RING, null, -1)).toEqual({ path: 'c.ts', line: 7 })
    expect(neighborBookmark([], { path: 'a.ts', line: 1 }, 1)).toBeNull()
    expect(neighborBookmark([], null, -1)).toBeNull()
  })
})
