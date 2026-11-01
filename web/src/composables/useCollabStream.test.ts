import { describe, expect, it, beforeEach, vi } from 'vitest'

// ── mock 边界：外部依赖只有 agentChainApi（链清单 GET）。事件聚合与棒数口径
// 是真实现（不 mock 被测逻辑本身）；监听安装/摘除走模块单例，用例间 reset ──
const { listMock } = vi.hoisted(() => ({
  listMock: vi.fn<() => Promise<unknown>>(),
}))
vi.mock('../api/domains/agentchain', () => ({
  agentChainApi: { list: () => listMock() },
}))

import {
  chainLegOf,
  resetCollabStreamForTest,
  useCollabStream,
  COLLAB_STREAM_MAX_ROWS,
  COLLAB_CHAIN_COOLDOWN_MS,
  type CollabChainRow,
  type CollabMessageRow,
  type CollabReadRow,
} from './useCollabStream'
import { OPS_CHAIN_TRIGGERED, OPS_TERMINAL_MESSAGE, OPS_TERMINAL_MESSAGE_READ } from '../utils/opsEvents'
import type { AgentChainItem } from '../api/domains/agentchain'

function fire(type: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(type, { detail }))
}

const chainOf = (over: Partial<AgentChainItem>): AgentChainItem => ({
  id: 'chain-1',
  sourceTerminalId: 'agent-a',
  promptTemplate: 'continue',
  createdAt: '2026-10-24T00:00:00Z',
  sourceAlive: true,
  ...over,
})

beforeEach(() => {
  resetCollabStreamForTest()
  listMock.mockReset()
  listMock.mockResolvedValue({ data: [] })
})

describe('chainLegOf 棒数口径', () => {
  it('第 n 次触发拉起第 n+1 棒（链源 = 第 1 棒）', () => {
    expect(chainLegOf(1)).toBe(2)
    expect(chainLegOf(3)).toBe(4)
  })
  it('未触发/脏值 = null（行上不显示棒数，不猜）', () => {
    expect(chainLegOf(undefined)).toBeNull()
    expect(chainLegOf(0)).toBeNull()
    expect(chainLegOf(-1)).toBeNull()
  })
})

describe('useCollabStream 三事件源聚合', () => {
  it('terminal.message → message 行（载荷字段直传）', () => {
    const { rows } = useCollabStream()
    fire(OPS_TERMINAL_MESSAGE, { from: 'agent-a', to: 'agent-b', summary: '跑完测试了', at: 1234 })
    expect(rows.value).toHaveLength(1)
    const row = rows.value[0] as CollabMessageRow
    expect(row.kind).toBe('message')
    expect(row.fromId).toBe('agent-a')
    expect(row.toId).toBe('agent-b')
    expect(row.summary).toBe('跑完测试了')
    expect(row.at).toBe(1234)
  })

  it('terminal.message.read → read 行（count 缺失/脏值守卫为 1）', () => {
    const { rows } = useCollabStream()
    fire(OPS_TERMINAL_MESSAGE_READ, { sessionId: 'agent-b', count: 3 })
    fire(OPS_TERMINAL_MESSAGE_READ, { sessionId: 'agent-b' })
    expect(rows.value).toHaveLength(2)
    expect((rows.value[0] as CollabReadRow).count).toBe(1)
    expect((rows.value[1] as CollabReadRow).count).toBe(3)
    expect((rows.value[1] as CollabReadRow).sessionId).toBe('agent-b')
  })

  it('chain.triggered → chain 行 + 链清单增量重读', async () => {
    listMock.mockResolvedValue({ data: [chainOf({ triggerCount: 1, lastSessionId: 'agent-b' })] })
    const { rows, chains, chainsById } = useCollabStream()
    fire(OPS_CHAIN_TRIGGERED, { chainId: 'chain-1', sourceTerminalId: 'agent-a', status: 'done', sessionId: 'agent-b' })
    const row = rows.value[0] as CollabChainRow
    expect(row.kind).toBe('chain')
    expect(row.chainId).toBe('chain-1')
    expect(row.sourceId).toBe('agent-a')
    expect(row.nextId).toBe('agent-b')
    expect(row.status).toBe('done')
    await vi.waitFor(() => expect(chains.value).toHaveLength(1))
    expect(chainsById.value.get('chain-1')?.triggerCount).toBe(1)
  })

  it('缺 to/sessionId/chainId 的坏载荷不入行（防御直通分发的未知形态）', () => {
    const { rows } = useCollabStream()
    fire(OPS_TERMINAL_MESSAGE, { from: 'agent-a' })
    fire(OPS_TERMINAL_MESSAGE_READ, {})
    fire(OPS_CHAIN_TRIGGERED, { chainId: 'chain-1' })
    fire(OPS_CHAIN_TRIGGERED, undefined)
    expect(rows.value).toHaveLength(0)
  })

  it('新→旧排序，封顶截旧（COLLAB_STREAM_MAX_ROWS）', () => {
    const { rows } = useCollabStream()
    for (let i = 0; i < COLLAB_STREAM_MAX_ROWS + 5; i++) {
      fire(OPS_TERMINAL_MESSAGE, { from: 'a', to: 'b', summary: `m${i}`, at: 1000 + i })
    }
    expect(rows.value).toHaveLength(COLLAB_STREAM_MAX_ROWS)
    expect((rows.value[0] as CollabMessageRow).summary).toBe(`m${COLLAB_STREAM_MAX_ROWS + 4}`)
    expect((rows.value.at(-1) as CollabMessageRow).summary).toBe('m5')
  })

  it('模块级单例：多实例共享同一份流', () => {
    const a = useCollabStream()
    fire(OPS_TERMINAL_MESSAGE, { from: 'a', to: 'b', summary: 'x', at: 1 })
    const b = useCollabStream()
    expect(b.rows.value).toHaveLength(1)
    expect(b.rows.value[0]!.id).toBe(a.rows.value[0]!.id)
  })
})

describe('refreshChains 链清单回填', () => {
  it('成功装载 + loaded 置位；失败静默保旧（failed 置位不清空）', async () => {
    const { chains, chainsLoaded, chainsFailed, refreshChains } = useCollabStream()
    listMock.mockResolvedValueOnce({ data: [chainOf({ sourceAlive: true, sourceName: 'A' })] })
    await refreshChains()
    expect(chains.value).toHaveLength(1)
    expect(chainsLoaded.value).toBe(true)
    expect(chainsFailed.value).toBe(false)
    listMock.mockRejectedValueOnce(new Error('network'))
    await refreshChains()
    expect(chainsFailed.value).toBe(true)
    expect(chains.value).toHaveLength(1) // 静默保旧
  })
})

describe('冷却注记口径', () => {
  it('COLLAB_CHAIN_COOLDOWN_MS 与服务端 triggerCooldown 镜像（1 分钟）', () => {
    expect(COLLAB_CHAIN_COOLDOWN_MS).toBe(60_000)
  })
})
