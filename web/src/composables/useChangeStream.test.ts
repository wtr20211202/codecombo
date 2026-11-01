import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── mock 边界：外部依赖只有 ① watchActivityApi ② 项目 store。聚合/去抖分批/
// 路径剥根是真实现（不 mock 被测逻辑本身）；composable 宿主侧用 createPinia ──
const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(params?: { limit?: number; since?: number }) => Promise<unknown>>(),
}))
vi.mock('../api/domains/system', () => ({
  watchActivityApi: { get: (params?: { limit?: number; since?: number }) => getMock(params) },
}))

import { setActivePinia, createPinia } from 'pinia'
import {
  coalesceBatches, deepLinkRelPath, displayPath, useChangeStream,
  CHANGE_STREAM_GROUP_WINDOW_MS,
} from './useChangeStream'
import { useProjectStore, type Project } from '../stores/project'
import type { ChangeStreamEvent } from '../api/domains/system'

const projects: Project[] = [
  { id: 'p-alpha', name: 'Alpha', path: 'D:/ws/alpha', currentBranch: 'main', remoteURL: '', valid: true },
  { id: 'p-beta', name: 'Beta', path: '/home/ws/beta', currentBranch: 'dev', remoteURL: '', valid: true },
]

/** 事件工厂：ts 毫秒直给 */
function e(ts: number, projectId: string, path: string): ChangeStreamEvent {
  return { ts, projectId, path }
}

beforeEach(() => {
  getMock.mockReset()
  setActivePinia(createPinia())
})

describe('displayPath 项目相对展示路径', () => {
  it('win 反斜杠绝对路径剥 posix 化项目根（分隔符方向不假设）', () => {
    expect(displayPath('D:\\ws\\alpha\\src\\main.go', 'D:/ws/alpha')).toBe('src/main.go')
  })
  it('posix 绝对路径剥根', () => {
    expect(displayPath('/home/ws/beta/web/x.ts', '/home/ws/beta')).toBe('web/x.ts')
  })
  it('根不匹配（项目已删/路径迁移）退回文件名', () => {
    expect(displayPath('/elsewhere/a/b.go', '/home/ws/beta')).toBe('b.go')
    expect(displayPath('D:\\ws\\alpha\\b.go', undefined)).toBe('b.go')
  })
})

describe('deepLinkRelPath 深链相对路径（P-20261006-52）', () => {
  it('根匹配：与 displayPath 同一归一口径（win 反斜杠/posix 正斜杠都能剥）', () => {
    expect(deepLinkRelPath('D:\\ws\\alpha\\src\\main.go', 'D:/ws/alpha')).toBe('src/main.go')
    expect(deepLinkRelPath('/home/ws/beta/web/x.ts', '/home/ws/beta/')).toBe('web/x.ts')
  })
  it('根不匹配/无项目根：返回 null（basename 降级是给人看的兜底，不能拿去开文件）', () => {
    expect(deepLinkRelPath('/elsewhere/a/b.go', '/home/ws/beta')).toBeNull()
    expect(deepLinkRelPath('D:\\ws\\alpha\\b.go', undefined)).toBeNull()
  })
  it('路径恰为项目根本体（无子路径）：null，不开文件', () => {
    expect(deepLinkRelPath('D:/ws/alpha', 'D:/ws/alpha')).toBeNull()
  })
})

describe('coalesceBatches 去抖分批聚合', () => {
  it('同项目时间窗内连续事件合并为一批（count 累计，文件预览截断）', () => {
    const t0 = 1_000_000
    const events = [
      e(t0, 'p-alpha', 'D:/ws/alpha/a1.go'),
      e(t0 - 500, 'p-alpha', 'D:/ws/alpha/a2.go'),
      e(t0 - 1000, 'p-alpha', 'D:/ws/alpha/a3.go'),
      e(t0 - 1500, 'p-alpha', 'D:/ws/alpha/a4.go'),
      e(t0 - 2000, 'p-alpha', 'D:/ws/alpha/a5.go'),
    ]
    const batches = coalesceBatches(events, projects, { filesPerBatch: 3 })
    expect(batches).toHaveLength(1)
    expect(batches[0]?.count).toBe(5)
    expect(batches[0]?.files).toEqual(['a1.go', 'a2.go', 'a3.go'])
    expect(batches[0]?.projectName).toBe('Alpha')
  })

  it('超出时间窗的相邻同项目事件开新批（突发各自成行，慢流不并成巨批）', () => {
    const t0 = 1_000_000
    const events = [
      e(t0, 'p-alpha', 'D:/ws/alpha/a1.go'),
      // 距批内最新事件 > 窗口：开新批
      e(t0 - CHANGE_STREAM_GROUP_WINDOW_MS - 1, 'p-alpha', 'D:/ws/alpha/a2.go'),
    ]
    const batches = coalesceBatches(events, projects)
    expect(batches).toHaveLength(2)
    expect(batches[0]?.count).toBe(1)
    expect(batches[1]?.count).toBe(1)
  })

  it('跨项目相邻事件各自成批，项目徽标信息随行（双项目时间线口径）', () => {
    const t0 = 1_000_000
    const events = [
      e(t0, 'p-alpha', 'D:/ws/alpha/a.go'),
      e(t0 - 100, 'p-beta', '/home/ws/beta/b.ts'),
      e(t0 - 200, 'p-alpha', 'D:/ws/alpha/c.go'),
    ]
    const batches = coalesceBatches(events, projects)
    expect(batches).toHaveLength(3)
    expect(batches.map(b => b.projectId)).toEqual(['p-alpha', 'p-beta', 'p-alpha'])
    expect(batches[0]?.files).toEqual(['a.go'])
    expect(batches[1]?.files).toEqual(['b.ts'])
  })

  it('maxBatches 截旧：时间线行数有界（风暴下行数不无限增长）', () => {
    const t0 = 1_000_000
    const events = Array.from({ length: 50 }, (_, i) =>
      e(t0 - i * CHANGE_STREAM_GROUP_WINDOW_MS * 10, 'p-alpha', `D:/ws/alpha/f${i}.go`))
    const batches = coalesceBatches(events, projects, { maxBatches: 10 })
    expect(batches).toHaveLength(10)
  })

  it('未知项目（已删除）徽标降级为空名（视图显短 id），路径退文件名', () => {
    const events = [e(1_000_000, 'p-gone', '/elsewhere/x/y.go')]
    const batches = coalesceBatches(events, projects)
    expect(batches[0]?.projectName).toBe('')
    expect(batches[0]?.files).toEqual(['y.go'])
  })

  it('lastPath = 批内最新事件的原始绝对路径（深链目标；并入旧事件不覆盖）', () => {
    const t0 = 1_000_000
    const events = [
      e(t0, 'p-alpha', 'D:/ws/alpha/newest.go'),
      e(t0 - 500, 'p-alpha', 'D:/ws/alpha/older.go'),
    ]
    const batches = coalesceBatches(events, projects)
    expect(batches).toHaveLength(1)
    // 未剥根的服务端形态（相对折算放点击时点）；批行合并不把旧事件路径覆盖上来
    expect(batches[0]?.lastPath).toBe('D:/ws/alpha/newest.go')
  })
})

describe('useChangeStream 轮询宿主', () => {
  it('start 立即拉取并聚合；失败静默保旧数据；batches 随项目清单响应式解析', async () => {
    getMock.mockResolvedValue({ data: { events: [e(1_000_000, 'p-alpha', 'D:/ws/alpha/main.go')], dropped: 0 } })
    const store = useProjectStore()
    store.projects.push(...projects)
    const cs = useChangeStream()
    cs.start()
    await vi.waitFor(() => expect(cs.loaded.value).toBe(true))
    expect(cs.batches.value).toHaveLength(1)
    expect(cs.batches.value[0]?.projectName).toBe('Alpha')

    // 失败轮询：保旧数据 + failed 标记
    getMock.mockRejectedValue(new Error('net down'))
    await cs.refresh()
    expect(cs.failed.value).toBe(true)
    expect(cs.batches.value).toHaveLength(1)
    cs.stop()
  })

  it('服务端重启清空快照（空 events）→ 视图回落空态，dropped 透传', async () => {
    getMock.mockResolvedValue({ data: { events: [], dropped: 7 } })
    const store = useProjectStore()
    store.projects.push(...projects)
    const cs = useChangeStream()
    await cs.refresh()
    expect(cs.batches.value).toHaveLength(0)
    expect(cs.dropped.value).toBe(7)
  })
})
