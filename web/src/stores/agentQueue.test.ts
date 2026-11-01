import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentQueueStore } from '@/stores/agentQueue'
import { terminalApi, type SessionQueueEntry } from '@/api/domains/terminal'

// 排队指令 store 单测（P-20261003-248）：批量读缓存 / 写口回写 / 手动发送 /
// 回执对账门控。自动发送本体在服务端回执引擎（Go 单测覆盖），这里验证前端
// 感知层——store 是缓存不是事实源

function entry(sessionId: string, texts: string[], autoSend = true, busy = false): SessionQueueEntry {
  return {
    sessionId,
    items: texts.map((text, i) => ({ text, queuedAt: `2026-10-06T10:00:0${i}Z` })),
    autoSend,
    busy,
  }
}

vi.mock('@/api/domains/terminal', () => ({
  terminalApi: {
    listQueues: vi.fn(),
    enqueueQueueItem: vi.fn(),
    replaceQueueItems: vi.fn(),
    broadcastWrite: vi.fn(),
  },
}))

describe('agentQueue store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(terminalApi.listQueues).mockReset()
    vi.mocked(terminalApi.enqueueQueueItem).mockReset()
    vi.mocked(terminalApi.replaceQueueItems).mockReset()
    vi.mocked(terminalApi.broadcastWrite).mockReset()
  })

  it('批量读回填缓存：空队列缺席、busy/autoSend 布尔归一', async () => {
    vi.mocked(terminalApi.listQueues).mockResolvedValue({
      data: { queues: [entry('a1', ['一', '二']), entry('a2', [], false, true)] },
    } as unknown as Awaited<ReturnType<typeof terminalApi.listQueues>>)
    const store = useAgentQueueStore()
    await store.refreshAll()
    expect(store.loaded).toBe(true)
    expect(store.countFor('a1')).toBe(2)
    expect(store.queues['a1']?.autoSend).toBe(true)
    // 空队列会话：服务端就不回，缓存缺席即无队列
    expect(store.queues['a2']).toBeUndefined()
    expect(store.hasAny).toBe(true)
  })

  it('拉取失败静默保旧值', async () => {
    vi.mocked(terminalApi.listQueues).mockRejectedValue(new Error('boom'))
    const store = useAgentQueueStore()
    await store.refreshAll()
    expect(store.loaded).toBe(false)
    expect(store.hasAny).toBe(false)
  })

  it('排队入尾回写缓存并回告是否即时发送', async () => {
    vi.mocked(terminalApi.enqueueQueueItem).mockResolvedValue({
      data: entry('a1', ['旧的', '新指令']),
      sent: true,
    } as unknown as Awaited<ReturnType<typeof terminalApi.enqueueQueueItem>>)
    const store = useAgentQueueStore()
    const sent = await store.enqueue('a1', '新指令')
    expect(sent).toBe(true)
    expect(store.countFor('a1')).toBe(2)
    expect(store.queues['a1']?.items[1]?.text).toBe('新指令')
  })

  it('发送后队列变空：缓存条目随 applyEntry 移除（徽标归零）', async () => {
    vi.mocked(terminalApi.enqueueQueueItem).mockResolvedValue({
      data: entry('a1', []),
      sent: true,
    } as unknown as Awaited<ReturnType<typeof terminalApi.enqueueQueueItem>>)
    const store = useAgentQueueStore()
    store.applyEntry(entry('a1', ['旧']))
    expect(store.countFor('a1')).toBe(1)
    await store.enqueue('a1', 'x')
    expect(store.countFor('a1')).toBe(0)
    expect(store.hasAny).toBe(false)
  })

  it('手动发送：broadcast-write 补 \\r 直写 + 整表摘除该条', async () => {
    vi.mocked(terminalApi.broadcastWrite).mockResolvedValue({
      data: { written: 1, missing: [], failed: [] },
    } as unknown as Awaited<ReturnType<typeof terminalApi.broadcastWrite>>)
    vi.mocked(terminalApi.replaceQueueItems).mockResolvedValue({
      data: entry('a1', ['留下']),
    } as unknown as Awaited<ReturnType<typeof terminalApi.replaceQueueItems>>)
    const store = useAgentQueueStore()
    store.applyEntry(entry('a1', ['发这条', '留下']))
    await store.sendNow('a1', 0)
    expect(vi.mocked(terminalApi.broadcastWrite)).toHaveBeenCalledWith(['a1'], '发这条\r')
    expect(vi.mocked(terminalApi.replaceQueueItems)).toHaveBeenCalledWith('a1', ['留下'])
    expect(store.countFor('a1')).toBe(1)
  })

  it('手动发送下标越界不动作', async () => {
    const store = useAgentQueueStore()
    store.applyEntry(entry('a1', ['唯一']))
    await store.sendNow('a1', 5)
    expect(vi.mocked(terminalApi.broadcastWrite)).not.toHaveBeenCalled()
  })

  it('queue.changed 对账：加载过才刷新，未加载不白拉', async () => {
    vi.mocked(terminalApi.listQueues).mockResolvedValue({
      data: { queues: [] },
    } as unknown as Awaited<ReturnType<typeof terminalApi.listQueues>>)
    const store = useAgentQueueStore()
    // 未加载（本页无消费面板）：事件不触发拉取
    store.onQueueChanged()
    expect(vi.mocked(terminalApi.listQueues)).not.toHaveBeenCalled()
    await store.refreshAll()
    vi.mocked(terminalApi.listQueues).mockClear()
    // 加载过：队列已变事件触发全量刷新（自动发送后徽标/面板的唯一感知通道）
    store.applyEntry(entry('a1', ['排队中']))
    store.onQueueChanged()
    expect(vi.mocked(terminalApi.listQueues)).toHaveBeenCalledTimes(1)
  })
})
