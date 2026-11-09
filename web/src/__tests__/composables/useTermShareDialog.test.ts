import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useTermShareDialog } from '@/composables/useTermShareDialog'
import { useShareDialog } from '@/composables/useShareDialog'
import { confirmDialog } from '@/composables/useDialog'
import { shareApi } from '@/api/domains/share'
import type { ShareInfo } from '@/api/domains/share'

// 终端输出分享选项流单测（P-20261106-9）：安全默认（每次打开重置为遮蔽开/水印
// 开）、确认载荷映射（开关 → unfiltered/watermark 字段）、出域警示的确认/取消
// 分流、遮蔽模式与生效记录不一致的 modeMismatch 回告、敏感会话闸门 override
// 契约不变。两类警示确认（未过滤出域 / 敏感会话出域）都经 useDialog.confirmDialog，
// 以其 mock 编排用户选择；结果卡的地址计划/网络取数全 mock（单元只验证流程编排）；
// UI 呈现由 e2e 覆盖

vi.mock('@/api/domains/share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/domains/share')>()
  return {
    ...actual,
    shareApi: {
      ...actual.shareApi,
      createTerminal: vi.fn(),
      createTerminalFrozen: vi.fn(),
      setExpiry: vi.fn(),
      status: vi.fn(),
    },
  }
})

vi.mock('@/api/domains/system', () => ({
  settingsApi: { get: vi.fn().mockResolvedValue({ data: {} }) },
  networkApi: { list: vi.fn().mockResolvedValue({ data: [] }) },
}))

vi.mock('@/composables/useDialog', () => ({
  confirmDialog: vi.fn(),
}))

const shareCreate = vi.mocked(shareApi.createTerminal)
const shareFrozen = vi.mocked(shareApi.createTerminalFrozen)
const setExpiryMock = vi.mocked(shareApi.setExpiry)
const statusMock = vi.mocked(shareApi.status)
const confirmMock = vi.mocked(confirmDialog)

/** 造一条创建响应记录（缺省 = 遮蔽直播） */
function createdShare(over: Partial<ShareInfo>): ShareInfo {
  return {
    token: 'tok',
    kind: 'terminal',
    projectId: '',
    projectName: '',
    path: '',
    name: 'session',
    isDir: false,
    size: 0,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

beforeEach(() => {
  shareCreate.mockReset()
  shareFrozen.mockReset()
  setExpiryMock.mockReset()
  statusMock.mockReset()
  confirmMock.mockReset()
  statusMock.mockResolvedValue({ data: { running: true, port: 0, scheme: '' } } as never)
})

afterEach(() => {
  // 结果卡单例清场（创建成功会弹出），防跨用例残留
  useShareDialog().closeResult()
  useTermShareDialog().cancelTermOptions()
})

describe('useTermShareDialog 选项流', () => {
  it('打开弹层即重置为安全基线（遮蔽开、水印开），入口本身不发请求', () => {
    const term = useTermShareDialog()
    term.createTerminalLive('s1')
    expect(term.showTermOptions.value).toBe(true)
    expect(term.termMask.value).toBe(true)
    expect(term.termWatermark.value).toBe(true)
    expect(term.termOptionsTarget.value).toEqual({ kind: 'live', sessionId: 's1', name: 's1' })
    expect(shareCreate).not.toHaveBeenCalled()

    // 上一次把遮蔽关掉，下一次打开必须回到遮蔽开（残留会把 opt-out 带给下一目标）
    term.termMask.value = false
    term.termWatermark.value = false
    term.createTerminalFrozen('s2')
    expect(term.termMask.value).toBe(true)
    expect(term.termWatermark.value).toBe(true)
    expect(term.termOptionsTarget.value).toEqual({ kind: 'frozen', sessionId: 's2', name: 's2' })
    term.cancelTermOptions()
    expect(term.showTermOptions.value).toBe(false)
  })

  it('遮蔽开确认：不弹出域警示，载荷 unfiltered:false，成功关弹层并弹结果卡', async () => {
    const term = useTermShareDialog()
    term.createTerminalLive('s1')
    shareCreate.mockResolvedValue({ data: createdShare({ token: 'tok1' }) } as never)
    const res = await term.confirmTermOptions()
    expect(res).toBe('created')
    expect(confirmMock).not.toHaveBeenCalled()
    expect(shareCreate).toHaveBeenCalledWith('s1', undefined, false, { unfiltered: false, watermark: true })
    expect(term.showTermOptions.value).toBe(false)
    expect(useShareDialog().showResult.value).toBe(true)
    expect(useShareDialog().resultShare.value?.token).toBe('tok1')
  })

  it('关闭遮蔽且出域警示取消：不发请求、弹层保持打开', async () => {
    const term = useTermShareDialog()
    term.createTerminalFrozen('s1')
    term.termMask.value = false
    confirmMock.mockResolvedValueOnce(false)
    const res = await term.confirmTermOptions()
    expect(res).toBe('cancelled')
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(shareFrozen).not.toHaveBeenCalled()
    expect(term.showTermOptions.value).toBe(true)
    expect(term.termSubmitting.value).toBe(false)
  })

  it('关闭遮蔽且确认：载荷 unfiltered:true（水印开关同传），与生效记录一致返回 created', async () => {
    const term = useTermShareDialog()
    term.createTerminalFrozen('s1')
    term.termMask.value = false
    term.termWatermark.value = false
    confirmMock.mockResolvedValueOnce(true)
    shareFrozen.mockResolvedValue({ data: createdShare({ token: 'tok2', kind: 'terminal-frozen', unfiltered: true }) } as never)
    const res = await term.confirmTermOptions()
    expect(res).toBe('created')
    expect(shareFrozen).toHaveBeenCalledWith('s1', false, { unfiltered: true, watermark: false })
    expect(term.showTermOptions.value).toBe(false)
  })

  it('幂等命中既有遮蔽直播（请求未过滤）：回告 modeMismatch，结果卡展示生效记录', async () => {
    const term = useTermShareDialog()
    term.createTerminalLive('s1')
    term.termMask.value = false
    confirmMock.mockResolvedValueOnce(true)
    shareCreate.mockResolvedValue({ data: createdShare({ token: 'tok3' }) } as never)
    const res = await term.confirmTermOptions()
    expect(res).toBe('modeMismatch')
    expect(term.showTermOptions.value).toBe(false)
    expect(useShareDialog().resultShare.value?.unfiltered).toBeUndefined()
  })

  it('敏感会话闸门：取消 → cancelled 弹层保持；确认 → override 二次请求同参', async () => {
    const term = useTermShareDialog()
    term.createTerminalLive('s1')
    shareCreate.mockResolvedValueOnce({ warnings: ['session is sensitive'] } as never)
    confirmMock.mockResolvedValueOnce(false)
    expect(await term.confirmTermOptions()).toBe('cancelled')
    expect(term.showTermOptions.value).toBe(true)
    expect(shareCreate).toHaveBeenCalledTimes(1)

    shareCreate.mockResolvedValueOnce({ warnings: ['session is sensitive'] } as never)
    shareCreate.mockResolvedValueOnce({ data: createdShare({ token: 'tok4' }) } as never)
    confirmMock.mockResolvedValueOnce(true)
    expect(await term.confirmTermOptions()).toBe('created')
    expect(shareCreate).toHaveBeenLastCalledWith('s1', undefined, true, { unfiltered: false, watermark: true })
    expect(term.showTermOptions.value).toBe(false)
  })

  it('请求失败（无 data 无 warnings）：返回 failed，弹层保持可重试', async () => {
    const term = useTermShareDialog()
    term.createTerminalFrozen('s1')
    shareFrozen.mockRejectedValueOnce(new Error('boom'))
    expect(await term.confirmTermOptions()).toBe('failed')
    expect(term.showTermOptions.value).toBe(true)
    expect(term.termSubmitting.value).toBe(false)
  })

  // ── 有效期（P-20261107-4①）与口令（⑤） ──

  it('打开弹层重置安全基线：口令空、直播跟随默认档、快照回 30d 未触碰', () => {
    const term = useTermShareDialog()
    term.termPassphrase.value = 'leaked'
    term.termLiveTtlMinutes.value = 1440
    term.termFrozenTtlChoice.value = 'permanent'
    term.termFrozenTtlDate.value = 1
    term.termFrozenTtlTouched.value = true
    term.createTerminalLive('s1')
    expect(term.termPassphrase.value).toBe('')
    expect(term.termLiveTtlMinutes.value).toBe(0)
    term.createTerminalFrozen('s2')
    expect(term.termFrozenTtlChoice.value).toBe('30d')
    expect(term.termFrozenTtlDate.value).toBeNull()
    expect(term.termFrozenTtlTouched.value).toBe(false)
    term.cancelTermOptions()
  })

  it('直播显式档位随创建请求发出（ttlMinutes）；口令随 opts 携带', async () => {
    const term = useTermShareDialog()
    term.createTerminalLive('s1')
    term.termLiveTtlMinutes.value = 60
    term.termPassphrase.value = 'door-key'
    shareCreate.mockResolvedValue({ data: createdShare({ token: 'tok-ttl', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }) } as never)
    expect(await term.confirmTermOptions()).toBe('created')
    // fresh 创建服务端已按 ttlMinutes 落（expiresAt 在对账允许窗内）→ 不二次请求
    expect(shareCreate).toHaveBeenCalledWith('s1', 60, false, { unfiltered: false, watermark: true, passphrase: 'door-key' })
    expect(setExpiryMock).not.toHaveBeenCalled()
    // 结果卡带口令（邀请文案数据源）
    expect(useShareDialog().resultPassphrase.value).toBe('door-key')
  })

  it('直播档位 0 = 跟随默认：不发 ttlMinutes 字段', async () => {
    const term = useTermShareDialog()
    term.createTerminalLive('s1')
    shareCreate.mockResolvedValue({ data: createdShare({ token: 'tok-def' }) } as never)
    expect(await term.confirmTermOptions()).toBe('created')
    expect(shareCreate).toHaveBeenCalledWith('s1', undefined, false, { unfiltered: false, watermark: true })
  })

  it('直播幂等命中旧倒计时：显式档位经 setExpiry 对账生效，结果卡展示生效记录', async () => {
    const term = useTermShareDialog()
    term.createTerminalLive('s1')
    term.termLiveTtlMinutes.value = 60
    const stale = createdShare({ token: 'tok-old', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() })
    shareCreate.mockResolvedValue({ data: stale } as never)
    setExpiryMock.mockResolvedValue({ data: createdShare({ token: 'tok-old', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }) } as never)
    expect(await term.confirmTermOptions()).toBe('created')
    expect(setExpiryMock).toHaveBeenCalledTimes(1)
    const arg = setExpiryMock.mock.calls[0]
    expect(arg[0]).toBe('tok-old')
    expect(Math.abs(new Date(arg[1] as string).getTime() - (Date.now() + 60 * 60_000))).toBeLessThan(10_000)
    expect(useShareDialog().resultShare.value?.expiresAt).toBeTruthy()
  })

  it('快照显式档位：创建后经 setExpiry 生效（30d 未触碰不发；1d/persistent 各映射正确）', async () => {
    const term = useTermShareDialog()
    // 未触碰：零额外请求（保持服务端默认 30 天，存量语义）
    term.createTerminalFrozen('s1')
    shareFrozen.mockResolvedValue({ data: createdShare({ token: 'tok-f1', kind: 'terminal-frozen' }) } as never)
    expect(await term.confirmTermOptions()).toBe('created')
    expect(setExpiryMock).not.toHaveBeenCalled()
    useShareDialog().closeResult()

    // 显式 1 天：setExpiry ≈ now+24h
    term.createTerminalFrozen('s2')
    term.termFrozenTtlChoice.value = '1d'
    term.termFrozenTtlTouched.value = true
    shareFrozen.mockResolvedValue({ data: createdShare({ token: 'tok-f2', kind: 'terminal-frozen' }) } as never)
    setExpiryMock.mockResolvedValue({ data: createdShare({ token: 'tok-f2', kind: 'terminal-frozen' }) } as never)
    expect(await term.confirmTermOptions()).toBe('created')
    expect(Math.abs(new Date(setExpiryMock.mock.calls[0]![1] as string).getTime() - (Date.now() + 24 * 60 * 60_000))).toBeLessThan(10_000)
    useShareDialog().closeResult()

    // 显式永久：setExpiry(null)（清窗语义；未过滤记录由服务端钳 24h）
    term.createTerminalFrozen('s3')
    term.termFrozenTtlChoice.value = 'permanent'
    term.termFrozenTtlTouched.value = true
    shareFrozen.mockResolvedValue({ data: createdShare({ token: 'tok-f3', kind: 'terminal-frozen' }) } as never)
    setExpiryMock.mockResolvedValue({ data: createdShare({ token: 'tok-f3', kind: 'terminal-frozen' }) } as never)
    expect(await term.confirmTermOptions()).toBe('created')
    expect(setExpiryMock.mock.calls[1]![1]).toBeNull()
  })

  it('快照口令随创建请求携带（服务端 P-20261107-4 起创建面同收）', async () => {
    const term = useTermShareDialog()
    term.createTerminalFrozen('s1')
    term.termPassphrase.value = 'snap-key'
    shareFrozen.mockResolvedValue({ data: createdShare({ token: 'tok-pass', kind: 'terminal-frozen' }) } as never)
    expect(await term.confirmTermOptions()).toBe('created')
    expect(shareFrozen).toHaveBeenCalledWith('s1', false, { unfiltered: false, watermark: true, passphrase: 'snap-key' })
  })
})
