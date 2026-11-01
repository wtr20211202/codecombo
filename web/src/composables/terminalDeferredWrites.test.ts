import { describe, expect, it } from 'vitest'
import {
  createDeferredWriteQueue,
  MAX_DEFERRED_WRITE_BYTES,
  MAX_DEFERRED_WRITE_SEGS,
} from './terminalDeferredWrites'
import type { OscWriteSegment } from './terminalOscFrames'

// 构造一个最小写入段（纯输出无事件 / 带事件两种形态）
function seg(bytes: number, events: OscWriteSegment['events'] = []): OscWriteSegment {
  return { write: new Uint8Array(bytes).fill(0x61), events }
}

describe('createDeferredWriteQueue', () => {
  it('FIFO drain：入队序 = 重放序，drain 后队列清空', () => {
    const q = createDeferredWriteQueue()
    q.enqueue(seg(3))
    q.enqueue(seg(5))
    q.enqueue(seg(7))
    expect(q.length).toBe(3)
    expect(q.bytes).toBe(15)
    const out = q.drain()
    expect(out.map((s) => s.write.length)).toEqual([3, 5, 7])
    expect(q.length).toBe(0)
    expect(q.bytes).toBe(0)
    // drain 后可继续入队（激活 flush 与后续到达共存）
    q.enqueue(seg(1))
    expect(q.drain()).toHaveLength(1)
  })

  it('字节超限丢最旧保最新：只裁到回到界内，重放后屏幕落在输出末屏', () => {
    const q = createDeferredWriteQueue()
    const half = Math.floor(MAX_DEFERRED_WRITE_BYTES / 2)
    const third = Math.floor(MAX_DEFERRED_WRITE_BYTES / 3)
    // 1MB+1MB+3MB=5MB 超限 → 丢最旧 1MB 回到界内，中/新帧保留（FIFO 对齐）
    q.enqueue(seg(third))
    q.enqueue(seg(third))
    q.enqueue(seg(MAX_DEFERRED_WRITE_BYTES - third))
    const out = q.drain()
    expect(out.map((s) => s.write.length)).toEqual([third, MAX_DEFERRED_WRITE_BYTES - third])
    // 连续大帧（各 2MB+1，两帧即超限）：每次入队都挤掉前一帧，只留最新
    const overHalf = half + 1
    q.enqueue(seg(overHalf))
    q.enqueue(seg(overHalf))
    q.enqueue(seg(overHalf))
    expect(q.length).toBe(1)
    expect(q.drain()[0]!.write.length).toBe(overHalf)
  })

  it('单帧超字节上限仍入队（宁超边界不丢当前屏），其后入队帧挤掉它', () => {
    const q = createDeferredWriteQueue()
    const huge = MAX_DEFERRED_WRITE_BYTES + 1
    q.enqueue(seg(huge))
    expect(q.length).toBe(1)
    expect(q.bytes).toBe(huge)
    // 新帧入队后旧的超限帧成为「最旧」被丢
    q.enqueue(seg(1))
    expect(q.drain()[0]!.write.length).toBe(1)
  })

  it('段数超限丢最旧：病态小帧流有界', () => {
    const q = createDeferredWriteQueue()
    for (let i = 0; i < MAX_DEFERRED_WRITE_SEGS + 50; i++) {
      q.enqueue(seg(1))
    }
    expect(q.length).toBe(MAX_DEFERRED_WRITE_SEGS)
  })

  it('clear 丢弃全部（重连重放前防双份）', () => {
    const q = createDeferredWriteQueue()
    q.enqueue(seg(10))
    q.enqueue(seg(20))
    q.clear()
    expect(q.length).toBe(0)
    expect(q.bytes).toBe(0)
    expect(q.drain()).toEqual([])
  })

  it('段对象按引用保留：重放时 seg.events 供缓冲依赖记账原样消费', () => {
    const q = createDeferredWriteQueue()
    const withEvents = seg(4, [{ type: 'D', exitCode: 1, durationMs: 5 }])
    q.enqueue(withEvents)
    expect(q.drain()[0]).toBe(withEvents)
  })
})
