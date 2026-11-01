// monacoWorkerPrefetch 空闲预取单测（P-20261002-103）
//
// 覆盖三层语义：空闲调度（jsdom 无 requestIdleCallback 走 setTimeout 3s 降级；
// rIC 可用时优先且带 timeout 兜底）；预取载荷（ts/css 两个 chunk URL + 低优先级）；
// 纯增益边界（幂等不重复调度、fetch 失败静默不上抛）。
// 模块级 started 单次调度，各用例经 vi.resetModules() + 动态导入重置。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ?worker&url 在 vitest（vite 管线）下仅导出 URL 字符串，不含 monaco 源码；
// 完整路径形态随解析方式浮动，断言以 worker 文件名锚定
const importPrefetch = () => import('@/utils/monacoWorkerPrefetch')

describe('monacoWorkerPrefetch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response()))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.resetModules()
  })

  it('rIC 不可用时降级 setTimeout 3s：预取 ts/css 两个 worker chunk 且低优先', async () => {
    const { prefetchMonacoLanguageWorkers } = await importPrefetch()
    prefetchMonacoLanguageWorkers()

    expect(window.fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)

    expect(window.fetch).toHaveBeenCalledTimes(2)
    const urls = vi.mocked(window.fetch).mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('ts.worker'))).toBe(true)
    expect(urls.some((u) => u.includes('css.worker'))).toBe(true)
    for (const call of vi.mocked(window.fetch).mock.calls) {
      expect((call[1] as RequestInit).priority).toBe('low')
    }
  })

  it('重复调用幂等：实例切换 remount 多次触发也只调度一轮预取', async () => {
    const { prefetchMonacoLanguageWorkers } = await importPrefetch()
    prefetchMonacoLanguageWorkers()
    prefetchMonacoLanguageWorkers()
    await vi.advanceTimersByTimeAsync(3000)

    expect(window.fetch).toHaveBeenCalledTimes(2)
  })

  it('rIC 可用时优先空闲调度且带 timeout 兜底，回调前不发起请求', async () => {
    let idleCb: IdleRequestCallback = () => {}
    const ric = vi.fn((cb: IdleRequestCallback, opts?: IdleRequestOptions) => {
      idleCb = cb
      expect(opts?.timeout).toBe(3000)
      return 1
    })
    vi.stubGlobal('requestIdleCallback', ric)
    const { prefetchMonacoLanguageWorkers } = await importPrefetch()
    prefetchMonacoLanguageWorkers()

    expect(ric).toHaveBeenCalledTimes(1)
    expect(window.fetch).not.toHaveBeenCalled()

    idleCb(Date.now() as unknown as IdleDeadline, {} as IdleRequestOptions)
    expect(window.fetch).toHaveBeenCalledTimes(2)
  })

  it('预取失败静默：fetch reject 不上抛不产生未处理拒绝', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const { prefetchMonacoLanguageWorkers } = await importPrefetch()
    prefetchMonacoLanguageWorkers()

    // 断言本体是「无未处理拒绝」：若 .catch 缺失，vitest 会以 unhandled rejection 判失败
    await vi.advanceTimersByTimeAsync(3000)
    expect(window.fetch).toHaveBeenCalledTimes(2)
  })
})
