import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { refreshDirectInputShares, useDirectInputShares } from '@/composables/useDirectInputShares'
import { shareApi } from '@/api/domains/share'
import type { ShareInfo } from '@/api/domains/share'

// 直通输入锚点表对账逻辑单测：持权表 holdBySession（P-20261024-1）+ 待批
// 申请双表 pendingByToken/pendingBySession（P-20261121-2——此前 pending 分支
// 被显式丢弃、owner 面零待批投影，申请-批准握手断裂的投影半边）。消费面接线
// 语义由 e2e share-collab.spec（申请必达/行内批准钮/拒绝菜单）覆盖

vi.mock('@/api/domains/share', () => ({
  shareApi: { list: vi.fn() },
}))

const listMock = vi.mocked(shareApi.list)

/** 造一条分享记录（缺省 = kind=terminal 锚定 t1） */
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
  return refreshDirectInputShares()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDirectInputShares 锚点表对账', () => {
  it('pending 行入双表：pendingByToken（管理器行）+ pendingBySession（会话行徽标），不入持权表', async () => {
    listMock.mockResolvedValue({ data: [
      share({
        token: 'pend1',
        terminalId: 't1',
        direct: { held: false, pending: true, nick: '同事乙', expiresIn: 600 },
      }),
    ] })
    await refreshDirectInputShares()
    const api = useDirectInputShares()
    expect(api.holdBySession.value.t1).toBeUndefined()
    expect(api.pendingByToken.value.pend1).toMatchObject({ token: 'pend1', nick: '同事乙', expiresIn: 600 })
    expect(api.pendingBySession.value.t1).toMatchObject({ token: 'pend1', nick: '同事乙' })
  })

  it('expiresIn<=0 的 pending 视同已过期先摘（服务端惰性清扫可能滞后）', async () => {
    listMock.mockResolvedValue({ data: [
      share({ token: 'stale', terminalId: 't1', direct: { held: false, pending: true, expiresIn: -3 } }),
    ] })
    await refreshDirectInputShares()
    const api = useDirectInputShares()
    expect(api.pendingByToken.value.stale).toBeUndefined()
    expect(api.pendingBySession.value.t1).toBeUndefined()
  })

  it('同 token 双 pending 保首条（服务端单申请面语义，防御式）；会话行同面', async () => {
    listMock.mockResolvedValue({ data: [
      share({ token: 'first', terminalId: 't1', direct: { held: false, pending: true, nick: '甲', expiresIn: 100 } }),
      share({ token: 'first', terminalId: 't1', direct: { held: false, pending: true, nick: '乙', expiresIn: 90 } }),
    ] })
    await refreshDirectInputShares()
    const api = useDirectInputShares()
    expect(api.pendingByToken.value.first?.nick).toBe('甲')
    expect(api.pendingBySession.value.t1?.nick).toBe('甲')
  })

  it('held 行照旧入持权表，且不落待批双表（hold 与 pending 互斥投影）', async () => {
    listMock.mockResolvedValue({ data: [
      share({ token: 'hold1', terminalId: 't1', direct: { held: true, nick: '丙', visitorTail: 'abc12345', expiresIn: 500 } }),
    ] })
    await refreshDirectInputShares()
    const api = useDirectInputShares()
    expect(api.holdBySession.value.t1).toMatchObject({ token: 'hold1', nick: '丙' })
    expect(api.pendingByToken.value.hold1).toBeUndefined()
    expect(api.pendingBySession.value.t1).toBeUndefined()
  })

  it('wtyping 行照旧入持权表（writable 标记），待批双表零污染', async () => {
    listMock.mockResolvedValue({ data: [
      share({ token: 'w1', terminalId: 't2', wtyping: { visitors: 2 } }),
    ] })
    await refreshDirectInputShares()
    const api = useDirectInputShares()
    expect(api.holdBySession.value.t2).toMatchObject({ token: 'w1', writable: true })
    expect(api.pendingByToken.value.w1).toBeUndefined()
  })

  it('无 terminalId 的行跳过（锚点键缺失不入任何表）', async () => {
    listMock.mockResolvedValue({ data: [
      share({ token: 'noanchor', direct: { held: false, pending: true, expiresIn: 100 } }),
    ] })
    await refreshDirectInputShares()
    const api = useDirectInputShares()
    expect(api.pendingByToken.value.noanchor).toBeUndefined()
  })

  it('撤销/过期后下轮对账整体替换摘除（双表同规）', async () => {
    listMock.mockResolvedValue({ data: [
      share({ token: 'pend1', terminalId: 't1', direct: { held: false, pending: true, expiresIn: 100 } }),
    ] })
    await refreshDirectInputShares()
    const api = useDirectInputShares()
    expect(api.pendingByToken.value.pend1).toBeTruthy()
    listMock.mockResolvedValue({ data: [] })
    await refreshDirectInputShares()
    expect(api.pendingByToken.value.pend1).toBeUndefined()
    expect(api.pendingBySession.value.t1).toBeUndefined()
  })

  it('拉取失败维持现状（下轮对账自愈，不打扰）', async () => {
    listMock.mockResolvedValue({ data: [
      share({ token: 'pend1', terminalId: 't1', direct: { held: false, pending: true, expiresIn: 100 } }),
    ] })
    await refreshDirectInputShares()
    listMock.mockRejectedValue(new Error('network down'))
    await refreshDirectInputShares()
    expect(useDirectInputShares().pendingByToken.value.pend1).toBeTruthy()
  })
})
