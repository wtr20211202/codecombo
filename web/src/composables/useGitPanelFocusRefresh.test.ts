import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useGitPanelFocusRefresh, GIT_PANEL_FOCUS_REFRESH_MIN_INTERVAL_MS } from './useGitPanelFocusRefresh'

/** maybeRefresh 经 Promise.resolve().then(refresh) 异步起跑：断言前先冲掉微任务 */
async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useGitPanelFocusRefresh', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('首次触发立即拉取（初始无拉取记录不设节流墙）', async () => {
    const refresh = vi.fn()
    const { maybeRefresh } = useGitPanelFocusRefresh(refresh)
    maybeRefresh()
    await flushMicrotasks()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('间隔内的触发被节流跳过（e2e 验收线：>10s 二次 focus 不重复拉）', async () => {
    const refresh = vi.fn()
    const { maybeRefresh } = useGitPanelFocusRefresh(refresh)
    maybeRefresh()
    await flushMicrotasks()
    vi.advanceTimersByTime(GIT_PANEL_FOCUS_REFRESH_MIN_INTERVAL_MS - 1)
    maybeRefresh()
    await flushMicrotasks()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('超过间隔后再次触发重新拉取', async () => {
    const refresh = vi.fn()
    const { maybeRefresh } = useGitPanelFocusRefresh(refresh)
    maybeRefresh()
    await flushMicrotasks()
    vi.advanceTimersByTime(GIT_PANEL_FOCUS_REFRESH_MIN_INTERVAL_MS + 1)
    maybeRefresh()
    await flushMicrotasks()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('markRefreshed 对齐节流窗口：宿主手动链拉完后紧随的触发不冗余重取', async () => {
    const refresh = vi.fn()
    const { maybeRefresh, markRefreshed } = useGitPanelFocusRefresh(refresh)
    markRefreshed()
    maybeRefresh()
    await flushMicrotasks()
    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(GIT_PANEL_FOCUS_REFRESH_MIN_INTERVAL_MS + 1)
    maybeRefresh()
    await flushMicrotasks()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('refresh 异常不外溢，节流记账不回滚（失败也不密集重试，下一窗口自愈）', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('offline'))
    const { maybeRefresh } = useGitPanelFocusRefresh(refresh)
    maybeRefresh()
    await flushMicrotasks()
    await vi.runAllTimersAsync()
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(GIT_PANEL_FOCUS_REFRESH_MIN_INTERVAL_MS - 1)
    maybeRefresh()
    await flushMicrotasks()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
