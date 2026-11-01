import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { termInstances, type TermInstance } from './useTerminalInstances'
import {
  landTerminalOutputLocate,
  locateQueryInBuffer,
  requestTerminalOutputLocate,
} from './terminalOutputLocate'

// ── mock 边界：本模块只依赖 xterm 实例的 buffer.active 读面 + scrollToLine/select
// 两个动作。测试注入假 term（预置行文本表 + 动作捕获器），定位语义（最近命中/
// 大小写不敏感/跨软换行拼行）、落点（滚动钳制 + 整行选区）与轮询调度（即时落点/
// 落定后判缺席/超时兜底/取消与单槽后到者胜）就地断言 ──

/** 预置行文本表 → 假 buffer/term：translateToString 返回整行，line.length 即
 * cell 数（按文本长近似，落点断言只关心透传值） */
function makeTerm(lines: string[]) {
  const calls = { scrolledTo: [] as number[], selected: [] as Array<{ col: number; row: number; len: number }> }
  const term = {
    buffer: {
      active: {
        length: lines.length,
        getLine: (i: number) => {
          const text = lines[i]
          if (text === undefined) return undefined
          return { translateToString: () => text, length: text.length }
        },
      },
    },
    scrollToLine: (line: number) => { calls.scrolledTo.push(line) },
    select: (col: number, row: number, len: number) => { calls.selected.push({ col, row, len }) },
  }
  return { term: term as unknown as Terminal, calls }
}

function installFakeSession(sessionId: string, lines: string[]): { term: Terminal; calls: ReturnType<typeof makeTerm>['calls'] } {
  const { term, calls } = makeTerm(lines)
  termInstances.set(sessionId, {
    term,
    fit: {} as TermInstance['fit'],
    search: {} as TermInstance['search'],
    ws: { readyState: WebSocket.OPEN } as WebSocket,
    reconnectAttempts: 0,
    reconnectTimer: null,
    resizeObserver: { disconnect: () => {} } as unknown as ResizeObserver,
    writeChain: Promise.resolve(),
  })
  return { term, calls }
}

const SID = 'sess-output-locate'

beforeEach(() => {
  vi.useFakeTimers()
  termInstances.delete(SID)
})
afterEach(() => {
  vi.useRealTimers()
  termInstances.delete(SID)
})

describe('locateQueryInBuffer 定位', () => {
  it('取自底部向上最近一次命中（重复报错刷屏时最近一处优先）', () => {
    const { term } = makeTerm(['ERR-xyz early', 'filler', 'other', 'ERR-xyz latest', 'tail'])
    expect(locateQueryInBuffer(term, 'ERR-xyz')).toBe(3)
  })

  it('大小写不敏感（与 /api/terminals/search 的 strings.Contains(lower) 同语义）', () => {
    const { term } = makeTerm(['connection REFUSED on port 5432'])
    expect(locateQueryInBuffer(term, 'refused')).toBe(0)
  })

  it('命中词跨软换行边界也能定位（服务端一行 → 前端两视行，锚在起点行）', () => {
    const { term } = makeTerm(['error: conn', 'ection refused by host'])
    expect(locateQueryInBuffer(term, 'connection refused')).toBe(0)
  })

  it('空查询与未命中返回 null', () => {
    const { term } = makeTerm(['hello', 'world'])
    expect(locateQueryInBuffer(term, '')).toBeNull()
    expect(locateQueryInBuffer(term, 'missing')).toBeNull()
  })
})

describe('landTerminalOutputLocate 落点', () => {
  it('滚动定位 + 整行选区高亮（cell 数取该行 length）', () => {
    const { term, calls } = makeTerm(['a', 'the hit line', 'c'])
    landTerminalOutputLocate(term, 1)
    expect(calls.scrolledTo).toEqual([1])
    expect(calls.selected).toEqual([{ col: 0, row: 1, len: 'the hit line'.length }])
  })

  it('越界钳制（负行→0，超缓冲尾→末行），钳到末行仍可整行选中', () => {
    const { term, calls } = makeTerm(['only', 'two'])
    landTerminalOutputLocate(term, -5)
    landTerminalOutputLocate(term, 99)
    expect(calls.scrolledTo).toEqual([0, 1])
    expect(calls.selected).toEqual([
      { col: 0, row: 0, len: 4 },
      { col: 0, row: 1, len: 3 },
    ])
  })
})

describe('requestTerminalOutputLocate 轮询消费', () => {
  it('实例已在场（tab v-show 保活已连接）：首轮即落点并回调 onLand', () => {
    const { calls } = installFakeSession(SID, ['filler', 'MARK-ONE here', 'tail'])
    const onLand = vi.fn()
    const onMissing = vi.fn()
    requestTerminalOutputLocate(SID, 'MARK-ONE', { onLand, onMissing })
    vi.advanceTimersByTime(200)
    expect(onLand).toHaveBeenCalledWith(1)
    expect(onMissing).not.toHaveBeenCalled()
    expect(calls.scrolledTo).toEqual([1])
  })

  it('实例未就绪（跨项目冷挂载）：实例登记后落点', () => {
    const onLand = vi.fn()
    requestTerminalOutputLocate(SID, 'MARK-TWO', { onLand })
    vi.advanceTimersByTime(450)
    expect(onLand).not.toHaveBeenCalled()
    installFakeSession(SID, ['x', 'has MARK-TWO inside'])
    vi.advanceTimersByTime(200)
    expect(onLand).toHaveBeenCalledWith(1)
  })

  it('缓冲落定（非空+写链空闲+长度连续 2 轮不变）仍无命中 → onMissing', () => {
    installFakeSession(SID, ['plain', 'lines'])
    const onMissing = vi.fn()
    const onLand = vi.fn()
    requestTerminalOutputLocate(SID, 'GONE-MARK', { onLand, onMissing })
    // 连续 2 轮长度稳定才判缺席（首轮只建基线）：单轮停涨不足以定论
    vi.advanceTimersByTime(160)
    expect(onMissing).not.toHaveBeenCalled()
    vi.advanceTimersByTime(320)
    expect(onMissing).toHaveBeenCalledTimes(1)
    expect(onLand).not.toHaveBeenCalled()
  })

  it('重放进行中（写链在途/缓冲增长）不下缺席结论，落定后才判', () => {
    const { term } = installFakeSession(SID, ['half replay'])
    const onMissing = vi.fn()
    requestTerminalOutputLocate(SID, 'LATE-MARK', { onMissing })
    const inst = termInstances.get(SID)!
    const mutableLen = term.buffer.active as unknown as { length: number }
    // 帧 1 到达：写链在途，缓冲增长
    inst.pendingWrites = 1
    mutableLen.length = 50
    vi.advanceTimersByTime(600)
    expect(onMissing).not.toHaveBeenCalled()
    // 重放落定：写链清空 + 长度稳定 2 轮 → 缺席判定
    inst.pendingWrites = 0
    vi.advanceTimersByTime(400)
    expect(onMissing).toHaveBeenCalledTimes(1)
  })

  it('实例曾在场又消失（pane 关闭/接管重挂）静默作废，不误报缺席', () => {
    installFakeSession(SID, ['soon gone'])
    const onMissing = vi.fn()
    requestTerminalOutputLocate(SID, 'ANY-MARK', { onMissing })
    vi.advanceTimersByTime(160)
    termInstances.delete(SID)
    vi.advanceTimersByTime(8000)
    expect(onMissing).not.toHaveBeenCalled()
  })

  it('超时兜底同走缺席口径（慢网大缓冲等不到落定）', () => {
    const { term } = installFakeSession(SID, ['growing'])
    const onMissing = vi.fn()
    requestTerminalOutputLocate(SID, 'NEVER-MARK', { onMissing }, { timeoutMs: 1000 })
    // 持续抖动的缓冲永不满足稳定判定，只能等超时兜底
    const mutableLen = term.buffer.active as unknown as { length: number }
    let n = 0
    for (let t = 0; t < 1200; t += 150) {
      vi.advanceTimersByTime(150)
      mutableLen.length = 10 + (n++ % 2)
    }
    expect(onMissing).toHaveBeenCalledTimes(1)
  })

  it('取消函数停轮；后到请求单槽胜出（前序轮询作废不落点）', () => {
    const { calls } = installFakeSession(SID, ['stale MARK-OLD'])
    const onLandA = vi.fn()
    const cancel = requestTerminalOutputLocate(SID, 'MARK-OLD', { onLand: onLandA })
    cancel()
    vi.advanceTimersByTime(1000)
    expect(onLandA).not.toHaveBeenCalled()
    expect(calls.scrolledTo).toEqual([])

    // 后到者胜：A 未取消但被 B 顶掉（A 不落点），B 正常落点
    const onLandB = vi.fn()
    requestTerminalOutputLocate(SID, 'NOPE', { onLand: onLandA })
    requestTerminalOutputLocate(SID, 'MARK-OLD', { onLand: onLandB })
    vi.advanceTimersByTime(200)
    expect(onLandA).not.toHaveBeenCalled()
    expect(onLandB).toHaveBeenCalledWith(0)
  })
})
