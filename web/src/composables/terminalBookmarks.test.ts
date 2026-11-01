import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { termInstances, type TermInstance } from './useTerminalInstances'
import {
  MAX_BOOKMARKS_PER_SESSION,
  addBookmarkAtLine,
  bookmarkCount,
  bookmarkVersion,
  bufferLineFromPointer,
  isLineBookmarked,
  listBookmarks,
  removeBookmarkAtLine,
  resetBookmarks,
  scrollToBookmark,
  toggleBookmarkAtLine,
} from './terminalBookmarks'

// ── mock 边界：本模块只依赖共享 termInstances Map 里的 xterm 实例。
// 测试注入假 term（buffer + registerMarker/registerDecoration 捕获器 + 元素矩形
// 桩），标记语义（幂等去重 / 越界跳过 / 上限裁最旧 / 快照文本）与列表/滚动/
// 几何解析（pointer → 缓冲行）就地断言 ──

interface FakeMarker {
  line: number
  isDisposed: boolean
  onDispose: (cb: () => void) => void
  _onDispose?: () => void
  dispose: () => void
}

interface FakeDeco {
  classList: { add: (cls: string) => void }
  renderClasses: string[]
  isDisposed: boolean
}

/** 模拟行文本表：getLine 按行号返回预置文本 */
function makeLines(lines: Record<number, string>) {
  return {
    getLine: (i: number) =>
      lines[i] !== undefined
        ? { translateToString: () => lines[i]! }
        : undefined,
  }
}

function installFakeSession(
  sessionId: string,
  opts: {
    length: number
    viewportY: number
    cursorLine?: number
    lines?: Record<number, string>
    screenRect?: { top: number; height: number }
    rows?: number
  },
) {
  const markers: FakeMarker[] = []
  const decos: FakeDeco[] = []
  const scroll: number[] = []
  const rows = opts.rows ?? 10
  const cursorLine = opts.cursorLine ?? opts.length - 1
  const fake = {
    rows,
    element: opts.screenRect
      ? {
          querySelector: (sel: string) => {
            if (sel !== '.xterm-screen') return null
            // 真实元素桩：getBoundingClientRect 返回预置矩形
            return {
              getBoundingClientRect: () => ({ top: opts.screenRect!.top, height: opts.screenRect!.height }),
            }
          },
        }
      : undefined,
    buffer: {
      active: {
        length: opts.length,
        baseY: 0,
        cursorY: cursorLine,
        viewportY: opts.viewportY,
        ...makeLines(opts.lines ?? {}),
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
    registerDecoration: (_opts: unknown) => {
      const d: FakeDeco = {
        classList: { add: (cls: string) => d.renderClasses.push(cls) },
        renderClasses: [],
        isDisposed: false,
      }
      decos.push(d)
      return {
        onRender: (cb: (el: FakeDeco) => void) => cb(d),
        dispose: () => { d.isDisposed = true },
      }
    },
    scrollToLine: (line: number) => {
      scroll.push(line)
      fake.buffer.active.viewportY = line
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
  return { markers, decos, scroll, fake }
}

const SID = 'sess-bookmarks'

beforeEach(() => {
  termInstances.delete(SID)
  resetBookmarks(SID)
})

describe('addBookmarkAtLine 标记', () => {
  it('在指定行注册 marker + 1 cell 装饰小旗，快照行文本（去尾空白）', () => {
    const { markers, decos } = installFakeSession(SID, {
      length: 100,
      viewportY: 0,
      lines: { 42: 'error at src/main.go:12   ' },
    })
    expect(addBookmarkAtLine(SID, 42)).toBe(true)
    expect(markers).toHaveLength(1)
    expect(markers[0]!.line).toBe(42)
    expect(decos).toHaveLength(1)
    expect(decos[0]!.renderClasses).toEqual(['sc-bookmark'])
    expect(listBookmarks(SID)).toEqual([{ line: 42, text: 'error at src/main.go:12' }])
  })

  it('同线重复标记幂等：不重复建旗，返回 true', () => {
    installFakeSession(SID, { length: 100, viewportY: 0 })
    expect(addBookmarkAtLine(SID, 10)).toBe(true)
    expect(addBookmarkAtLine(SID, 10)).toBe(true)
    expect(bookmarkCount(SID)).toBe(1)
  })

  it('越界行（负数/超缓冲尾）/实例缺失拒绝', () => {
    installFakeSession(SID, { length: 50, viewportY: 0 })
    expect(addBookmarkAtLine(SID, -1)).toBe(false)
    expect(addBookmarkAtLine(SID, 50)).toBe(false)
    termInstances.delete(SID)
    expect(addBookmarkAtLine(SID, 5)).toBe(false)
    expect(bookmarkCount(SID)).toBe(0)
  })

  it('上限裁最旧：超过 MAX_BOOKMARKS_PER_SESSION 时最早的 marker 被 dispose', () => {
    const { markers } = installFakeSession(SID, { length: 5000, viewportY: 0 })
    for (let i = 0; i < MAX_BOOKMARKS_PER_SESSION + 3; i++) {
      addBookmarkAtLine(SID, 100 + i)
    }
    expect(bookmarkCount(SID)).toBe(MAX_BOOKMARKS_PER_SESSION)
    expect(markers.slice(0, 3).every(m => m.isDisposed)).toBe(true)
    // 被裁的行不再在列表里
    expect(isLineBookmarked(SID, 100)).toBe(false)
    expect(isLineBookmarked(SID, 100 + MAX_BOOKMARKS_PER_SESSION + 2)).toBe(true)
  })
})

describe('toggleBookmarkAtLine 切换', () => {
  it('未标记 → 标记（true）；再切 → 摘除（false）且 marker dispose', () => {
    const { markers } = installFakeSession(SID, { length: 100, viewportY: 0 })
    expect(toggleBookmarkAtLine(SID, 30)).toBe(true)
    expect(isLineBookmarked(SID, 30)).toBe(true)
    expect(toggleBookmarkAtLine(SID, 30)).toBe(false)
    expect(isLineBookmarked(SID, 30)).toBe(false)
    expect(bookmarkCount(SID)).toBe(0)
    expect(markers[0]!.isDisposed).toBe(true)
  })
})

describe('listBookmarks 列表', () => {
  it('按行号升序；行淘汰（marker.line = -1）后不再出现', () => {
    const { markers } = installFakeSession(SID, { length: 200, viewportY: 0 })
    addBookmarkAtLine(SID, 80)
    addBookmarkAtLine(SID, 20)
    addBookmarkAtLine(SID, 50)
    expect(listBookmarks(SID).map(b => b.line)).toEqual([20, 50, 80])
    // 环形淘汰模拟：xterm 把 marker 所在行裁出缓冲 → line 置 -1 并 dispose
    // （markers 序 = 标记序 80/20/50，裁第 3 个 = 行 50）
    markers[2]!.line = -1
    markers[2]!.dispose()
    expect(listBookmarks(SID).map(b => b.line)).toEqual([20, 80])
    expect(bookmarkCount(SID)).toBe(2)
  })
})

describe('scrollToBookmark 定位', () => {
  it('滚动到书签行（视口顶对齐）；实例缺失返回 false', () => {
    const { scroll } = installFakeSession(SID, { length: 200, viewportY: 150 })
    expect(scrollToBookmark(SID, 42)).toBe(true)
    expect(scroll).toEqual([42])
    termInstances.delete(SID)
    expect(scrollToBookmark(SID, 42)).toBe(false)
  })

  it('越界行号钳入缓冲界内（快照行号与实时缓冲的固有近似兜底）', () => {
    const { scroll } = installFakeSession(SID, { length: 100, viewportY: 0 })
    scrollToBookmark(SID, 999)
    expect(scroll).toEqual([99])
    scrollToBookmark(SID, -5)
    expect(scroll).toEqual([99, 0])
  })
})

describe('bufferLineFromPointer 指针 → 缓冲行', () => {
  it('clientY 落在第 3 屏行（cell 高 10px、screen top 100）→ viewportY + 2', () => {
    const { fake } = installFakeSession(SID, {
      length: 200,
      viewportY: 50,
      rows: 10,
      screenRect: { top: 100, height: 100 }, // 10 行 × 10px
    })
    expect(bufferLineFromPointer(fake as unknown as Terminal, 121)).toBe(52)
  })

  it('越界（screen 外/预备区）与元素缺失返回 null', () => {
    const { fake } = installFakeSession(SID, {
      length: 50,
      viewportY: 0,
      rows: 10,
      screenRect: { top: 100, height: 100 },
    })
    expect(bufferLineFromPointer(fake as unknown as Terminal, 50)).toBeNull() // screen 上方
    expect(bufferLineFromPointer(fake as unknown as Terminal, 300)).toBeNull() // screen 下方
    // 缓冲尾钳制：viewportY + row 超 length（line 50 > length-1 = 49）
    const fake2 = installFakeSession(SID, {
      length: 5,
      viewportY: 0,
      rows: 10,
      screenRect: { top: 0, height: 100 },
    })
    // 第 10 屏行 → line 9 > 4 → null（尾部预分配空白不可标记）
    expect(bufferLineFromPointer(fake2.fake as unknown as Terminal, 95)).toBeNull()
    const noEl = installFakeSession(SID, { length: 50, viewportY: 0 })
    expect(bufferLineFromPointer(noEl.fake as unknown as Terminal, 10)).toBeNull()
  })
})

describe('resetBookmarks 会话释放对账', () => {
  it('清空书签并 dispose 全部 marker；重复调用幂等', () => {
    const { markers } = installFakeSession(SID, { length: 100, viewportY: 0 })
    addBookmarkAtLine(SID, 10)
    addBookmarkAtLine(SID, 20)
    resetBookmarks(SID)
    expect(bookmarkCount(SID)).toBe(0)
    expect(markers.every(m => m.isDisposed)).toBe(true)
    expect(() => resetBookmarks(SID)).not.toThrow()
  })
})

describe('bookmarkVersion 变更版本', () => {
  it('加/删/淘汰失效/复位都自增（面板 watch 依据）', () => {
    installFakeSession(SID, { length: 100, viewportY: 0 })
    const before = bookmarkVersion.value
    addBookmarkAtLine(SID, 8)
    expect(bookmarkVersion.value).toBeGreaterThan(before)
    const afterAdd = bookmarkVersion.value
    removeBookmarkAtLine(SID, 8)
    expect(bookmarkVersion.value).toBeGreaterThan(afterAdd)
    const afterRemove = bookmarkVersion.value
    resetBookmarks(SID)
    expect(bookmarkVersion.value).toBeGreaterThanOrEqual(afterRemove)
  })
})
