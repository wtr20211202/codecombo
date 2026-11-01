import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractPasteFiles, isAllowedPasteFileExt, PASTE_FILE_MAX_COUNT,
  pasteUploadKind, quotePastePathIfNeeded, readImageFromClipboard,
  screenshotFileName, supportsClipboardRead,
} from './pasteFiles'

// 粘贴通道解析纯函数（P-20261023-2）：DataTransfer 形状鸭子类型便于构造——
// files/types/items 三面分别覆盖主通道、目录形态探测、空载与文本粘贴分流。

/** 构造最小 DataTransfer 替身（jsdom 无 DataTransfer.items 实现） */
function makeDT(shape: {
  files?: File[]
  types?: string[]
  items?: Array<{ kind: string; type: string }>
}): DataTransfer {
  return {
    files: shape.files ?? [],
    types: shape.types ?? [],
    items: shape.items ?? [],
  } as unknown as DataTransfer
}

describe('extractPasteFiles（主通道 + 目录形态探测）', () => {
  it('clipboardData 缺失（合成事件）安全回落空载', () => {
    expect(extractPasteFiles(null)).toEqual({ files: [], folderLike: false })
    expect(extractPasteFiles(undefined)).toEqual({ files: [], folderLike: false })
  })

  it('OS 多文件复制：files 直传，不误报目录形态', () => {
    const dt = makeDT({
      files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
      types: ['Files'],
      items: [{ kind: 'file', type: 'text/plain' }],
    })
    const r = extractPasteFiles(dt)
    expect(r.files).toHaveLength(2)
    expect(r.files.map(f => f.name)).toEqual(['a.txt', 'b.txt'])
    expect(r.folderLike).toBe(false)
  })

  it('目录粘贴（types 含 Files 但 files 为空）→ folderLike', () => {
    const dt = makeDT({ types: ['Files'], items: [{ kind: 'file', type: '' }] })
    const r = extractPasteFiles(dt)
    expect(r.files).toHaveLength(0)
    expect(r.folderLike).toBe(true)
  })

  it('零字节无类型项（kind=file、type 空串）即目录特征，types 不含 Files 也命中', () => {
    const dt = makeDT({ items: [{ kind: 'file', type: '' }] })
    expect(extractPasteFiles(dt).folderLike).toBe(true)
  })

  it('文本/图片字符串粘贴：零文件零目录形态（静默分流到后续通道）', () => {
    expect(extractPasteFiles(makeDT({ types: ['text/plain'], items: [{ kind: 'string', type: 'text/plain' }] })))
      .toEqual({ files: [], folderLike: false })
  })
})

describe('supportsClipboardRead / readImageFromClipboard（截图兜底通道）', () => {
  const realNavigator = navigator

  afterEach(() => {
    vi.unstubAllGlobals()
    void realNavigator
  })

  function stubClipboard(clip: unknown) {
    vi.stubGlobal('navigator', { ...(realNavigator as object), clipboard: clip })
  }

  it('无 clipboard.read（Firefox/Safari）→ 不支持，readImage 直接 none', async () => {
    stubClipboard({ writeText: vi.fn() })
    expect(supportsClipboardRead()).toBe(false)
    expect(await readImageFromClipboard()).toEqual({ kind: 'none' })
  })

  it('read() 抛错（授权拒绝 NotAllowedError 等）→ denied（调用方降级引导）', async () => {
    stubClipboard({ read: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) })
    expect(supportsClipboardRead()).toBe(true)
    expect(await readImageFromClipboard()).toEqual({ kind: 'denied' })
  })

  it('剪贴板无图片（纯文本）→ none（静默，文本粘贴不弹引导）', async () => {
    stubClipboard({ read: vi.fn().mockResolvedValue([{ types: ['text/plain'] }]) })
    expect(await readImageFromClipboard()).toEqual({ kind: 'none' })
  })

  it('image/png 命中：blob 转 File，扩展名 png', async () => {
    const blob = new Blob(['png-bytes'], { type: 'image/png' })
    stubClipboard({
      read: vi.fn().mockResolvedValue([
        { types: ['text/plain', 'image/png'], getType: vi.fn().mockResolvedValue(blob) },
      ]),
    })
    const r = await readImageFromClipboard()
    expect(r.kind).toBe('image')
    if (r.kind === 'image') {
      expect(r.file.name).toBe('image.png')
      expect(r.file.type).toBe('image/png')
    }
  })

  it('image/jpeg 命中：扩展名随 MIME 主类型', async () => {
    const blob = new Blob(['jpg'], { type: 'image/jpeg' })
    stubClipboard({
      read: vi.fn().mockResolvedValue([{ types: ['image/jpeg'], getType: vi.fn().mockResolvedValue(blob) }]),
    })
    const r = await readImageFromClipboard()
    if (r.kind === 'image') expect(r.file.name).toBe('image.jpg')
    else expect.fail('expected image result')
  })

  it('getType 失败 → denied（不炸不半传）', async () => {
    stubClipboard({
      read: vi.fn().mockResolvedValue([{ types: ['image/png'], getType: vi.fn().mockRejectedValue(new Error('gone')) }]),
    })
    expect(await readImageFromClipboard()).toEqual({ kind: 'denied' })
  })
})

describe('screenshotFileName（提案 ② 命名式）', () => {
  it('截图-YYYYMMDD-HHmmss.png，两位补零', () => {
    expect(screenshotFileName(new Date(2026, 9, 23, 7, 8, 9))).toBe('截图-20261023-070809.png')
    expect(screenshotFileName(new Date(2026, 11, 31, 23, 59, 59))).toBe('截图-20261231-235959.png')
  })
})

describe('终端文件粘贴（P-20261024-2 纯函数）', () => {
  it('pasteUploadKind 分派：image/* 走 image 链，白名单扩展名走 file 链，其余 unsupported', () => {
    expect(pasteUploadKind({ name: 'shot.png', type: 'image/png' })).toBe('image')
    // OS 复制的图片文件也可能 MIME 为空：按扩展名落 file 链（服务端白名单含图片）
    expect(pasteUploadKind({ name: 'photo.jpg', type: '' })).toBe('file')
    expect(pasteUploadKind({ name: 'report.pdf', type: 'application/pdf' })).toBe('file')
    expect(pasteUploadKind({ name: 'notes.md', type: 'text/plain' })).toBe('file')
    expect(pasteUploadKind({ name: 'evil.exe', type: 'application/octet-stream' })).toBe('unsupported')
    expect(pasteUploadKind({ name: 'Makefile', type: '' })).toBe('unsupported')
  })

  it('isAllowedPasteFileExt：大小写归一、无扩展名拒绝、白名单抽样', () => {
    expect(isAllowedPasteFileExt('A.TXT')).toBe(true)
    expect(isAllowedPasteFileExt('a.tar.gz')).toBe(true) // lastdot = .gz
    expect(isAllowedPasteFileExt('noext')).toBe(false)
    expect(isAllowedPasteFileExt('.env')).toBe(false)
    expect(isAllowedPasteFileExt('a.zip')).toBe(true)
    expect(isAllowedPasteFileExt('a.py')).toBe(true)
    expect(isAllowedPasteFileExt('a.docx')).toBe(true)
  })

  it('quotePastePathIfNeeded：含空白双引号包裹，其余原样', () => {
    expect(quotePastePathIfNeeded('C:/Users/John Doe/AppData/Local/Temp/sc-paste-1.png')).toBe('"C:/Users/John Doe/AppData/Local/Temp/sc-paste-1.png"')
    expect(quotePastePathIfNeeded('C:/Temp/sc-paste-1.png')).toBe('C:/Temp/sc-paste-1.png')
    expect(quotePastePathIfNeeded('/tmp/sc-paste-1.md')).toBe('/tmp/sc-paste-1.md')
  })

  it('PASTE_FILE_MAX_COUNT 与提案口径一致（=5）', () => {
    expect(PASTE_FILE_MAX_COUNT).toBe(5)
  })
})
