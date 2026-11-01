import { describe, expect, it } from 'vitest'
import { collectDropFiles, hasDirectoryEntry, DROP_ENTRY_FILE_CAP } from './dropEntries'

// 目录拖入枚举（P-20261023-2③b）：FileSystemEntry 回调式接口用桩对象实现——
// 只覆盖本模块消费的形状（isFile/isDirectory/name/file()/createReader()）。

function fakeFileEntry(name: string, content: string): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/${name}`,
    file: (cb: (f: File) => void) => cb(new File([content], name)),
  } as unknown as FileSystemFileEntry
}

function fakeDirEntry(name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    createReader: () => {
      // readEntries 每批 ≤100 条的规范语义：单批全量返回后下一批为空批收尾
      let done = false
      return {
        readEntries: (cb: (es: FileSystemEntry[]) => void) => {
          if (done) cb([])
          else {
            done = true
            cb(children)
          }
        },
      } as FileSystemDirectoryReader
    },
  } as unknown as FileSystemDirectoryEntry
}

describe('hasDirectoryEntry（同步取 entry，事件期约束）', () => {
  it('items 带 webkitGetAsEntry：返回 entry 清单', () => {
    const e = fakeDirEntry('d', [])
    const dt = {
      items: [{ webkitGetAsEntry: () => e }],
    } as unknown as DataTransfer
    expect(hasDirectoryEntry(dt)).toEqual([e])
  })

  it('无 entry（合成事件/老引擎）：可选调用返回空清单不炸', () => {
    const dt = { items: [{}] } as unknown as DataTransfer
    expect(hasDirectoryEntry(dt)).toEqual([])
  })
})

describe('collectDropFiles（递归展平 + 相对路径改名）', () => {
  it('无 entry / 纯文件拖入：null = 调用方回落平铺既有链', async () => {
    expect(await collectDropFiles([])).toBe(null)
    const fileOnly = [fakeFileEntry('a.txt', 'a')]
    expect(await collectDropFiles(fileOnly)).toBe(null)
  })

  it('目录递归展平：File 以相对路径改名，内容/类型保留', async () => {
    const dir = fakeDirEntry('mydir', [
      fakeFileEntry('a.txt', 'a'),
      fakeDirEntry('sub', [fakeFileEntry('b.txt', 'b')]),
    ])
    const r = await collectDropFiles([dir])
    expect(r).not.toBe(null)
    expect(r!.truncated).toBe(false)
    expect(r!.files.map(f => f.name).sort()).toEqual(['mydir/a.txt', 'mydir/sub/b.txt'])
    const a = r!.files.find(f => f.name === 'mydir/a.txt')!
    expect(await a.text()).toBe('a')
  })

  it('混合拖入（文件+目录）：文件保留根名，目录保留为落位子目录', async () => {
    const entries = [
      fakeFileEntry('loose.md', 'loose'),
      fakeDirEntry('pack', [fakeFileEntry('x.txt', 'x')]),
    ]
    const r = await collectDropFiles(entries)
    expect(r!.files.map(f => f.name).sort()).toEqual(['loose.md', 'pack/x.txt'])
  })

  it('触顶截断：state.truncated 置位并停止枚举', async () => {
    const many = Array.from({ length: DROP_ENTRY_FILE_CAP + 10 }, (_, i) => fakeFileEntry(`f${i}.txt`, 'x'))
    const dir = fakeDirEntry('big', many)
    const r = await collectDropFiles([dir])
    expect(r!.files).toHaveLength(DROP_ENTRY_FILE_CAP)
    expect(r!.truncated).toBe(true)
  })

  it('不可读子树/不可读文件跳过：局部残缺不整体失败', async () => {
    const badFile = {
      isFile: true, isDirectory: false, name: 'bad.txt', fullPath: '/big/bad.txt',
      file: (_cb: (f: File) => void, err: (e: DOMException) => void) => err(new DOMException('locked', 'NotReadableError')),
    } as unknown as FileSystemFileEntry
    const badDir = {
      isFile: false, isDirectory: true, name: 'lockeddir', fullPath: '/big/lockeddir',
      createReader: () => ({
        readEntries: (_cb: (es: FileSystemEntry[]) => void, err: (e: DOMException) => void) => err(new DOMException('denied', 'NotAllowedError')),
      }) as FileSystemDirectoryReader,
    } as unknown as FileSystemDirectoryEntry
    const dir = fakeDirEntry('big', [badFile, badDir, fakeFileEntry('ok.txt', 'ok')])
    const r = await collectDropFiles([dir])
    expect(r!.files.map(f => f.name)).toEqual(['big/ok.txt'])
    expect(r!.truncated).toBe(false)
  })
})
