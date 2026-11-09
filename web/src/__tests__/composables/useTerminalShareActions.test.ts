import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ShareInfo } from '@/api/domains/share'

// 终端能力四件 + 直播徽标投影（P-20261106-7 双入口共用件）单测：锁四个动作的
// 调用契约（直播按锚点态分流创建/撤销并对账、冻结直达、回放取最近录制/无录制
// 可行动提示、导出走出域闸→落地→敏感建议）与 liveTitles 投影（剩余时长/到界
// 摘除/无 TTL 兜底）。弹窗/结果卡/拦截器 toast 的交互面由 e2e 覆盖
// （share-terminal-live-tab.spec 底部 tab / agent-session-share-actions.spec
// 管理页行），这里只锁动作链在两入口的同一实现

// Mock useMessage（jsdom 中无 NMessageProvider）；弹窗单例与敏感建议以 hoisted
// 共享对象 mock——组合式内部持有的实例与用例断言的是同一份
const { messageMock, dialogMock, termDialogMock, hintMock } = vi.hoisted(() => ({
  messageMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  dialogMock: {
    createRecordingShare: vi.fn(),
  },
  // 直播/冻结创建链走选项弹层（P-20261106-9，useTermShareDialog）：断言「先过
  // 弹层」这一入口契约，弹层内的出域警示/创建请求交互面归其自身单测与 e2e
  termDialogMock: {
    createTerminalLive: vi.fn(),
    createTerminalFrozen: vi.fn(),
  },
  hintMock: { suggestSensitiveMarking: vi.fn() },
}))
vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return { ...actual, useMessage: () => messageMock }
})

vi.mock('@/api/domains/share', () => ({
  shareApi: { list: vi.fn(), remove: vi.fn() },
}))
vi.mock('@/api/domains/recording', () => ({
  recordingApi: { list: vi.fn() },
}))
vi.mock('@/api/domains/terminal', () => ({
  terminalApi: { exportOutput: vi.fn() },
}))
vi.mock('@/composables/useShareDialog', () => ({
  useShareDialog: () => dialogMock,
}))
vi.mock('@/composables/useTermShareDialog', () => ({
  useTermShareDialog: () => termDialogMock,
}))
vi.mock('@/composables/useEgressGate', () => ({
  fetchWithEgressGate: vi.fn(),
}))
vi.mock('@/composables/useSensitiveMarkHint', () => ({
  useSensitiveMarkHint: () => hintMock,
}))

import { shareApi } from '@/api/domains/share'
import { recordingApi } from '@/api/domains/recording'
import { terminalApi } from '@/api/domains/terminal'
import { fetchWithEgressGate } from '@/composables/useEgressGate'
import { refreshTerminalLiveShares, useTerminalLiveShares } from '@/composables/useTerminalLiveShares'
import { useTerminalShareActions } from '@/composables/useTerminalShareActions'

const listMock = vi.mocked(shareApi.list)
const removeMock = vi.mocked(shareApi.remove)
const recListMock = vi.mocked(recordingApi.list)
const exportMock = vi.mocked(terminalApi.exportOutput)
const gateMock = vi.mocked(fetchWithEgressGate)

/** 造一条活跃直播记录（kind=terminal 锚定 sessionId） */
function liveShare(sessionId: string, over: Partial<ShareInfo> = {}): ShareInfo {
  return {
    token: `tok-${sessionId}`,
    kind: 'terminal',
    projectId: 'p',
    projectName: 'P',
    path: '',
    name: 'session',
    isDir: false,
    size: 0,
    createdAt: '2026-01-01T00:00:00Z',
    terminalId: sessionId,
    ...over,
  }
}

/** 把锚点表对账到给定记录集（模块级单例，逐用例显式重置） */
async function seedLive(records: ShareInfo[]): Promise<void> {
  listMock.mockResolvedValue({ data: records } as unknown as Awaited<ReturnType<typeof shareApi.list>>)
  await refreshTerminalLiveShares()
}

beforeEach(async () => {
  listMock.mockReset()
  removeMock.mockReset()
  recListMock.mockReset()
  exportMock.mockReset()
  gateMock.mockReset()
  messageMock.success.mockReset()
  messageMock.warning.mockReset()
  dialogMock.createRecordingShare.mockReset().mockResolvedValue(undefined)
  termDialogMock.createTerminalLive.mockReset().mockResolvedValue(undefined)
  termDialogMock.createTerminalFrozen.mockReset().mockResolvedValue(undefined)
  hintMock.suggestSensitiveMarking.mockReset().mockResolvedValue(undefined)
  await seedLive([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useTerminalShareActions 直播分享/结束直播', () => {
  it('无锚点：先过选项弹层（useTermShareDialog，会话 id 寻址），不触撤销', async () => {
    const api = useTerminalShareActions()
    await api.toggleLiveShare({ id: 's1', name: 'build' })
    expect(termDialogMock.createTerminalLive).toHaveBeenCalledWith('s1')
    expect(removeMock).not.toHaveBeenCalled()
  })

  it('有锚点：DELETE 该 token + 成功提示 + 对账 bump（撤销即摘徽标），不再走创建', async () => {
    await seedLive([liveShare('s1')])
    removeMock.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof shareApi.remove>>)
    listMock.mockClear()
    const api = useTerminalShareActions()
    expect(api.liveBySession.value.s1?.token).toBe('tok-s1')
    // 撤销后列表回空：bump 对账应把锚点摘掉
    listMock.mockResolvedValue({ data: [] } as unknown as Awaited<ReturnType<typeof shareApi.list>>)
    await api.toggleLiveShare({ id: 's1', name: 'build' })
    expect(removeMock).toHaveBeenCalledWith('tok-s1')
    expect(termDialogMock.createTerminalLive).not.toHaveBeenCalled()
    expect(messageMock.success).toHaveBeenCalledTimes(1)
    // finally 里的 bump 触发一次对账拉取
    expect(listMock).toHaveBeenCalledTimes(1)
    // 等对账落定（bump 是 fire-and-forget）
    await Promise.resolve()
    await Promise.resolve()
    expect(api.liveBySession.value.s1).toBeUndefined()
  })

  it('撤销失败同样 bump 对账（失效锚点由下轮摘除），不抛', async () => {
    await seedLive([liveShare('s1')])
    removeMock.mockRejectedValue(new Error('410'))
    listMock.mockClear()
    const api = useTerminalShareActions()
    await expect(api.toggleLiveShare({ id: 's1', name: 'build' })).resolves.toBeUndefined()
    expect(messageMock.success).not.toHaveBeenCalled()
    expect(listMock).toHaveBeenCalledTimes(1)
  })
})

describe('useTerminalShareActions 冻结分享', () => {
  it('直达 useTermShareDialog.createTerminalFrozen（会话 id 寻址，先过选项弹层）', () => {
    const api = useTerminalShareActions()
    api.createFrozenShare('s7')
    expect(termDialogMock.createTerminalFrozen).toHaveBeenCalledWith('s7')
  })
})

describe('useTerminalShareActions 分享回放', () => {
  it('无录制：可行动提示（warning），不创建分享', async () => {
    recListMock.mockResolvedValue({ data: [] } as unknown as Awaited<ReturnType<typeof recordingApi.list>>)
    const api = useTerminalShareActions()
    await api.shareReplay('s1')
    expect(recListMock).toHaveBeenCalledWith({ sessionId: 's1', limit: 1 })
    expect(messageMock.warning).toHaveBeenCalledTimes(1)
    expect(dialogMock.createRecordingShare).not.toHaveBeenCalled()
  })

  it('有录制：取最近一条进回放分享链，不提示', async () => {
    recListMock.mockResolvedValue({ data: [{ id: 'rec-9' }] } as unknown as Awaited<ReturnType<typeof recordingApi.list>>)
    const api = useTerminalShareActions()
    await api.shareReplay('s1')
    expect(messageMock.warning).not.toHaveBeenCalled()
    expect(dialogMock.createRecordingShare).toHaveBeenCalledWith('rec-9')
  })
})

describe('useTerminalShareActions 导出输出', () => {
  it('出域闸放行：合成下载名落地 + 成功提示 + 敏感建议扫描', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' })
    gateMock.mockResolvedValue(blob)
    const createUrl = vi.fn(() => 'blob:mock')
    const revokeUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeUrl, configurable: true })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const api = useTerminalShareActions()
      await api.exportOutput({ id: 's1', name: 'deploy' })
      // 闸门回调把 confirm 参数透传给导出 API（第一跳不带 override，确认后带
      // override=1&confirm=1 重取——与底部 tab 既有契约逐字一致）
      const load = gateMock.mock.calls[0]![0]
      exportMock.mockResolvedValue(blob as unknown as Awaited<ReturnType<typeof terminalApi.exportOutput>>)
      await load(false)
      expect(exportMock).toHaveBeenLastCalledWith('s1', undefined)
      await load(true)
      expect(exportMock).toHaveBeenLastCalledWith('s1', { params: { override: '1', confirm: '1' } })
      // 会话名传给闸门做警示文案
      expect(gateMock.mock.calls[0]![1]).toBe('deploy')
      expect(createUrl).toHaveBeenCalledWith(blob)
      expect(clickSpy).toHaveBeenCalledTimes(1)
      expect(messageMock.success).toHaveBeenCalledTimes(1)
      // 落地后异步敏感建议：会话 id/名 + 取文闭包
      expect(hintMock.suggestSensitiveMarking).toHaveBeenCalledTimes(1)
      expect(hintMock.suggestSensitiveMarking.mock.calls[0]!.slice(0, 2)).toEqual(['s1', 'deploy'])
      // 10s 后释放 object URL
      await vi.advanceTimersByTimeAsync(10_000)
      expect(revokeUrl).toHaveBeenCalledWith('blob:mock')
    } finally {
      clickSpy.mockRestore()
    }
  })

  it('出域闸拦下（用户取消 / JSON 警示未确认）：不落地不提示不建议', async () => {
    gateMock.mockResolvedValue(null)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const api = useTerminalShareActions()
      await api.exportOutput({ id: 's1', name: 'deploy' })
      expect(clickSpy).not.toHaveBeenCalled()
      expect(messageMock.success).not.toHaveBeenCalled()
      expect(hintMock.suggestSensitiveMarking).not.toHaveBeenCalled()
    } finally {
      clickSpy.mockRestore()
    }
  })
})

describe('useTerminalShareActions 直播徽标投影 liveTitles', () => {
  it('剩余时长按分钟上取整成 HH:MM，观看数取 hits；到界记录摘除；无 TTL 以 --:-- 兜底', async () => {
    vi.useFakeTimers()
    const base = new Date('2026-11-07T10:00:00Z').getTime()
    vi.setSystemTime(base)
    const live = useTerminalLiveShares()
    // start 把倒计时基准 now 钉到 base（投影以它为锚）
    listMock.mockResolvedValue({ data: [] } as unknown as Awaited<ReturnType<typeof shareApi.list>>)
    live.start()
    await seedLive([
      liveShare('s-90', { expiresAt: new Date(base + 90 * 60_000).toISOString(), hits: 3 }),
      liveShare('s-expired', { expiresAt: new Date(base - 1).toISOString() }),
      liveShare('s-nottl'),
    ])
    const api = useTerminalShareActions()
    const titles = api.liveTitles.value
    expect(titles['s-90']).toBe('直播中·剩 01:30·3 次观看')
    expect(titles['s-expired']).toBeUndefined()
    expect(titles['s-nottl']).toBe('直播中·剩 --:--·0 次观看')
    live.stop()
  })

  it('空锚点表 → 空投影（无徽标）', () => {
    const api = useTerminalShareActions()
    expect(api.liveTitles.value).toEqual({})
  })
})
