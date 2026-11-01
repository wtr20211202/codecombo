import { describe, expect, it } from 'vitest'
import {
  isPathUnderPath,
  resolveAgainstCwd,
  toProjectRelative,
} from './useTerminalFileLinks'

// 终端文件路径链接层纯函数：cwd 解析 / 项目相对化。
// 链接层接线（registerLinkProvider）与存在性探测（file-policy）依赖运行时环境，
// 由 e2e（e2e/specs/terminal-file-links.spec.ts）端到端覆盖。
// 路径匹配核（matchPathCandidates/isAbsolutePath）已收口 utils/pathScan.ts
// 共享模块（通知正文链接化 P-20261004-61 同源复用），用例随迁 utils/pathScan.test.ts。

describe('resolveAgainstCwd', () => {
  it('Windows cwd 拼接相对段', () => {
    expect(resolveAgainstCwd('D:\\w\\proj', 'src\\a.go')).toBe('D:\\w\\proj\\src\\a.go')
    expect(resolveAgainstCwd('D:\\w\\proj', 'src/a.go')).toBe('D:\\w\\proj\\src\\a.go')
  })

  it('.. 逐段弹出，根与盘符不可弹出', () => {
    expect(resolveAgainstCwd('D:\\w\\proj', '../b/c.txt')).toBe('D:\\w\\b\\c.txt')
    expect(resolveAgainstCwd('D:\\w', '..\\..\\x')).toBe('D:\\x')
    expect(resolveAgainstCwd('/home/u/p', '../q')).toBe('/home/u/q')
    expect(resolveAgainstCwd('/', 'x')).toBe('/x')
  })

  it('. 与多余分隔符被忽略', () => {
    expect(resolveAgainstCwd('/home/u/p', './src//a.go')).toBe('/home/u/p/src/a.go')
  })
})

describe('toProjectRelative / isPathUnderPath', () => {
  it('项目内 → 相对路径（正斜杠）', () => {
    expect(toProjectRelative('D:\\w\\p\\src\\a.go', 'D:\\w\\p')).toBe('src/a.go')
    expect(toProjectRelative('D:/w/p/src/a.go', 'D:\\w\\p')).toBe('src/a.go')
    expect(toProjectRelative('/home/u/p/src/a.go', '/home/u/p')).toBe('src/a.go')
  })

  it('恰为根 → 空串；根外 → null', () => {
    expect(toProjectRelative('D:\\w\\p', 'D:\\w\\p')).toBe('')
    expect(toProjectRelative('D:\\other\\x.go', 'D:\\w\\p')).toBeNull()
    expect(toProjectRelative('/etc/passwd', '/home/u/p')).toBeNull()
  })

  it('兄弟目录伪装（前缀相同但非整段）不算项目内', () => {
    expect(toProjectRelative('D:\\w\\p2\\x.go', 'D:\\w\\p')).toBeNull()
  })

  it('Windows 大小写不敏感，POSIX 敏感', () => {
    expect(toProjectRelative('D:\\W\\P\\x.go', 'd:\\w\\p')).toBe('x.go')
    expect(isPathUnderPath('D:\\W\\P', 'd:\\w\\p')).toBe(true)
    expect(isPathUnderPath('/Home/u', '/home/u')).toBe(false)
  })
})
