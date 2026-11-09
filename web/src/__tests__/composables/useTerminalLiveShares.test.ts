import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { refreshTerminalLiveShares, useTerminalLiveShares } from '@/composables/useTerminalLiveShares'
import { shareApi } from '@/api/domains/share'
import type { ShareInfo } from '@/api/domains/share'

// 直播锚点表对账逻辑单测（P-20261005-161）：kind/terminalId/过期三重过滤 +
// 同会话幂等保首条 + 并发 refresh 收敛（进行中再触发只重跑一次）。轮询宿主
// 引用计数（P-20261106-7）另组 fake timers 用例；真实应用的接线语义由 e2e
// share-terminal-live-tab.spec（底部 tab）与 agent-session-share-actions.spec
// （管理页行）覆盖

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
    // 首跑放行前先把后续实现换成即时解析：首跑 finally 触发的重跑才不会挂在
    // 永不 release 的 Promise 上把模块级 refreshing 卡死（后续用例的 start/
    // refresh 会被当成「进行中」只记重跑不拉取）
    listMock.mockResolvedValue({ data: [share({ token: 'live1', terminalId: 't1' })] })
    release({ data: [share({ token: 'live1', terminalId: 't1' })] })
    await Promise.all([first, second])
    // 第一次进行中，第二次只记重跑——本用例共两次拉取（首跑 + 重跑）
    expect(listMock).toHaveBeenCalledTimes(2)
    // 等重跑落定（fire-and-forget），模块回到空闲态
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(useTerminalLiveShares().liveBySession.value.t1!.token).toBe('live1')
  })
})

// 轮询宿主引用计数（P-20261106-7 双入口）：底部终端 TerminalView 与管理页
// AgentTerminalView 各自挂载 start / 卸载 stop——BottomPanel 的 TerminalView 是
// v-if 惰性挂载，切走底部 tab 即卸载，不得掐掉管理页仍在用的共享定时器。
// 这里用 fake timers 锁三条语义：双宿主一方 stop 不停表 / 全部 stop 才停 /
// 多余 stop 不越界；倒计时基准 now 随轮询同点推进
describe('useTerminalLiveShares 轮询宿主引用计数', () => {
  it('双宿主并存：一方 stop 定时器仍在，双方都 stop 才停表', async () => {
    vi.useFakeTimers()
    const api = useTerminalLiveShares()
    try {
      listMock.mockClear()
      listMock.mockResolvedValue({ data: [] })
      api.start()
      api.start()
      // 两次 start 只起一张表、只首刷一次（第二宿主不重复拉取）
      expect(listMock).toHaveBeenCalledTimes(1)
      api.stop()
      await vi.advanceTimersByTimeAsync(30_000)
      // 仍有一宿主在场：轮询照常
      expect(listMock).toHaveBeenCalledTimes(2)
      api.stop()
      await vi.advanceTimersByTimeAsync(90_000)
      // 计数归零停表：不再拉取
      expect(listMock).toHaveBeenCalledTimes(2)
    } finally {
      // 断言中途失败也归零计数（多余 stop 钳 0 不越界），防状态泄漏到后续用例
      api.stop()
      api.stop()
      vi.useRealTimers()
    }
  })

  it('多余 stop 不越界：计数不为负，之后 start 仍能起表', async () => {
    vi.useFakeTimers()
    const api = useTerminalLiveShares()
    try {
      listMock.mockClear()
      listMock.mockResolvedValue({ data: [] })
      api.stop()
      api.stop()
      api.start()
      expect(listMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(listMock).toHaveBeenCalledTimes(2)
      api.stop()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(listMock).toHaveBeenCalledTimes(2)
    } finally {
      api.stop()
      vi.useRealTimers()
    }
  })

  it('倒计时基准 now 随轮询同点推进（徽标 title 剩余时长重算的驱动）', async () => {
    vi.useFakeTimers()
    const api = useTerminalLiveShares()
    try {
      const base = new Date('2026-11-07T10:00:00Z').getTime()
      vi.setSystemTime(base)
      listMock.mockResolvedValue({ data: [] })
      api.start()
      expect(api.now.value).toBe(base)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(api.now.value).toBe(base + 30_000)
    } finally {
      api.stop()
      vi.useRealTimers()
    }
  })
})
