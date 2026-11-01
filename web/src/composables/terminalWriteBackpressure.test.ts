import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_PENDING_WRITE_LIMIT,
  TERMINAL_STORM_SETTLE_MS,
  createWriteStormTracker,
} from './terminalWriteBackpressure'

// 写链路背压风暴追踪器（P-20261004-47）：丢弃计数 / 落定判定 / 去抖与重入风暴。
// 定时器全部走 vi.useFakeTimers——落定语义（排空后静默窗）确定性验证
describe('createWriteStormTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('阈值常量：闸门 256 与历史实现同值，落定去抖亚秒级', () => {
    expect(TERMINAL_PENDING_WRITE_LIMIT).toBe(256)
    expect(TERMINAL_STORM_SETTLE_MS).toBeLessThan(1000)
  })

  it('无丢弃时链路排空不触发落定回调（正常输出零扰动）', () => {
    const settles: number[] = []
    const tracker = createWriteStormTracker({ onSettle: (n) => settles.push(n) })
    tracker.onChainIdle(true)
    tracker.onChainIdle(false)
    vi.advanceTimersByTime(TERMINAL_STORM_SETTLE_MS * 5)
    expect(settles).toEqual([])
    expect(tracker.episodeDropped).toBe(0)
  })

  it('丢弃计数后链路排空，静默窗满触发一次落定，episode 归零', () => {
    const settles: number[] = []
    const tracker = createWriteStormTracker({ onSettle: (n) => settles.push(n) })
    tracker.onFrameDropped()
    tracker.onFrameDropped()
    tracker.onFrameDropped()
    expect(tracker.episodeDropped).toBe(3)
    tracker.onChainIdle(false) // 链仍在途：不排程
    vi.advanceTimersByTime(TERMINAL_STORM_SETTLE_MS * 5)
    expect(settles).toEqual([])
    tracker.onChainIdle(true) // 排空：去抖排程
    vi.advanceTimersByTime(TERMINAL_STORM_SETTLE_MS - 1)
    expect(settles).toEqual([])
    vi.advanceTimersByTime(1)
    expect(settles).toEqual([3])
    expect(tracker.episodeDropped).toBe(0)
  })

  it('静默窗内再入风暴（新丢弃）取消已排程的落定，重新等待落定', () => {
    const settles: number[] = []
    const tracker = createWriteStormTracker({ onSettle: (n) => settles.push(n) })
    tracker.onFrameDropped()
    tracker.onChainIdle(true)
    vi.advanceTimersByTime(TERMINAL_STORM_SETTLE_MS - 1)
    // 窗口最后一刻又丢一帧：脉冲型风暴，落定取消
    tracker.onFrameDropped()
    vi.advanceTimersByTime(TERMINAL_STORM_SETTLE_MS * 2)
    expect(settles).toEqual([])
    expect(tracker.episodeDropped).toBe(2)
    // 真正落定：排空 + 完整静默窗
    tracker.onChainIdle(true)
    vi.advanceTimersByTime(TERMINAL_STORM_SETTLE_MS)
    expect(settles).toEqual([2])
  })

  it('多个 episode：落定后新丢弃开新 episode，计数互不混淆', () => {
    const settles: number[] = []
    const tracker = createWriteStormTracker({ onSettle: (n) => settles.push(n) })
    tracker.onFrameDropped()
    tracker.onChainIdle(true)
    vi.advanceTimersByTime(TERMINAL_STORM_SETTLE_MS)
    expect(settles).toEqual([1])
    tracker.onFrameDropped()
    tracker.onFrameDropped()
    tracker.onChainIdle(true)
    vi.advanceTimersByTime(TERMINAL_STORM_SETTLE_MS)
    expect(settles).toEqual([1, 2])
  })

  it('排空前去抖期内链路再次忙碌（onChainIdle(false)）不重复排程', () => {
    const settles: number[] = []
    const tracker = createWriteStormTracker({ onSettle: (n) => settles.push(n) })
    tracker.onFrameDropped()
    tracker.onChainIdle(true)
    tracker.onChainIdle(false) // 链又忙：已排程的落定保留
    tracker.onChainIdle(true)
    vi.advanceTimersByTime(TERMINAL_STORM_SETTLE_MS)
    expect(settles).toEqual([1])
  })

  it('dispose 停定时器：排程中的落定不再触达已卸载实例', () => {
    const settles: number[] = []
    const tracker = createWriteStormTracker({ onSettle: (n) => settles.push(n) })
    tracker.onFrameDropped()
    tracker.onChainIdle(true)
    tracker.dispose()
    vi.advanceTimersByTime(TERMINAL_STORM_SETTLE_MS * 5)
    expect(settles).toEqual([])
    expect(tracker.episodeDropped).toBe(0)
  })

  it('settleMs 可注入短值（单测/未来调用方自定义去抖）', () => {
    const settles: number[] = []
    const tracker = createWriteStormTracker({ onSettle: (n) => settles.push(n), settleMs: 50 })
    tracker.onFrameDropped()
    tracker.onChainIdle(true)
    vi.advanceTimersByTime(50)
    expect(settles).toEqual([1])
  })
})
