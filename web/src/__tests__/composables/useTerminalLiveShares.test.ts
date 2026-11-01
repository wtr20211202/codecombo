import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { refreshTerminalLiveShares, useTerminalLiveShares } from '@/composables/useTerminalLiveShares'
import { shareApi } from '@/api/domains/share'
import type { ShareInfo } from '@/api/domains/share'

// 直播锚点表对账逻辑单测（P-20261005-161）：kind/terminalId/过期三重过滤 +
// 同会话幂等保首条 + 并发 refresh 收敛（进行中再触发只重跑一次）。轮询生命周期
// （start/stop 的 setInterval 接线）不做时间 fake——接线语义由 e2e
// share-terminal-live-tab.spec 走真实应用覆盖

vi.mock('@/api/domains/share', () => ({
  shareApi: { list: vi.fn() },
}))

const listMock = vi.mocked(shareApi.list)

/** 造一条分享记录（缺省 = 未过期 kind=terminal 锚定 t1） */
function share(over: Partial<ShareInfo>): ShareInfo {
  return {
    token: 'tok',
    kind: 'terminal',
    projectId: 'p',
    projectName: 'P',
    path: '',
    name: 'session',
    isDir: false,
    size: 0,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

beforeEach(() => {
  listMock.mockReset()
  // 每用例从空表出发（模块级单例状态）
  listMock.mockResolvedValue({ data: [] })
  return refreshTerminalLiveShares()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTerminalLiveShares 锚点表对账', () => {
  it('只收 kind=terminal 且带 terminalId 的未过期记录', async () => {
    listMock.mockResolvedValue({ data: [
      share({ token: 'live1', terminalId: 't1', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
      share({ token: 'file', kind: 'file' }),
      share({ token: 'frozen', kind: 'terminal-frozen', terminalId: 't2' }),
      share({ token: 'noanchor', kind: 'terminal' }),
      share({ token: 'expired', terminalId: 't3', expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ] })
    await refreshTerminalLiveShares()
    const live = useTerminalLiveShares().liveBySession.value
    expect(Object.keys(live)).toEqual(['t1'])
    expect(live.t1!.token).toBe('live1')
  })

  it('无 expiresAt 视为未过期（防御：服务端钳 24h 上限，理论不出现）', async () => {
    listMock.mockResolvedValue({ data: [share({ token: 'live1', terminalId: 't1' })] })
    await refreshTerminalLiveShares()
    expect(useTerminalLiveShares().liveBySession.value.t1!.token).toBe('live1')
  })

  it('同会话多条记录保首条（服务端幂等同链，防御式）', async () => {
    listMock.mockResolvedValue({ data: [
      share({ token: 'first', terminalId: 't1' }),
      share({ token: 'second', terminalId: 't1' }),
    ] })
    await refreshTerminalLiveShares()
    expect(useTerminalLiveShares().liveBySession.value.t1!.token).toBe('first')
  })

  it('撤销/过期后下轮对账摘除（对账式整体替换）', async () => {
    listMock.mockResolvedValue({ data: [share({ token: 'live1', terminalId: 't1' })] })
    await refreshTerminalLiveShares()
    expect(useTerminalLiveShares().liveBySession.value.t1).toBeTruthy()
    listMock.mockResolvedValue({ data: [] })
    await refreshTerminalLiveShares()
    expect(useTerminalLiveShares().liveBySession.value.t1).toBeUndefined()
  })

  it('拉取失败维持现状（下轮对账自愈，不打扰）', async () => {
    listMock.mockResolvedValue({ data: [share({ token: 'live1', terminalId: 't1' })] })
    await refreshTerminalLiveShares()
    listMock.mockRejectedValue(new Error('network down'))
    await refreshTerminalLiveShares()
    expect(useTerminalLiveShares().liveBySession.value.t1!.token).toBe('live1')
  })

  it('并发收敛：进行中再触发只重跑一次，终态一致', async () => {
    let release!: (v: { data: ShareInfo[] }) => void
    // beforeEach 的空表首刷已计入 mock 调用数，清零后只量本用例的两跳
    listMock.mockClear()
    listMock.mockImplementation(() => new Promise<{ data: ShareInfo[] }>(resolve => { release = resolve }))
    const first = refreshTerminalLiveShares()
    const second = refreshTerminalLiveShares()
    release({ data: [share({ token: 'live1', terminalId: 't1' })] })
    await Promise.all([first, second])
    // 第一次进行中，第二次只记重跑——本用例共两次拉取（首跑 + 重跑）
    expect(listMock).toHaveBeenCalledTimes(2)
    expect(useTerminalLiveShares().liveBySession.value.t1!.token).toBe('live1')
  })
})
