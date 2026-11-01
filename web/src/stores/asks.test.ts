import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAsksStore } from '@/stores/asks'
import { opsAskApi, type AskRecord } from '@/api/domains/opsask'

// 提问 store 冷启动/重连补账（P-20261001-19）单测：seedPending 走 /ops-ask
// 列表回填 pending，非 pending 项经 upsert 走清账语义（与审批 seedPending 同模式）

function rec(id: string, status: AskRecord['status']): AskRecord {
  return { id, question: `q-${id}`, status }
}

vi.mock('@/api/domains/opsask', () => ({
  opsAskApi: {
    list: vi.fn(),
    answer: vi.fn(),
  },
}))

describe('asks store seedPending', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(opsAskApi.list).mockReset()
  })

  it('列表 pending 项回填进卡堆', async () => {
    vi.mocked(opsAskApi.list).mockResolvedValue({
      data: [rec('a1', 'pending'), rec('a2', 'pending')],
    } as unknown as Awaited<ReturnType<typeof opsAskApi.list>>)
    const store = useAsksStore()
    await store.seedPending()
    expect(store.pendingCount).toBe(2)
    expect(store.pendingList.map(a => a.id)).toEqual(['a1', 'a2'])
  })

  it('非 pending 项只清不加：已作答/过期项不回填且清掉同 id 本地残留', async () => {
    vi.mocked(opsAskApi.list).mockResolvedValue({
      data: [rec('done', 'answered'), rec('stale', 'expired')],
    } as unknown as Awaited<ReturnType<typeof opsAskApi.list>>)
    const store = useAsksStore()
    // 本地残留的 stale 项（断线前广播入账）被列表的 expired 权威态清掉
    store.upsert(rec('stale', 'pending'))
    expect(store.pendingCount).toBe(1)
    await store.seedPending()
    expect(store.pendingCount).toBe(0)
  })

  it('列表与广播无序竞态无害：同 id 覆盖，seed 不清广播先行入账的项', async () => {
    vi.mocked(opsAskApi.list).mockResolvedValue({
      data: [rec('a1', 'pending')],
    } as unknown as Awaited<ReturnType<typeof opsAskApi.list>>)
    const store = useAsksStore()
    store.upsert(rec('live', 'pending')) // 广播先到（不在列表快照里）
    await store.seedPending()
    expect(store.pendingCount).toBe(2)
    expect(store.pending['live']).toBeTruthy()
  })

  it('列表拉取失败静默：不抛出、保留现状', async () => {
    vi.mocked(opsAskApi.list).mockRejectedValue(new Error('boom'))
    const store = useAsksStore()
    store.upsert(rec('keep', 'pending'))
    await expect(store.seedPending()).resolves.toBeUndefined()
    expect(store.pendingCount).toBe(1)
  })
})
