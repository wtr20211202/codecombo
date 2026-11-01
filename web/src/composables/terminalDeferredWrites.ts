// 隐藏 pane 写入延迟队列（P-20261004-46）：终端 tab 全部常驻挂载（v-show 保活），
// 不可见 pane 的输出帧不再直写 xterm（term.write 的流解析 + cell 更新是后台
// 会话的 CPU 大头），入本队列暂存、激活时一次性 drain 重放。纯数据结构，测试
// 直接覆盖（terminalDeferredWrites.test.ts）。
//
// 有界语义：字节/段数双上限，超限丢最旧保最新——重放后屏幕落在输出的末屏
// （跳写末屏），被丢的中段仅是 scrollback 缺口（与写链路背压丢帧同哲学：
// 只影响显示，不写 PTY，shell 状态无损）。保留最新是硬约束：队列只留得下
// 一帧时也丢旧留新，绝不丢刚入队的当前屏。

import type { OscWriteSegment } from './terminalOscFrames'

// 字节上限：默认 scrollback 20000 行 ≈ 2MB 级，4MB 覆盖整屏缓冲重放（页面刷新
// 恢复多 tab 时隐藏 pane 的 attach 重放也走此队列）留有余量；N 个隐藏 pane
// 并存的最坏内存 = N × 4MB，远小于 xterm 解析同量字节后的 cell 内存
export const MAX_DEFERRED_WRITE_BYTES = 4 * 1024 * 1024
// 段数上限：防病态小帧（心跳/逐字符输出）把队列撑成几千个对象的簿记开销
export const MAX_DEFERRED_WRITE_SEGS = 1024

export interface DeferredWriteQueue {
  // 入队一帧；超限即时丢最旧（保持 O(1) 摊销，不在 drain 时才裁）
  enqueue(seg: OscWriteSegment): void
  // 取走全部暂存帧（FIFO 原序），队列清空
  drain(): OscWriteSegment[]
  // 丢弃全部暂存帧（重连场景：服务端 scrollback 重放会重发同段字节，不清即双份）
  clear(): void
  readonly length: number
  readonly bytes: number
}

export function createDeferredWriteQueue(): DeferredWriteQueue {
  let segs: OscWriteSegment[] = []
  let totalBytes = 0
  function trimOverflow(): void {
    // 至少保留刚入队的最新一帧（单帧超限时宁超边界也不丢当前屏）
    while (
      segs.length > 1 &&
      (totalBytes > MAX_DEFERRED_WRITE_BYTES || segs.length > MAX_DEFERRED_WRITE_SEGS)
    ) {
      const dropped = segs.shift()
      totalBytes -= dropped?.write.length ?? 0
    }
  }
  return {
    enqueue(seg: OscWriteSegment): void {
      segs.push(seg)
      totalBytes += seg.write.length
      trimOverflow()
    },
    drain(): OscWriteSegment[] {
      const out = segs
      segs = []
      totalBytes = 0
      return out
    },
    clear(): void {
      segs = []
      totalBytes = 0
    },
    get length(): number {
      return segs.length
    },
    get bytes(): number {
      return totalBytes
    },
  }
}
