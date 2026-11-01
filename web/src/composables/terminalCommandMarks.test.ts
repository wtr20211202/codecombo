import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { termInstances, type TermInstance } from './useTerminalInstances'
import {
  markCommandOutcome,
  getFailedCommandRecord,
  extractFailedCommandOutput,
  extractBufferLines,
  resetCommandMarks,
  clearFailedCommandRecord,
  pruneFailedCommandRecords,
} from './terminalCommandMarks'

// ── mock 边界：本模块只依赖共享 termInstances Map 里的 xterm 实例。
// 测试注入假 term（buffer + registerMarker/registerDecoration 捕获器），
// 装饰语义（成功绿/失败红/区间高度/上限裁剪）与失败记账就地断言 ──

interface FakeDeco {
  options: { marker: unknown; width?: number; height?: number; anchor?: string }
  renderClasses: string[]
  onRender: (cb: (el: HTMLElement) => void) => void
  dispose: ReturnType<typeof vi.fn>
}

interface FakeTerm {
  buffer: {
    active: {
      length: number
      baseY: number
      cursorY: number
      getLine: (i: number) => { translateToString: (trim: boolean) => string } | undefined
    }
  }
  registerMarker: (offset: number) => { line: number; isDisposed: boolean }
  registerDecoration: (opts: Record<string, unknown>) => FakeDeco
}

function installFakeSession(sessionId: string, lines: string[], cursorLine?: number) {
  const decos: FakeDeco[] = []
  const fake: FakeTerm = {
    buffer: {
      active: {
        length: lines.length,
        baseY: 0,
        cursorY: cursorLine ?? lines.length - 1,
        getLine: (i) => {
          const text = lines[i]
          return text === undefined ? undefined : { translateToString: () => text }
        },
      },
    },
    registerMarker: (offset) => ({ line: fake.buffer.active.baseY + fake.buffer.active.cursorY + offset, isDisposed: false }),
    registerDecoration: (opts) => {
      const classes: string[] = []
      const deco: FakeDeco = {
        options: opts as FakeDeco['options'],
        renderClasses: classes,
        onRender: (cb) => cb({ classList: { add: (c: string) => classes.push(c) } } as unknown as HTMLElement),
        dispose: vi.fn(),
      }
      decos.push(deco)
      return deco
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
  return { decos, fake }
}

const SID = 'sess-marks'

beforeEach(() => {
  termInstances.delete(SID)
  // 装饰引用与失败记录分账清理（P-20261006-37 拆分后 resetCommandMarks 不再
  // 清失败记录）：用例隔离须两路都清
  resetCommandMarks(SID)
  clearFailedCommandRecord(SID)
})

describe('markCommandOutcome 成败装饰（P-20261003-150）', () => {
  it('成功命令：装饰锚定命令行（输出首行上一行）、覆盖整块，onRender 挂 sc-cmd-ok，不入失败记录', () => {
    const { decos } = installFakeSession(SID, ['a', 'b', 'out1', 'out2', ''])
    markCommandOutcome(SID, 0, 'echo hi', { startLine: 2, endLine: 4 })
    expect(decos).toHaveLength(1)
    // 锚定输出首行的上一行（命令行）：cell 覆盖刻意避开输出首行（xterm 被装饰
    // cell 不参与 span 合并，拆文本节点会破坏行内 Range 定位）
    expect(decos[0]!.options.height).toBe(4)
    expect(decos[0]!.options.width).toBe(1)
    expect(decos[0]!.renderClasses).toEqual(['sc-cmd-ok'])
    expect(getFailedCommandRecord(SID)).toBeUndefined()
  })

  it('失败命令：sc-cmd-fail + 会话级记录（命令/退出码/区间快照）', () => {
    const { decos } = installFakeSession(SID, ['a', 'err1', 'err2', ''])
    markCommandOutcome(SID, 2, 'go test ./...', { startLine: 1, endLine: 3 })
    expect(decos).toHaveLength(1)
    expect(decos[0]!.renderClasses).toEqual(['sc-cmd-fail'])
    expect(getFailedCommandRecord(SID)).toEqual({
      command: 'go test ./...',
      exitCode: 2,
      startLine: 1,
      endLine: 3,
    })
  })

  it('无行号记账（首个 prompt 的 D 等无 C 边界场景）：不装饰不记录', () => {
    const { decos } = installFakeSession(SID, ['x'])
    markCommandOutcome(SID, 1, 'boom', undefined)
    expect(decos).toHaveLength(0)
    expect(getFailedCommandRecord(SID)).toBeUndefined()
  })

  it('区间越界（scrollback 裁剪后 start 超界）：跳过装饰，失败仍记账为钳制区间', () => {
    const { decos } = installFakeSession(SID, ['one'])
    markCommandOutcome(SID, 1, 'old-cmd', { startLine: 9, endLine: 12 })
    expect(decos).toHaveLength(0)
    expect(getFailedCommandRecord(SID)).toBeUndefined()
  })

  it('命令行在缓冲顶（start=0 无上一行可锚）：跳过装饰，失败仍记账', () => {
    const { decos } = installFakeSession(SID, ['out'])
    markCommandOutcome(SID, 1, 'top-cmd', { startLine: 0, endLine: 0 })
    expect(decos).toHaveLength(0)
    expect(getFailedCommandRecord(SID)).toEqual({
      command: 'top-cmd',
      exitCode: 1,
      startLine: 0,
      endLine: 0,
    })
  })

  it('单会话装饰上限 50：最旧装饰被 dispose（视口重绘有界）', () => {
    const { decos } = installFakeSession(SID, Array.from({ length: 120 }, (_, i) => `l${i}`))
    for (let i = 0; i < 55; i++) {
      markCommandOutcome(SID, 0, `cmd${i}`, { startLine: i + 1, endLine: i + 1 })
    }
    expect(decos.length).toBe(55)
    const disposedCount = decos.slice(0, 5).filter((d) => d.dispose.mock.calls.length > 0).length
    expect(disposedCount, '最旧 5 条被上限裁剪 dispose').toBe(5)
    expect(decos.slice(5).every((d) => d.dispose.mock.calls.length === 0)).toBe(true)
  })
})

describe('extractFailedCommandOutput / extractBufferLines', () => {
  it('失败输出按记录区间读取（含去尾部空行）', () => {
    installFakeSession(SID, ['prompt', 'fatal: bad', 'more detail', '', ''])
    markCommandOutcome(SID, 128, 'git rebase', { startLine: 1, endLine: 4 })
    expect(extractFailedCommandOutput(SID)).toBe('fatal: bad\nmore detail')
  })

  it('记录行号越界被钳制进当前缓冲（裁剪后固有近似）', () => {
    installFakeSession(SID, ['only', 'two'])
    markCommandOutcome(SID, 1, 'old', { startLine: 0, endLine: 99 })
    expect(extractFailedCommandOutput(SID)).toBe('only\ntwo')
  })

  it('extractBufferLines：倒置区间/无实例返回空串', () => {
    installFakeSession(SID, ['a', 'b'])
    expect(extractBufferLines(termInstances.get(SID)!, 1, 0)).toBe('')
    expect(extractFailedCommandOutput('no-such-session')).toBe('')
  })

  it('extractBufferLines：行尾字面空格裁剪（ConPTY 重绘补齐的空格单元格不入复制内容）', () => {
    // translateToString(true) 只裁空单元格；宿主显式写入的空格（ConPTY 重绘按
    // 宽度补齐）会保留——提取层按行右裁，防「复制上一条命令输出」拖尾随空格
    installFakeSession(SID, ['MARKER    ', 'PS D:\\proj> ', 'clean'])
    expect(extractBufferLines(termInstances.get(SID)!, 0, 2)).toBe('MARKER\nPS D:\\proj>\nclean')
  })
})

// ── 失败记录生命周期（P-20261006-37 重挂恢复拆分）：装饰引用随 pane 卸载清，
// 失败记录随会话真死清（store removeLocal/applySnapshot 收口）──
describe('失败记录生命周期（P-20261006-37）', () => {
  it('resetCommandMarks 只清装饰引用：失败记录保留（pane 卸载 ≠ 会话真死，重挂入口不置灰）', () => {
    installFakeSession(SID, ['e'])
    markCommandOutcome(SID, 1, 'x', { startLine: 0, endLine: 0 })
    expect(getFailedCommandRecord(SID)).toBeDefined()
    resetCommandMarks(SID)
    expect(getFailedCommandRecord(SID)).toBeDefined()
  })

  it('clearFailedCommandRecord 清失败记录（会话列表移除 = 会话真死）', () => {
    installFakeSession(SID, ['e'])
    markCommandOutcome(SID, 1, 'x', { startLine: 0, endLine: 0 })
    expect(getFailedCommandRecord(SID)).toBeDefined()
    clearFailedCommandRecord(SID)
    expect(getFailedCommandRecord(SID)).toBeUndefined()
  })

  it('pruneFailedCommandRecords 按存活集剪枝：死会话条目摘除、存活保留', () => {
    installFakeSession(SID, ['e'])
    markCommandOutcome(SID, 1, 'x', { startLine: 0, endLine: 0 })
    pruneFailedCommandRecords(new Set(['other-session']))
    expect(getFailedCommandRecord(SID), '存活集外 → 摘除').toBeUndefined()
    markCommandOutcome(SID, 1, 'x', { startLine: 0, endLine: 0 })
    pruneFailedCommandRecords(new Set([SID, 'other-session']))
    expect(getFailedCommandRecord(SID), '存活集内 → 保留').toBeDefined()
  })
})
