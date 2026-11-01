import { describe, it, expect } from 'vitest'
import {
  createCrashGuard,
  truncateText,
  formatCrashDetail,
  CRASH_THRESHOLD,
  CRASH_WINDOW_MS,
  type CapturedError,
} from '@/utils/crashGuard'

/** 虚拟时钟：单测确定性推进，不 sleep */
function makeClock() {
  let t = 0
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

function err(message = 'boom', info = 'render'): CapturedError {
  return { message, info, stack: `Error: ${message}\n    at fake` }
}

describe('crashGuard 阈值判定', () => {
  it('窗口内错误数未达阈值不熔断', () => {
    const clock = makeClock()
    const guard = createCrashGuard({ now: clock.now })
    expect(guard.record(err())).toBe(false)
    clock.advance(1000)
    expect(guard.record(err())).toBe(false)
    expect(guard.lastError?.message).toBe('boom')
  })

  it(`窗口内第 ${CRASH_THRESHOLD} 次错误熔断`, () => {
    const clock = makeClock()
    const guard = createCrashGuard({ now: clock.now })
    expect(guard.record(err('e1'))).toBe(false)
    clock.advance(1000)
    expect(guard.record(err('e2'))).toBe(false)
    clock.advance(1000)
    expect(guard.record(err('e3'))).toBe(true)
    expect(guard.lastError?.message).toBe('e3')
  })

  it('与上一次错误间隔超出窗口 → 不连续，重开窗口', () => {
    const clock = makeClock()
    const guard = createCrashGuard({ now: clock.now })
    guard.record(err())
    clock.advance(1000)
    guard.record(err())
    // 窗口（默认 10s）外再错两次：窗口重开后不达阈值
    clock.advance(CRASH_WINDOW_MS + 1)
    expect(guard.record(err())).toBe(false)
    clock.advance(1000)
    expect(guard.record(err())).toBe(false)
  })

  it('滑窗裁剪：窗口起点外的旧样本不累计', () => {
    const clock = makeClock()
    const guard = createCrashGuard({ now: clock.now })
    guard.record(err())
    clock.advance(6000)
    guard.record(err())
    clock.advance(6000) // 第 1 个样本已滑出窗口，第 2 个仍在
    // 若旧样本未裁剪，这里会误判为第 3 次；裁剪后不熔断
    expect(guard.record(err())).toBe(false)
    clock.advance(1000)
    expect(guard.record(err())).toBe(true)
  })

  it('reset 清空窗口与最近错误', () => {
    const clock = makeClock()
    const guard = createCrashGuard({ now: clock.now })
    guard.record(err())
    guard.record(err())
    guard.reset()
    expect(guard.lastError).toBeNull()
    expect(guard.record(err())).toBe(false)
  })

  it('非默认阈值/窗口可注入', () => {
    let t = 0
    const guard = createCrashGuard({ now: () => t, threshold: 2, windowMs: 5000 })
    expect(guard.record(err())).toBe(false)
    t += 4000
    expect(guard.record(err())).toBe(true)
    t += 5001
    expect(guard.record(err())).toBe(false)
  })
})

describe('truncateText / formatCrashDetail', () => {
  it('truncateText 超长截断并标注省略字符数', () => {
    expect(truncateText('short', 10)).toBe('short')
    const out = truncateText('x'.repeat(201), 200)
    expect(out.startsWith('x'.repeat(200))).toBe(true)
    expect(out).toContain('(truncated 1 chars)')
  })

  it('formatCrashDetail 组装消息/来源/堆栈/环境并截断堆栈', () => {
    const detail = formatCrashDetail(
      { message: 'boom', info: 'render', stack: 'Error: boom\n' + 'at x\n'.repeat(1000) },
      { href: 'http://127.0.0.1:9999/?__crash=1', userAgent: 'test-agent' },
    )
    expect(detail).toContain('message: boom')
    expect(detail).toContain('source: render')
    expect(detail).toContain('href: http://127.0.0.1:9999/?__crash=1')
    expect(detail).toContain('userAgent: test-agent')
    expect(detail.length).toBeLessThan(6000) // 堆栈被截到 4000 内
  })
})
