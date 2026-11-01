import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  useMonitorCarousel,
  MONITOR_CAROUSEL_INTERVALS,
  MONITOR_CAROUSEL_IDLE_RESUME_MS,
} from '@/composables/useMonitorCarousel'

// 值班大屏轮播模式（P-20261005-166）纯函数面单测：换幕游标/回绕/卸载回落、
// 交互暂停与 idle 恢复（连续操作顺延）、页签隐藏暂停与回前台相位重置、
// 换档重上表、关停清态。假时钟驱动定时器，区块元素为内存伪造（scrollIntoView
// 打桩断言调用形态），免组件实例——dispose 由宿主显式调用的设计即为此服务

function block(id: string): HTMLElement {
  const el = document.createElement('section')
  el.setAttribute('data-testid', `monitor-cat-${id}`)
  el.scrollIntoView = vi.fn()
  return el
}

function harness(ids: string[]) {
  const blocks = ids.map(block)
  const carousel = useMonitorCarousel(() => blocks)
  return { carousel, blocks }
}

/** jsdom 的 document.hidden 是原型 getter：实例自有属性覆盖之，删键即还原 */
function stubHidden(v: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => v })
}
function unstubHidden(): void {
  delete (document as { hidden?: unknown }).hidden
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  unstubHidden()
  vi.useRealTimers()
})

describe('useMonitorCarousel（值班大屏轮播 P-20261005-166）', () => {
  it('档位契约：三档 10/20/60s', () => {
    expect(MONITOR_CAROUSEL_INTERVALS).toEqual([10, 20, 60])
  })

  it('开启登记首幕：立即高亮不滚动（不打断此刻观看位置）', () => {
    const { carousel, blocks } = harness(['instance', 'fleet', 'tasks'])
    carousel.setOn(true)
    expect(carousel.on.value).toBe(true)
    expect(carousel.focusId.value).toBe('instance')
    expect(blocks[0]!.scrollIntoView).not.toHaveBeenCalled()
    carousel.dispose()
  })

  it('间隔到点滚动下一区块，末块回绕首位', async () => {
    const { carousel, blocks } = harness(['instance', 'fleet', 'tasks'])
    carousel.setOn(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(carousel.focusId.value).toBe('fleet')
    expect(blocks[1]!.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(carousel.focusId.value).toBe('tasks')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(carousel.focusId.value).toBe('instance') // 回绕
    carousel.dispose()
  })

  it('交互暂停不换幕，idle 窗满自动恢复且相位重置', async () => {
    const { carousel, blocks } = harness(['a', 'b', 'c'])
    carousel.setOn(true)
    carousel.onUserInteraction()
    expect(carousel.pausedByInteraction.value).toBe(true)
    await vi.advanceTimersByTimeAsync(3 * 20_000)
    expect(carousel.focusId.value).toBe('a') // 暂停期内整倍间隔不换幕
    expect(blocks[1]!.scrollIntoView).not.toHaveBeenCalled()
    expect(carousel.pausedByInteraction.value).toBe(false) // 60s idle 已过 → 已恢复
    await vi.advanceTimersByTimeAsync(20_000)
    expect(carousel.focusId.value).toBe('b') // 恢复后重等一个整间隔才换幕
    carousel.dispose()
  })

  it('连续操作顺延 idle 窗（最后一下手离开才起算）', async () => {
    const { carousel } = harness(['a', 'b'])
    carousel.setOn(true)
    carousel.onUserInteraction()
    await vi.advanceTimersByTimeAsync(30_000)
    carousel.onUserInteraction() // 第二下操作重置 idle 窗
    await vi.advanceTimersByTimeAsync(MONITOR_CAROUSEL_IDLE_RESUME_MS - 1)
    expect(carousel.pausedByInteraction.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(carousel.pausedByInteraction.value).toBe(false)
    carousel.dispose()
  })

  it('页签隐藏暂停，回前台恢复（相位重置再换幕）', async () => {
    const { carousel } = harness(['a', 'b', 'c'])
    carousel.setOn(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(carousel.focusId.value).toBe('b')
    stubHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(carousel.focusId.value).toBe('b') // 隐藏期不换幕（省资源）
    stubHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(carousel.focusId.value).toBe('c') // 回前台重等一个整间隔
    carousel.dispose()
  })

  it('开启瞬间已在后台页签：直接进隐藏暂停不换幕', async () => {
    stubHidden(true)
    const { carousel } = harness(['a', 'b'])
    carousel.setOn(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(carousel.focusId.value).toBe('a')
    carousel.dispose()
  })

  it('换档即重上表：新档位从当前时刻起算', async () => {
    const { carousel } = harness(['a', 'b'])
    carousel.setOn(true)
    carousel.intervalSec.value = 10
    await vi.advanceTimersByTimeAsync(10_000)
    expect(carousel.focusId.value).toBe('b') // 10s 档即刻生效
    carousel.dispose()
  })

  it('幕块被卸载：游标失效回落首位（宁可靠左不跳步）', async () => {
    const { carousel, blocks } = harness(['a', 'b', 'c'])
    carousel.setOn(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(carousel.focusId.value).toBe('b')
    blocks.splice(1, 1) // b 卸载（临时置顶退场/类目隐藏同形态）
    await vi.advanceTimersByTimeAsync(20_000)
    expect(carousel.focusId.value).toBe('a')
    carousel.dispose()
  })

  it('关停清态（高亮/暂停/idle 定时器全收），重开从首幕重来', async () => {
    const { carousel, blocks } = harness(['a', 'b'])
    carousel.setOn(true)
    await vi.advanceTimersByTimeAsync(20_000)
    const scrollsAtStop = vi.mocked(blocks[1]!.scrollIntoView).mock.calls.length
    carousel.setOn(false)
    expect(carousel.focusId.value).toBe('')
    expect(carousel.pausedByInteraction.value).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vi.mocked(blocks[0]!.scrollIntoView).mock.calls.length).toBe(0) // 关停后不换幕
    expect(vi.mocked(blocks[1]!.scrollIntoView).mock.calls.length).toBe(scrollsAtStop)
    carousel.setOn(true)
    expect(carousel.focusId.value).toBe('a') // 从首幕重新开始
    carousel.dispose()
  })

  it('空区块集：开启不炸、无高亮、到点静默', async () => {
    const carousel = useMonitorCarousel(() => [])
    expect(() => carousel.setOn(true)).not.toThrow()
    expect(carousel.focusId.value).toBe('')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(carousel.focusId.value).toBe('')
    carousel.dispose()
  })
})
