import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useOverlayDwell } from './useOverlayDwell'

// 全屏遮罩显隐滞回去抖（P-20261011-1 ②）：进入即时、离场缓冲、重进静默窗。
// 语义契约见 useOverlayDwell.ts 头注；这里用假时钟逐窗口验证三段时序。
// watch 默认 pre-flush 异步——每次源变更后 await nextTick() 刷新回调再断言。

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useOverlayDwell 显隐滞回去抖（P-20261011-1）', () => {
  it('源为 true 即时显示（进入不延迟）', () => {
    const source = ref(true)
    const shown = useOverlayDwell(source)
    expect(shown.value).toBe(true)
  })

  it('初值 false 跟随源，变 true 即时显示', async () => {
    const source = ref(false)
    const shown = useOverlayDwell(source)
    expect(shown.value).toBe(false)
    source.value = true
    await nextTick()
    expect(shown.value).toBe(true)
  })

  it('离场缓冲：源变 false 后 hideDelayMs 内回 true 则完全不离开', async () => {
    const source = ref(true)
    const shown = useOverlayDwell(source, { hideDelayMs: 150, reenterDelayMs: 300 })
    source.value = false
    await nextTick()
    expect(shown.value).toBe(true)
    vi.advanceTimersByTime(100)
    source.value = true
    await nextTick()
    vi.advanceTimersByTime(1000)
    expect(shown.value).toBe(true)
  })

  it('离场缓冲到期才落地离场', async () => {
    const source = ref(true)
    const shown = useOverlayDwell(source, { hideDelayMs: 150 })
    source.value = false
    await nextTick()
    vi.advanceTimersByTime(149)
    expect(shown.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect(shown.value).toBe(false)
  })

  it('重进静默窗：离场落地后 300ms 内回 true 延迟重进（只延迟不丢弃）', async () => {
    const source = ref(true)
    const shown = useOverlayDwell(source, { hideDelayMs: 150, reenterDelayMs: 300 })
    source.value = false
    await nextTick()
    vi.advanceTimersByTime(150) // 离场落地，hiddenAt=now
    expect(shown.value).toBe(false)
    source.value = true // 距落地 0ms，静默窗满 300ms
    await nextTick()
    expect(shown.value).toBe(false)
    vi.advanceTimersByTime(299)
    expect(shown.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect(shown.value).toBe(true)
  })

  it('静默窗已过期（>reenterDelayMs）则回 true 即时重进', async () => {
    const source = ref(true)
    const shown = useOverlayDwell(source, { hideDelayMs: 150, reenterDelayMs: 300 })
    source.value = false
    await nextTick()
    vi.advanceTimersByTime(150)
    vi.advanceTimersByTime(300) // 静默窗耗尽
    source.value = true
    await nextTick()
    expect(shown.value).toBe(true)
  })

  it('静默重进排程中源又变 false：撤销重进（短脉冲进入不闪现）', async () => {
    const source = ref(true)
    const shown = useOverlayDwell(source, { hideDelayMs: 150, reenterDelayMs: 300 })
    source.value = false
    await nextTick()
    vi.advanceTimersByTime(150)
    source.value = true // 进入静默排程
    await nextTick()
    source.value = false // 排程中撤销
    await nextTick()
    vi.advanceTimersByTime(1000)
    expect(shown.value).toBe(false)
  })

  it('振荡链路：false 脉冲短于离场缓冲时遮罩全程不闪', async () => {
    const source = ref(true)
    const shown = useOverlayDwell(source, { hideDelayMs: 150, reenterDelayMs: 300 })
    for (let i = 0; i < 5; i++) {
      source.value = false
      await nextTick()
      vi.advanceTimersByTime(100)
      source.value = true
      await nextTick()
      vi.advanceTimersByTime(20)
    }
    vi.advanceTimersByTime(1000)
    expect(shown.value).toBe(true)
  })

  it('作用域销毁清定时器：离场缓冲中卸载后再推进时钟不触发离场', async () => {
    const source = ref(true)
    const scope = effectScope()
    const shown = scope.run(() => useOverlayDwell(source, { hideDelayMs: 150 }))!
    source.value = false
    await nextTick()
    expect(shown.value).toBe(true)
    scope.stop() // onScopeDispose 清掉未到期的离场定时器
    vi.advanceTimersByTime(1000)
    expect(shown.value).toBe(true)
  })
})
