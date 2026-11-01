import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock 边界：meta 能力探测与 watchFallbackApi 替身化（不发真请求、不需要
// pinia）；窗口事件分发与显隐状态机是真实现（不 mock 被测逻辑本身）──
const { getMock, metaMock } = vi.hoisted(() => ({
  getMock: vi.fn<() => Promise<unknown>>(),
  metaMock: {
    ensureCaps: vi.fn(async () => {}),
    hasCap: vi.fn(() => true),
  },
}))
vi.mock('../api/domains/system', () => ({
  watchFallbackApi: { get: () => getMock() },
}))
vi.mock('../stores/meta', () => ({
  CAP_WATCH_FALLBACK: 'watch-fallback',
  useMetaStore: () => metaMock,
}))

import { useWatchFallback } from './useWatchFallback'
import { OPS_WATCH_FALLBACK } from '../utils/opsEvents'

/** 派发一条服务端迁移广播（notification store 二次分发的同形窗口事件） */
function emitFallback(d: { enabled?: boolean; source?: 'auto' | 'manual' | ''; since?: string }): void {
  window.dispatchEvent(new CustomEvent(OPS_WATCH_FALLBACK, { detail: d }))
}

beforeEach(() => {
  getMock.mockReset()
  getMock.mockResolvedValue({ data: { enabled: false } })
  metaMock.hasCap.mockReturnValue(true)
})

describe('useWatchFallback 迁移广播驱动显隐（P-20261006-34 主驱动）', () => {
  it('手动开启事件置位：enabled/source/since 全量入状态', () => {
    const { status } = useWatchFallback()
    emitFallback({ enabled: true, source: 'manual', since: '2026-10-24T08:00:00Z' })
    expect(status.value).toEqual({
      enabled: true,
      source: 'manual',
      since: '2026-10-24T08:00:00Z',
    })
  })

  it('关闭事件归零：enabled=false 且 source/since 缺省容错为空', () => {
    const { status } = useWatchFallback()
    emitFallback({ enabled: false })
    expect(status.value).toEqual({ enabled: false, source: '', since: undefined })
  })

  it('载荷缺 enabled 字段防呆为 false（不因旧对端半形载荷误显微标）', () => {
    const { status } = useWatchFallback()
    emitFallback({ source: 'auto' })
    expect(status.value?.enabled).toBe(false)
    expect(status.value?.source).toBe('auto')
  })
})

describe('useWatchFallback 快照拉取（加载兜底面）', () => {
  it('能力在位：拉 GET 快照入状态（挂载时「加载前已降级」可 immediate 可见）', async () => {
    getMock.mockResolvedValue({ data: { enabled: true, source: 'auto', since: '2026-10-24T07:00:00Z' } })
    const { status, refresh } = useWatchFallback()
    await refresh()
    expect(metaMock.ensureCaps).toHaveBeenCalled()
    expect(getMock).toHaveBeenCalledTimes(1)
    expect(status.value?.enabled).toBe(true)
    expect(status.value?.source).toBe('auto')
  })

  it('能力未声明（多实例代理旧对端）：不发注定 404 的请求', async () => {
    metaMock.hasCap.mockReturnValue(false)
    const { refresh } = useWatchFallback()
    await refresh()
    expect(getMock).not.toHaveBeenCalled()
  })

  it('快照失败静默保旧：事件已置位的降级态不被失败清掉', async () => {
    const { status, refresh } = useWatchFallback()
    emitFallback({ enabled: true, source: 'manual' })
    getMock.mockRejectedValue(new Error('network down'))
    await refresh()
    expect(status.value?.enabled).toBe(true)
  })
})

describe('useWatchFallback 聚焦重拉（断线窗口期错过广播的对账）', () => {
  it('快照已拉取过：window focus 触发一次重拉并采纳新快照', async () => {
    getMock.mockResolvedValue({ data: { enabled: true, source: 'auto' } })
    const { status, refresh } = useWatchFallback()
    await refresh()
    const callsAfterPrimed = getMock.mock.calls.length

    getMock.mockResolvedValue({ data: { enabled: false } })
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(getMock.mock.calls.length).toBe(callsAfterPrimed + 1))
    await vi.waitFor(() => expect(status.value?.enabled).toBe(false))
  })
  // 「未 primed 时聚焦零请求」无独立用例：模块单例的 window 监听在
  // resetModules 后仍驻留 jsdom，无法在进程内隔离出未 primed 态——门控是
  // `if (primed)` 单行守卫，由读代码评审覆盖
})
