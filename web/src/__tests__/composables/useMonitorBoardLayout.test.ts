import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { uiStateApi } from '@/api/client'

// 值班大屏卡片类目布局胶水层（P-20261004-18）：恢复/重排/显隐 toggle 与
// uiState monitorBoard 命名空间的持久化闭环。useMonitorBoardLayout 是组件域
// 工厂（非模块级单例——/monitor 每次进入都值得取服务端最新布局），用例内
// 直接新建；pinia + api client mock 承接 store 依赖

vi.mock('@/api/client', () => ({
  uiStateApi: { get: vi.fn(), update: vi.fn(), patch: vi.fn() },
  setInstanceContext: vi.fn(),
}))

function mockServerData(all: Record<string, unknown>) {
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: all } as Awaited<ReturnType<typeof uiStateApi.get>>)
}

async function freshBoard() {
  setActivePinia(createPinia())
  const { useMonitorBoardLayout } = await import('@/composables/useMonitorBoardLayout')
  return useMonitorBoardLayout()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: {} } as Awaited<ReturnType<typeof uiStateApi.get>>)
  vi.mocked(uiStateApi.update).mockResolvedValue({} as Awaited<ReturnType<typeof uiStateApi.update>>)
  vi.mocked(uiStateApi.patch).mockResolvedValue({} as Awaited<ReturnType<typeof uiStateApi.patch>>)
})

describe('useMonitorBoardLayout（值班大屏类目布局 P-20261004-18）', () => {
  it('restore：从服务端恢复顺序与隐藏集', async () => {
    mockServerData({ local: { monitorBoard: { cardOrder: ['approvals', 'sessions'], hiddenCards: ['asks'] } } })
    const board = await freshBoard()
    await board.restore()
    expect(board.cardOrder.value).toEqual(['approvals', 'sessions'])
    expect(board.hiddenCards.value).toEqual(['asks'])
  })

  it('restore：脏形状/无记录回落默认（null 手动序 + 全显示），且不写盘', async () => {
    mockServerData({ local: { monitorBoard: { cardOrder: 'bogus', hiddenCards: 42 } } })
    const board = await freshBoard()
    await board.restore()
    expect(board.cardOrder.value).toBeNull()
    expect(board.hiddenCards.value).toEqual([])
    expect(uiStateApi.patch).not.toHaveBeenCalled()
  })

  it('moveCard：重排产出全序并即时落盘 monitorBoard 键', async () => {
    const board = await freshBoard()
    await board.restore()
    expect(board.moveCard('approvals', 'fleet')).toBe(true)
    // insert-before：approvals 移到 fleet 前
    expect(board.cardOrder.value).toEqual(['approvals', 'fleet', 'asks', 'tasks', 'sessions'])
    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0][0] as Record<string, { monitorBoard?: { cardOrder?: string[]; hiddenCards?: string[] } }>
    expect(payload.local?.monitorBoard?.cardOrder).toEqual(['approvals', 'fleet', 'asks', 'tasks', 'sessions'])
    expect(payload.local?.monitorBoard?.hiddenCards).toEqual([])
  })

  it('moveCard：同名/未知 id no-op 不写盘', async () => {
    const board = await freshBoard()
    await board.restore()
    expect(board.moveCard('approvals', 'approvals')).toBe(false)
    expect(board.moveCard('bogus', 'asks')).toBe(false)
    expect(uiStateApi.patch).not.toHaveBeenCalled()
  })

  it('toggleCardHidden：显隐 toggle 并落盘；重复 toggle 恢复显示', async () => {
    const board = await freshBoard()
    await board.restore()
    board.toggleCardHidden('sessions')
    expect(board.hiddenCards.value).toEqual(['sessions'])
    board.toggleCardHidden('asks')
    expect(board.hiddenCards.value).toEqual(['sessions', 'asks'])
    board.toggleCardHidden('sessions')
    expect(board.hiddenCards.value).toEqual(['asks'])
    const payload = vi.mocked(uiStateApi.patch).mock.calls.at(-1)![0] as Record<string, { monitorBoard?: { hiddenCards?: string[] } }>
    expect(payload.local?.monitorBoard?.hiddenCards).toEqual(['asks'])
  })

  it('未定制时落盘 cardOrder=[]：读取端 normalize 视为未定制（不落幽灵定制）', async () => {
    const board = await freshBoard()
    board.toggleCardHidden('tasks')
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0][0] as Record<string, { monitorBoard?: { cardOrder?: string[] } }>
    expect(payload.local?.monitorBoard?.cardOrder).toEqual([])
    // 往返一致：空序读回 = null（未定制）
    mockServerData({ local: payload.local })
    const board2 = await freshBoard()
    await board2.restore()
    expect(board2.cardOrder.value).toBeNull()
    expect(board2.hiddenCards.value).toEqual(['tasks'])
  })

  it('持久化失败静默：patch 抛错不上抛，会话内状态仍生效', async () => {
    vi.mocked(uiStateApi.patch).mockRejectedValue(new Error('network down'))
    const board = await freshBoard()
    await board.restore()
    expect(() => board.toggleCardHidden('fleet')).not.toThrow()
    expect(board.hiddenCards.value).toEqual(['fleet'])
  })
})
