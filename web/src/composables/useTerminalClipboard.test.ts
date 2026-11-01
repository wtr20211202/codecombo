import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { messageMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'

// ── mock 边界：命令文本记账来自 useTerminalSession 的模块级表（OSC 133 E 帧），
// 单测只需可注入返回值；writeClipboard 的降级链走真实实现（jsdom 桩 clipboard
// API 的 secure-context 主路径），入史 store 需要 active pinia（beforeEach 建） ──
const { commandRecordMock } = vi.hoisted(() => ({ commandRecordMock: vi.fn() }))

vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()))
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()))
vi.mock('./useTerminalSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useTerminalSession')>()
  return { ...actual, getLastCommandOutputRecord: commandRecordMock }
})

import { useTerminalClipboard } from './useTerminalClipboard'
import type { TermInstance } from './useTerminalInstances'

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  resetNaiveRuntimeMocks()
  commandRecordMock.mockReset()
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  Reflect.deleteProperty(navigator as unknown as object, 'clipboard')
  Reflect.deleteProperty(window, 'isSecureContext')
})

function makeClipboard(selection: string) {
  const clearSelection = vi.fn()
  const inst = { term: { getSelection: () => selection, clearSelection } } as unknown as TermInstance
  const api = useTerminalClipboard({
    termInstances: new Map([['t1', inst]]),
    uploadPaste: async () => null,
  })
  return { api, clearSelection }
}

describe('useTerminalClipboard.copySelectionAsCodeBlock', () => {
  it('选区包 ```bash 围栏并带最近命令的 `$ <command>` 头，成功后清选区', async () => {
    commandRecordMock.mockReturnValue({ command: 'npm run build' })
    const { api, clearSelection } = makeClipboard('error: boom')

    await api.copySelectionAsCodeBlock('t1')

    expect(writeText).toHaveBeenCalledWith('```bash\n$ npm run build\nerror: boom\n```')
    expect(messageMock.success).toHaveBeenCalledWith('terminal.copyDone')
    expect(clearSelection).toHaveBeenCalledTimes(1)
  })

  it('无命令记账（无 shell 集成/命令运行中）只出围栏，不编造命令头', async () => {
    commandRecordMock.mockReturnValue(undefined)
    const { api } = makeClipboard('plain output')

    await api.copySelectionAsCodeBlock('t1')

    expect(writeText).toHaveBeenCalledWith('```bash\nplain output\n```')
  })

  it('无选区提示且不写剪贴板（与「复制」同一门禁）', async () => {
    commandRecordMock.mockReturnValue(undefined)
    const { api, clearSelection } = makeClipboard('')

    await api.copySelectionAsCodeBlock('t1')

    expect(messageMock.info).toHaveBeenCalledWith('terminal.noSelection')
    expect(writeText).not.toHaveBeenCalled()
    expect(clearSelection).not.toHaveBeenCalled()
  })

  it('纯文本「复制」行为保持原样（选区原样入剪贴板，两入口并存）', async () => {
    const { api, clearSelection } = makeClipboard('error: boom')

    await api.copySelectionToClipboard('t1')

    expect(writeText).toHaveBeenCalledWith('error: boom')
    expect(clearSelection).toHaveBeenCalledTimes(1)
  })
})

// ============== 原生 paste 事件接管（P-20261024-2 终端文件粘贴） ==============
// Ctrl+V 键控放行链在 useTerminalKeys（键位表单测域），此处守 paste 事件监听的
// 编排语义：文件分派上传/引号包裹/多文件贴入/toast 汇总/in-flight 去抖/目录引导。

function makeFilePasteHarness(uploadImpl?: (file: File, kind: 'image' | 'file') => Promise<string | null>) {
  const paste = vi.fn()
  const focus = vi.fn()
  const inst = { term: { paste, focus, getSelection: () => '', clearSelection: vi.fn() } } as unknown as TermInstance
  const uploadPaste = vi.fn(uploadImpl ?? (async () => '/tmp/sc-paste-1.txt'))
  const api = useTerminalClipboard({ termInstances: new Map([['t1', inst]]), uploadPaste })
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  textarea.focus()
  const detach = api.attachNativePaste(textarea, 't1')
  return { paste, uploadPaste, textarea, detach }
}

/** 构造最小 clipboardData 替身（jsdom 无 ClipboardEvent.clipboardData 实现） */
function dispatchPaste(dt: {
  files?: File[]
  types?: string[]
  items?: Array<{ kind: string; type: string }>
  text?: string
}): ClipboardEvent {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(e, 'clipboardData', {
    value: { files: dt.files ?? [], types: dt.types ?? [], items: dt.items ?? [], getData: () => dt.text ?? '' },
  })
  document.dispatchEvent(e)
  return e
}

const flush = () => new Promise<void>(r => setTimeout(r, 0))

describe('useTerminalClipboard.attachNativePaste（文件粘贴编排）', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('文件粘贴：逐个上传、逐文件一行贴入、成功 toast 计数', async () => {
    const h = makeFilePasteHarness(async (file, kind) =>
      kind === 'file' ? `/tmp/${file.name}` : '/tmp/sc-paste-shot.png')
    dispatchPaste({
      files: [new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.md', { type: '' })],
      types: ['Files'],
    })
    await flush()
    expect(h.uploadPaste).toHaveBeenCalledTimes(2)
    expect(h.uploadPaste).toHaveBeenCalledWith(expect.any(File), 'file')
    expect(h.paste).toHaveBeenCalledWith(['/tmp/a.txt', '/tmp/b.md'].join('\n'))
    expect(messageMock.success).toHaveBeenCalledWith('terminal.pasteFile.done:{"n":2}')
    h.detach()
  })

  it('image/* 文件走 image 链（压缩链语义），无空格路径原样贴入', async () => {
    const h = makeFilePasteHarness(async () => '/tmp/sc-paste-2.png')
    dispatchPaste({ files: [new File(['x'], 'shot.png', { type: 'image/png' })], types: ['Files'] })
    await flush()
    expect(h.uploadPaste).toHaveBeenCalledWith(expect.any(File), 'image')
    expect(h.paste).toHaveBeenCalledWith('/tmp/sc-paste-2.png')
    h.detach()
  })

  it('含空白路径双引号包裹（Windows 用户目录带空格的 shell 兼容）', async () => {
    const h = makeFilePasteHarness(async () => 'C:/Users/John Doe/AppData/Local/Temp/sc-paste-3.txt')
    dispatchPaste({ files: [new File(['a'], 'a.txt', { type: 'text/plain' })], types: ['Files'] })
    await flush()
    expect(h.paste).toHaveBeenCalledWith('"C:/Users/John Doe/AppData/Local/Temp/sc-paste-3.txt"')
    h.detach()
  })

  it('白名单外文件不上传，出「不支持类型」反馈，不阻断其余文件', async () => {
    const h = makeFilePasteHarness(async (file) => `/tmp/${file.name}`)
    dispatchPaste({
      files: [new File(['x'], 'evil.exe', { type: 'application/octet-stream' }), new File(['y'], 'ok.txt', { type: 'text/plain' })],
      types: ['Files'],
    })
    await flush()
    expect(h.uploadPaste).toHaveBeenCalledTimes(1)
    expect(h.paste).toHaveBeenCalledWith('/tmp/ok.txt')
    expect(messageMock.error).toHaveBeenCalledWith('terminal.pasteFile.unsupported:{"name":"evil.exe"}')
    expect(messageMock.success).toHaveBeenCalledWith('terminal.pasteFile.done:{"n":1}')
    h.detach()
  })

  it('超单次上限截断到 5 个并出提示', async () => {
    const h = makeFilePasteHarness()
    dispatchPaste({
      files: Array.from({ length: 7 }, (_, i) => new File(['x'], `f${i}.txt`, { type: 'text/plain' })),
      types: ['Files'],
    })
    await flush()
    expect(h.uploadPaste).toHaveBeenCalledTimes(5)
    expect(messageMock.warning).toHaveBeenCalledWith('terminal.pasteFile.tooMany:{"n":5}')
    h.detach()
  })

  it('in-flight 去抖：上传进行中的再次粘贴被忽略（不并发上传不重复贴入）', async () => {
    let release!: (v: string) => void
    const gate = new Promise<string>(r => { release = r })
    const h = makeFilePasteHarness(() => gate)
    dispatchPaste({ files: [new File(['a'], 'a.txt', { type: 'text/plain' })], types: ['Files'] })
    dispatchPaste({ files: [new File(['b'], 'b.txt', { type: 'text/plain' })], types: ['Files'] })
    release('/tmp/only.txt')
    await flush()
    expect(h.uploadPaste).toHaveBeenCalledTimes(1)
    expect(h.paste).toHaveBeenCalledTimes(1)
    h.detach()
  })

  it('目录形态项（Files 声明零文件）：引导 toast 不上传', async () => {
    const h = makeFilePasteHarness()
    dispatchPaste({ files: [], types: ['Files'], items: [{ kind: 'file', type: '' }] })
    expect(messageMock.warning).toHaveBeenCalledWith('terminal.pasteFile.folderHint')
    expect(h.uploadPaste).not.toHaveBeenCalled()
    h.detach()
  })

  it('纯文本粘贴：接管并 applyPaste（去尾换行沿用 applyPaste 语义）', () => {
    const h = makeFilePasteHarness()
    const e = dispatchPaste({ text: 'echo hi' })
    expect(e.defaultPrevented).toBe(true)
    expect(h.paste).toHaveBeenCalledWith('echo hi')
    expect(h.uploadPaste).not.toHaveBeenCalled()
    h.detach()
  })
})
