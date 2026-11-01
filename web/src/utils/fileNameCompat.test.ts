import { describe, it, expect } from 'vitest'
import { fileNameCompatIssue } from './fileNameCompat'

describe('fileNameCompatIssue — Windows 保留设备名', () => {
  it('裸名与大小写变体全拒', () => {
    for (const name of ['CON', 'con', 'Con', 'PRN', 'prn', 'AUX', 'NUL', 'nul']) {
      expect(fileNameCompatIssue(name)).toBe('reservedWindowsName')
    }
  })

  it('COM/LPT 1-9 全档位', () => {
    for (let i = 1; i <= 9; i++) {
      expect(fileNameCompatIssue(`COM${i}`)).toBe('reservedWindowsName')
      expect(fileNameCompatIssue(`lpt${i}`)).toBe('reservedWindowsName')
    }
  })

  it('带扩展名形态：主干命中即保留', () => {
    expect(fileNameCompatIssue('CON.txt')).toBe('reservedWindowsName')
    expect(fileNameCompatIssue('nul.md')).toBe('reservedWindowsName')
    expect(fileNameCompatIssue('aux.tar.gz')).toBe('reservedWindowsName')
  })

  it('多段路径：任一段命中即拒，正常段不受影响', () => {
    expect(fileNameCompatIssue('docs/con.txt')).toBe('reservedWindowsName')
    expect(fileNameCompatIssue('a/NUL/b.md')).toBe('reservedWindowsName')
    expect(fileNameCompatIssue('docs/guide.md')).toBeNull()
  })

  it('主干非保留名不误伤', () => {
    for (const name of ['constant.go', 'concourse.yml', 'auxiliary.ts', 'null.ts', 'console.ts']) {
      expect(fileNameCompatIssue(name)).toBeNull()
    }
  })
})

describe('fileNameCompatIssue — 段结尾点/空格', () => {
  it('结尾点与结尾空格拒（含嵌套段与全点段）', () => {
    for (const name of ['a.', 'a ', 'a. ', '...', 'docs/b .']) {
      expect(fileNameCompatIssue(name)).toBe('trailingDotSpace')
    }
  })

  it('内部点/空格与开头点不受影响', () => {
    for (const name of ['a.b', 'v1.2.3', 'a b c.md', '.gitignore', 'docs/.hidden']) {
      expect(fileNameCompatIssue(name)).toBeNull()
    }
  })

  it('空段与 "."/".." 段跳过（路径越界由服务端管）', () => {
    expect(fileNameCompatIssue('')).toBeNull()
    expect(fileNameCompatIssue('./a.txt')).toBeNull()
    expect(fileNameCompatIssue('a/../b.txt')).toBeNull()
  })
})

describe('fileNameCompatIssue — 优先级与组合', () => {
  it('同段同时命中保留名与结尾点：保留名优先（与 CON. 主干命中一致）', () => {
    expect(fileNameCompatIssue('con.')).toBe('reservedWindowsName')
  })

  it('前面的段先报：第一段结尾点优先于第二段保留名', () => {
    expect(fileNameCompatIssue('bad./con')).toBe('trailingDotSpace')
  })
})
