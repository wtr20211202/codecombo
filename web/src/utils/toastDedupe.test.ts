import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldShowToast } from './toastDedupe'

describe('shouldShowToast', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('窗口期内同 key 只放行一次', () => {
    vi.useFakeTimers()
    // 非 0 纪元锚点：now=0 时 now-last=0 恰落在窗口内属实现既有行为，不作锚点
    vi.setSystemTime(1_000_000)
    expect(shouldShowToast('k', 60_000)).toBe(true)
    expect(shouldShowToast('k', 60_000)).toBe(false)
  })

  it('窗口滑过后同 key 再次放行', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    expect(shouldShowToast('sliding', 5_000)).toBe(true)
    vi.setSystemTime(1_005_000)
    expect(shouldShowToast('sliding', 5_000)).toBe(true)
  })

  it('不同 key 互不影响（同文案不同来源各自放行一次）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    expect(shouldShowToast('settings', 5_000)).toBe(true)
    expect(shouldShowToast('home', 5_000)).toBe(true)
    expect(shouldShowToast('settings', 5_000)).toBe(false)
    expect(shouldShowToast('home', 5_000)).toBe(false)
  })
})
