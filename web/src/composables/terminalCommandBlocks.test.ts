import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { termInstances, type TermInstance } from './useTerminalInstances'
import {
  recordCommandBlockAnchor,
  scrollCommandBlock,
  commandBlockCount,
  resetCommandBlocks,
  MAX_BLOCKS_PER_SESSION,
} from './terminalCommandBlocks'

// ── mock 边界：本模块只依赖共享 termInstances Map 里的 xterm 实例。
// 测试注入假 term（buffer + registerMarker 捕获器 + 滚动调用记录），
// 锚点记账语义（回显行 offset / 越界跳过 / 上限裁剪）与导航判定
// （视口顶参照 / -1 定位 / 耗尽兜底）就地断言 ──

interface FakeMarker {
  line: number
  isDisposed: boolean
  onDispose: (cb: () => void) => void
  _onDispose?: () => void
  dispose: ReturnType<typeof vi.fn>
}

interface ScrollCalls {
  line: number[]
  top: number
  bottom: number
}

function installFakeSession(sessionId: string, opts: { length: number; viewportY: number }) {
  const markers: FakeMarker[] = []
  const scroll: ScrollCalls = { line: [], top: 0, bottom: 0 }
  const fake = {
    buffer: {
      active: {
        length: opts.length,
        baseY: 0,
        cursorY: opts.length - 1,
        viewportY: opts.viewportY,
        getLine: () => ({ translateToString: () => '' }),
      },
    },
    registerMarker: (offset: number) => {
      const m: FakeMarker = {
        line: fake.buffer.active.baseY + fake.buffer.active.cursorY + offset,
        isDisposed: false,
        onDispose: (cb: () => void) => { m._onDispose = cb },
        dispose: vi.fn(() => {
          m.isDisposed = true
          m._onDispose?.()
        }),
      }
      markers.push(m)
      return m
    },
    scrollToLine: (line: number) => {
      scroll.line.push(line)
      fake.buffer.active.viewportY = line
    },
    scrollToTop: () => {
      scroll.top++
      fake.buffer.active.viewportY = 0
    },
    scrollToBottom: () => {
      scroll.bottom++
      fake.buffer.active.viewportY = opts.length - 1
    },
  }
  termInstances.set(sessionId, {
    term: fake as unknown as Terminal,
    fit: {} as TermInstance['fit'],
    search: {} as TermInstance['search'],
    ws: { readyState: WebSocket.OPEN } as WebSocket,
    reconnectAttempts: 0,
    reconnectTimer: null,
    resizeObserver: { disconnect: () => {} } as unknown as ResizeObserver,
    writeChain: Promise.resolve(),
  })
  return { markers, scroll, fake }
}

const SID = 'sess-blocks'

beforeEach(() => {
  termInstances.delete(SID)
  resetCommandBlocks(SID)
})

describe('recordCommandBlockAnchor 锚点记账', () => {
  it('在回显行注册 marker：offset 相对当前光标（bash 时序光标在回显行下一行）', () => {
    const { markers } = installFakeSession(SID, { length: 100, viewportY: 0 })
    // 光标在 99（buffer 底），回显行 98 → offset -1
    recordCommandBlockAnchor(SID, 98)
    expect(markers).toHaveLength(1)
    expect(markers[0]!.line).toBe(98)
    expect(commandBlockCount(SID)).toBe(1)
  })

  it('越界锚点静默跳过：负行 / 超缓冲尾不注册', () => {
    const { markers } = installFakeSession(SID, { length: 50, viewportY: 0 })
    recordCommandBlockAnchor(SID, -1)
    recordCommandBlockAnchor(SID, 50)
    expect(markers).toHaveLength(0)
    expect(commandBlockCount(SID)).toBe(0)
  })

  it('上限裁剪：超过 MAX_BLOCKS_PER_SESSION 时最旧 marker 被 dispose', () => {
    const { markers } = installFakeSession(SID, { length: 5000, viewportY: 0 })
    // registerMarker 按「光标行 + offset」算 line（假 term 光标固定在 4999）：
    // 锚点行递增注册，line 跟随递增
    for (let i = 0; i < MAX_BLOCKS_PER_SESSION + 5; i++) {
      recordCommandBlockAnchor(SID, 1000 + i)
    }
    expect(commandBlockCount(SID)).toBe(MAX_BLOCKS_PER_SESSION)
    // 被裁剪的是最旧 5 个（dispose 触发 onDispose 摘除引用）
    const disposedOldest = markers.slice(0, 5).every(m => m.isDisposed)
    expect(disposedOldest).toBe(true)
  })
})

describe('scrollCommandBlock 跳过导航', () => {
  it('无锚点返回 false 不滚动（无 shell 集成降级现状）', () => {
    const { scroll } = installFakeSession(SID, { length: 100, viewportY: 0 })
    expect(scrollCommandBlock(SID, 1)).toBe(false)
    expect(scrollCommandBlock(SID, -1)).toBe(false)
    expect(scroll.line).toHaveLength(0)
    expect(scroll.top).toBe(0)
    expect(scroll.bottom).toBe(0)
  })

  it('锚点已全部滚出缓冲（line<0）视同无锚点', () => {
    const { markers, scroll } = installFakeSession(SID, { length: 100, viewportY: 0 })
    recordCommandBlockAnchor(SID, 10)
    markers[0]!.line = -1 // 模拟 xterm 裁剪置 disposed 形态
    expect(scrollCommandBlock(SID, 1)).toBe(false)
    expect(scroll.line).toHaveLength(0)
  })

  it('下一块：视口顶 + 1 外的首个锚点，定位 = 锚点行 - 1（留一行上文），连按严格推进', () => {
    const { scroll } = installFakeSession(SID, { length: 200, viewportY: 0 })
    recordCommandBlockAnchor(SID, 10)
    recordCommandBlockAnchor(SID, 30)
    recordCommandBlockAnchor(SID, 60)
    // 视口顶 0 → 首个 >1 的锚点是 10 → scrollToLine(9)；再按视口顶 9 → >10 即 30 →
    // scrollToLine(29)；再按 → >30 即 60 → scrollToLine(59)
    expect(scrollCommandBlock(SID, 1)).toBe(true)
    expect(scrollCommandBlock(SID, 1)).toBe(true)
    expect(scrollCommandBlock(SID, 1)).toBe(true)
    expect(scroll.line).toEqual([9, 29, 59])
  })

  it('下一块耗尽回落活跃提示符（scrollToBottom）且稳定不抖', () => {
    const { scroll } = installFakeSession(SID, { length: 200, viewportY: 0 })
    recordCommandBlockAnchor(SID, 10)
    expect(scrollCommandBlock(SID, 1)).toBe(true) // → 9
    expect(scrollCommandBlock(SID, 1)).toBe(true) // 无 >10 的锚点 → bottom（视口 199）
    expect(scrollCommandBlock(SID, 1)).toBe(true) // 无 >200 的锚点 → bottom 稳定
    expect(scroll.line).toEqual([9])
    expect(scroll.bottom).toBe(2)
  })

  it('上一块：视口顶之前的最后锚点；与 next 严格互逆；耗尽回落会话顶', () => {
    const { scroll } = installFakeSession(SID, { length: 200, viewportY: 100 })
    recordCommandBlockAnchor(SID, 10)
    recordCommandBlockAnchor(SID, 30)
    // 视口顶 100（深在末块输出中间）→ 上一块 = 30 → scrollToLine(29)
    expect(scrollCommandBlock(SID, -1)).toBe(true)
    // 视口顶 29 → 上一块 = 10 → scrollToLine(9)
    expect(scrollCommandBlock(SID, -1)).toBe(true)
    // 视口顶 9 → 无 <9 的锚点 → scrollToTop；再按 top 稳定
    expect(scrollCommandBlock(SID, -1)).toBe(true)
    expect(scrollCommandBlock(SID, -1)).toBe(true)
    expect(scroll.line).toEqual([29, 9])
    expect(scroll.top).toBe(2)
  })

  it('会话实例缺失不滚动', () => {
    installFakeSession(SID, { length: 100, viewportY: 0 })
    recordCommandBlockAnchor(SID, 10)
    termInstances.delete(SID)
    expect(scrollCommandBlock(SID, 1)).toBe(false)
  })
})

describe('resetCommandBlocks 会话释放对账', () => {
  it('清空锚点并 dispose 全部 marker', () => {
    const { markers } = installFakeSession(SID, { length: 100, viewportY: 0 })
    recordCommandBlockAnchor(SID, 10)
    recordCommandBlockAnchor(SID, 20)
    resetCommandBlocks(SID)
    expect(commandBlockCount(SID)).toBe(0)
    expect(markers.every(m => m.isDisposed)).toBe(true)
    // 再 dispose 幂等（onDispose 查表早退）
    expect(() => resetCommandBlocks(SID)).not.toThrow()
  })
})
