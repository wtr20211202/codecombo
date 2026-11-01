import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { termInstances, type TermInstance } from './useTerminalInstances'
import {
  noteCommandTimeStart,
  noteCommandTimeEnd,
  resolveHitCommandAt,
  resetCommandTimes,
  commandTimeCount,
  MAX_TIMES_PER_SESSION,
  outputTimeRange,
  inOutputTimeRange,
} from './terminalCommandTimes'

// ── mock 边界：本模块依赖共享 termInstances Map 里的 xterm 实例（区间 marker 账）
// 与 terminalOutputLocate.locateQueryInBuffer（命中行文本反查——真实现直跑，假 term
// 的 buffer.lines 提供真实行文本即可）。记账语义（回显行起点 / D 重锚换 marker /
// 淘汰摘账 / 上限裁剪）与命中归属（文本锚反查 / 区间包含判定 / 开放领地）就地断言；
// 时间档纯函数（1h/今天/自定义）独立覆盖 ──

interface FakeMarker {
  line: number
  onDispose: (cb: () => void) => void
  _onDispose?: () => void
  // 测试要直接调用 dispose 触发淘汰回调——收窄为可调用签名
  //（ReturnType<typeof vi.fn> 在新 vitest 类型下不可直接调用）
  dispose: () => void
}

function installFakeSession(
  sessionId: string,
  opts: { lines: string[]; baseY?: number; cursorY?: number; rows?: number },
) {
  const rows = opts.rows ?? opts.lines.length
  const baseY = opts.baseY ?? 0
  const cursorY = opts.cursorY ?? Math.max(0, opts.lines.length - 1 - baseY)
  const markers: FakeMarker[] = []
  const fake = {
    rows,
    buffer: {
      active: {
        length: opts.lines.length,
        baseY,
        cursorY,
        getLine: (i: number) => ({
          translateToString: () => opts.lines[i] ?? '',
        }),
      },
    },
    registerMarker: (offset: number) => {
      const m: FakeMarker = {
        line: fake.buffer.active.baseY + fake.buffer.active.cursorY + offset,
        onDispose: (cb: () => void) => { m._onDispose = cb },
        dispose: vi.fn(() => { m._onDispose?.() }),
      }
      markers.push(m)
      return m
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
  return { markers, fake }
}

const SID = 'sess-times'

beforeEach(() => {
  termInstances.delete(SID)
  resetCommandTimes(SID)
  vi.restoreAllMocks()
})

describe('命令区间时刻记账与命中锚定（P-20261005-202）', () => {
  it('C→D 完整周期：命中行文本锚回区间内取 endedAt，区间外如实 null', () => {
    installFakeSession(SID, {
      lines: ['PS D:\\x> ', 'echo HELLO', 'HELLO', '', 'PS D:\\x> '],
    })
    // 回显行 1、输出 [2,3]
    noteCommandTimeStart(SID, 1, 1000)
    noteCommandTimeEnd(SID, 1, 3, 2000)
    expect(commandTimeCount(SID)).toBe(1)
    // 命中行文本在输出行 2 上 → 锚到本命令
    expect(resolveHitCommandAt(SID, 'HELLO')).toBe(2000)
    expect(resolveHitCommandAt(SID, 'echo HELLO')).toBe(2000)
    // 提示符行（首行，无命令文本重叠）不归属任何账
    expect(resolveHitCommandAt(SID, 'PS D:\\x>')).toBeNull()
  })

  it('运行中命令（C 达 D 未达）：开放领地按 startedAt 锚，下一条命令起边界', () => {
    installFakeSession(SID, {
      lines: ['', 'build --watch', 'compiling a', 'compiling b', 'compiling c', '', 'git status'],
    })
    noteCommandTimeStart(SID, 1, 1000) // 长命令运行中，输出已到行 4
    expect(resolveHitCommandAt(SID, 'compiling c')).toBe(1000)
    // 第二条命令开账即收拢前一条的开放领地
    noteCommandTimeStart(SID, 6, 5000)
    expect(resolveHitCommandAt(SID, 'compiling c')).toBe(1000)
    expect(resolveHitCommandAt(SID, 'git status')).toBe(5000)
    expect(commandTimeCount(SID)).toBe(2)
  })

  it('D 时刻回显行重锚：换新 marker 收紧领地，旧 marker 淘汰回调不误摘账', () => {
    const { markers } = installFakeSession(SID, {
      lines: ['junk', 'echo GREETING', 'GREETING OUT', 'tail'],
    })
    noteCommandTimeStart(SID, 1, 1000)
    // tmux 滞后帧：D 时刻内容重锚把回显行从 1 移到 2，endLine 2
    noteCommandTimeEnd(SID, 2, 2, 2000)
    expect(resolveHitCommandAt(SID, 'echo GREETING')).toBeNull() // 旧回显行已出领地
    expect(resolveHitCommandAt(SID, 'GREETING OUT')).toBe(2000)
    // 旧 start marker（line 1）被换下：dispose 它不得摘掉账
    const stale = markers.find((m) => m.line === 1)
    expect(stale).toBeDefined()
    stale!.dispose()
    expect(commandTimeCount(SID)).toBe(1)
    expect(resolveHitCommandAt(SID, 'GREETING OUT')).toBe(2000)
  })

  it('marker 被 xterm 淘汰（滚动裁剪/清屏）：整条摘账，命中如实 null', () => {
    const { markers } = installFakeSession(SID, {
      lines: ['echo GREETING', 'GREETING OUT', '', ''],
    })
    noteCommandTimeStart(SID, 0, 1000)
    noteCommandTimeEnd(SID, 0, 1, 2000)
    expect(resolveHitCommandAt(SID, 'GREETING OUT')).toBe(2000)
    // 起点 marker 淘汰即区间失效（终行 marker 未淘汰也要等它自己淘汰）
    markers.find((m) => m.line === 0)!.dispose()
    expect(commandTimeCount(SID)).toBe(0)
    expect(resolveHitCommandAt(SID, 'GREETING OUT')).toBeNull()
  })

  it('账本上限：超 MAX 摘最旧（marker 连带 dispose），新账照记', () => {
    const lines: string[] = []
    for (let i = 0; i < MAX_TIMES_PER_SESSION + 10; i++) {
      lines.push(`cmd-${i}`, `out-${i}`)
    }
    installFakeSession(SID, { lines })
    for (let i = 0; i < MAX_TIMES_PER_SESSION + 10; i++) {
      const echoLine = i * 2
      noteCommandTimeStart(SID, echoLine, i)
      noteCommandTimeEnd(SID, echoLine, echoLine + 1, i)
    }
    expect(commandTimeCount(SID)).toBe(MAX_TIMES_PER_SESSION)
    // 最旧 10 条已裁（现存最旧 start=20）：out-0 不再归属；最新一条照常
    expect(resolveHitCommandAt(SID, 'out-0')).toBeNull()
    expect(resolveHitCommandAt(SID, 'out-109')).toBe(MAX_TIMES_PER_SESSION + 9)
  })

  it('超长行截窗片段（省略号剥除）：任一连续片段能锚回所属命令', () => {
    installFakeSession(SID, {
      lines: ['npm run build', 'ERR! 1234567890abcdef THIS IS THE ERROR LINE BODY 9876543210', ''],
    })
    noteCommandTimeStart(SID, 0, 1000)
    noteCommandTimeEnd(SID, 0, 1, 2000)
    // 服务端截窗形态「前段…后段」：最长片段仍是缓冲行子串
    expect(resolveHitCommandAt(SID, 'ERR! 1234567890abcdef…BODY 9876543210')).toBe(2000)
    expect(resolveHitCommandAt(SID, '…THIS IS THE ERROR LINE BODY 9876543210')).toBe(2000)
  })

  it('降级面：无实例 / 过短行 / 无账本均 null；reset 清账', () => {
    expect(resolveHitCommandAt('ghost', 'any long enough text')).toBeNull()
    installFakeSession(SID, { lines: ['echo HI', 'HI'] })
    expect(resolveHitCommandAt(SID, 'HI')).toBeNull() // 无账本（无 shell 集成）
    expect(resolveHitCommandAt(SID, 'hi')).toBeNull() // 过短行不锚（误锚率高）
    noteCommandTimeStart(SID, 0, 1000)
    resetCommandTimes(SID)
    expect(commandTimeCount(SID)).toBe(0)
    expect(resolveHitCommandAt(SID, 'HI')).toBeNull()
  })
})

describe('时间档过滤纯函数（P-20261005-202）', () => {
  const NOW = new Date(2026, 9, 15, 14, 30, 0).getTime() // 本地 2026-10-15 14:30

  it('all 不过滤；1h = now-3600s 下界', () => {
    expect(outputTimeRange('all', NOW, { start: '', end: '' })).toBeNull()
    const r = outputTimeRange('1h', NOW, { start: '', end: '' })!
    expect(r.fromMs).toBe(NOW - 60 * 60 * 1000)
    expect(r.toMs).toBeNull()
    expect(inOutputTimeRange(NOW - 1, r)).toBe(true)
    expect(inOutputTimeRange(NOW - 60 * 60 * 1000 - 1, r)).toBe(false)
  })

  it('today = 本地当日零点起', () => {
    const r = outputTimeRange('today', NOW, { start: '', end: '' })!
    expect(r.fromMs).toBe(new Date(2026, 9, 15, 0, 0, 0, 0).getTime())
    expect(inOutputTimeRange(new Date(2026, 9, 14, 23, 59).getTime(), r)).toBe(false)
    expect(inOutputTimeRange(NOW, r)).toBe(true)
  })

  it('custom 起止：空侧开放、非法侧按开放、双侧命中判定', () => {
    const full = outputTimeRange('custom', NOW, {
      start: '2026-10-15T08:00',
      end: '2026-10-15T12:00',
    })!
    expect(full.fromMs).toBe(new Date(2026, 9, 15, 8, 0).getTime())
    expect(full.toMs).toBe(new Date(2026, 9, 15, 12, 0).getTime())
    expect(inOutputTimeRange(new Date(2026, 9, 15, 10, 0).getTime(), full)).toBe(true)
    expect(inOutputTimeRange(NOW, full)).toBe(false)
    // 只填起点 = 起点开放的「自该时刻起」；非法值同侧开放
    const half = outputTimeRange('custom', NOW, { start: '2026-10-15T08:00', end: 'junk' })!
    expect(half.fromMs).toBe(new Date(2026, 9, 15, 8, 0).getTime())
    expect(half.toMs).toBeNull()
    expect(inOutputTimeRange(NOW, half)).toBe(true)
  })
})
