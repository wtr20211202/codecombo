import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPasteUnsupportedHint, useFileTreePaste } from './useFileTreePaste'
import { useFileTreeInternalClipboard } from './useFileTreeClipboard'

// 粘贴编排（P-20261023-2）：通道优先级分流（OS 文件 → 目录引导 → 内部剪贴板 →
// 截图兜底 → 能力降级）与内联输入放行。readImageFromClipboard 走 navigator.clipboard
// 桩（utils 侧已单测其分流，此处按返回形态驱动编排断言）。

/** 最小 DataTransfer 替身（jsdom 无 items 实现） */
function makeDT(shape: { files?: File[]; types?: string[]; items?: Array<{ kind: string; type: string }> }): DataTransfer {
  return { files: shape.files ?? [], types: shape.types ?? [], items: shape.items ?? [] } as unknown as DataTransfer
}

function makePasteEvent(dt: DataTransfer | null, target?: unknown): ClipboardEvent {
  return {
    clipboardData: dt,
    target: target ?? {},
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent
}

const realNavigator = navigator

function stubClipboard(clip: unknown) {
  vi.stubGlobal('navigator', { ...(realNavigator as object), clipboard: clip })
}

beforeEach(() => {
  resetPasteUnsupportedHint()
})

afterEach(() => {
  vi.unstubAllGlobals()
  useFileTreeInternalClipboard().clearTreeClipboard()
})

function setup() {
  const uploads: Array<{ files: File[]; dest: string }> = []
  const copies: Array<{ paths: string[]; dest: string }> = []
  const cuts: Array<{ paths: string[]; dest: string }> = []
  const messages: Array<{ kind: string; msg: string }> = []
  const p = useFileTreePaste({
    projectId: () => 'p1',
    destDir: () => 'docs',
    uploadFiles: async (files, dest) => { uploads.push({ files, dest }) },
    pasteCopy: async (paths, dest) => { copies.push({ paths, dest }) },
    pasteCut: async (paths, dest) => { cuts.push({ paths, dest }) },
    message: {
      success: (m) => messages.push({ kind: 'success', msg: m }),
      warning: (m) => messages.push({ kind: 'warning', msg: m }),
      error: (m) => messages.push({ kind: 'error', msg: m }),
      info: (m) => messages.push({ kind: 'info', msg: m }),
    },
    t: (k, params) => (params ? `${k}?${JSON.stringify(params)}` : k),
  })
  return { p, uploads, copies, cuts, messages }
}

describe('useFileTreePaste 通道优先级（P-20261023-2）', () => {
  it('OS 多文件（clipboardData.files）→ 主通道上传，preventDefault + 落位目录', async () => {
    const { p, uploads, messages } = setup()
    const dt = makeDT({ files: [new File(['a'], 'a.txt')], types: ['Files'] })
    p.handlePasteEvent(makePasteEvent(dt))
    await vi.waitFor(() => expect(uploads).toHaveLength(1))
    expect(uploads[0]).toMatchObject({ dest: 'docs' })
    expect(uploads[0]!.files[0]!.name).toBe('a.txt')
    expect(messages).toEqual([])
  })

  it('目录形态项 → 诚实引导 toast，零上传', () => {
    const { p, uploads, messages } = setup()
    p.handlePasteEvent(makePasteEvent(makeDT({ types: ['Files'], items: [{ kind: 'file', type: '' }] })))
    expect(uploads).toHaveLength(0)
    expect(messages).toEqual([{ kind: 'info', msg: 'fileTree.pasteFolderHint' }])
  })

  it('内部剪贴板 copy → pasteCopy（OS files 为空才分流到这里）', () => {
    const { p, copies } = setup()
    useFileTreeInternalClipboard().setTreeClipboard('p1', ['a.md', 'b.md'], 'copy')
    p.handlePasteEvent(makePasteEvent(makeDT({})))
    expect(copies).toEqual([{ paths: ['a.md', 'b.md'], dest: 'docs' }])
  })

  it('内部剪贴板 cut → pasteCut + 消费清板（二次粘贴不再触发）', () => {
    const { p, cuts } = setup()
    const board = useFileTreeInternalClipboard()
    board.setTreeClipboard('p1', ['a.md'], 'cut')
    p.handlePasteEvent(makePasteEvent(makeDT({})))
    expect(cuts).toHaveLength(1)
    p.handlePasteEvent(makePasteEvent(makeDT({})))
    expect(cuts).toHaveLength(1)
    expect(board.canPaste('p1')).toBe(false)
  })

  it('跨项目内部板不消费（canPaste 项目过滤）', () => {
    const { p, copies } = setup()
    useFileTreeInternalClipboard().setTreeClipboard('other', ['a.md'], 'copy')
    p.handlePasteEvent(makePasteEvent(makeDT({})))
    expect(copies).toHaveLength(0)
  })

  it('截图兜底：image 命中 → 以截图名上传 + toast 告知文件名', async () => {
    const { p, uploads, messages } = setup()
    stubClipboard({
      read: vi.fn().mockResolvedValue([
        { types: ['image/png'], getType: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' })) },
      ]),
    })
    p.handlePasteEvent(makePasteEvent(makeDT({})))
    await vi.waitFor(() => expect(uploads).toHaveLength(1))
    expect(uploads[0]!.files[0]!.name).toMatch(/^截图-\d{8}-\d{6}\.png$/)
    expect(messages.some(m => m.kind === 'info' && m.msg.startsWith('fileTree.screenshotSaved'))).toBe(true)
  })

  it('截图通道授权拒绝 → denied 降级引导，零上传', async () => {
    const { p, uploads, messages } = setup()
    stubClipboard({ read: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) })
    p.handlePasteEvent(makePasteEvent(makeDT({})))
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]).toMatchObject({ kind: 'warning', msg: 'fileTree.pasteClipboardDenied' })
    expect(uploads).toHaveLength(0)
  })

  it('无剪贴板读能力（Firefox/Safari）→ 每会话一次引导，此后静默', () => {
    const { p, messages } = setup()
    stubClipboard({ writeText: vi.fn() }) // 无 read 方法
    p.handlePasteEvent(makePasteEvent(makeDT({})))
    expect(messages).toEqual([{ kind: 'info', msg: 'fileTree.pasteUnsupported' }])
    p.handlePasteEvent(makePasteEvent(makeDT({})))
    expect(messages).toHaveLength(1) // 第二次静默（按键噪音零）
  })

  it('普通文本粘贴（read 能力在、无图）→ 静默零动作', async () => {
    const { p, uploads, messages } = setup()
    stubClipboard({ read: vi.fn().mockResolvedValue([{ types: ['text/plain'] }]) })
    p.handlePasteEvent(makePasteEvent(makeDT({ types: ['text/plain'], items: [{ kind: 'string', type: 'text/plain' }] })))
    await new Promise(r => setTimeout(r, 10))
    expect(uploads).toHaveLength(0)
    expect(messages).toEqual([])
  })

  it('内联输入里的粘贴放行为文本语义（INPUT/TEXTAREA/内联行不接管）', () => {
    const { p, uploads, messages } = setup()
    const inputTarget = { tagName: 'INPUT' }
    p.handlePasteEvent(makePasteEvent(makeDT({ files: [new File(['a'], 'a.txt')] }), inputTarget))
    const inlineTarget = { closest: (sel: string) => (sel === '.inline-input-row' ? {} : null) }
    p.handlePasteEvent(makePasteEvent(makeDT({ files: [new File(['a'], 'a.txt')] }), inlineTarget))
    expect(uploads).toHaveLength(0)
    expect(messages).toEqual([])
  })
})

describe('pasteInternal（右键「粘贴」与键盘 Ctrl+V 共用执行入口）', () => {
  it('有板 → pasteCopy；空板 → no-op 不炸', () => {
    const { p, copies } = setup()
    p.pasteInternal('target-dir') // 空板 no-op
    expect(copies).toHaveLength(0)
    useFileTreeInternalClipboard().setTreeClipboard('p1', ['x.md'], 'copy')
    p.pasteInternal('target-dir')
    expect(copies).toEqual([{ paths: ['x.md'], dest: 'target-dir' }])
  })
})
