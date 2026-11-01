import { describe, expect, it } from 'vitest'
import { isAbsolutePath, matchPathCandidates } from '../../utils/pathScan'

// 自由文本路径扫描核（自 useTerminalFileLinks 迁入，P-20261004-61 起通知正文
// 链接化共用）：匹配用例随迁，cwd 解析/项目相对化用例留在
// composables/useTerminalFileLinks.test.ts。

describe('matchPathCandidates', () => {
  it('Windows 绝对路径 + :LINE:COL 后缀', () => {
    const m = matchPathCandidates('server\\api\\files\\file.go:18:5: error TS2321')
    expect(m).toHaveLength(1)
    expect(m[0]!.core).toBe('server\\api\\files\\file.go')
    expect(m[0]!.start).toBe(0)
    expect(m[0]!.line).toBe(18)
    expect(m[0]!.col).toBe(5)
  })

  it('Windows 盘符绝对路径：C: 冒号被核消费，:LINE 正确解析', () => {
    const m = matchPathCandidates('at C:\\repo\\src\\main.go:42')
    expect(m).toHaveLength(1)
    expect(m[0]!.core).toBe('C:\\repo\\src\\main.go')
    expect(m[0]!.line).toBe(42)
    expect(m[0]!.col).toBeUndefined()
  })

  it('POSIX 绝对路径 + 行号', () => {
    const m = matchPathCandidates('panic: /usr/local/go/src/app/server/main.go:12 +0x3a')
    expect(m).toHaveLength(1)
    expect(m[0]!.core).toBe('/usr/local/go/src/app/server/main.go')
    expect(m[0]!.line).toBe(12)
  })

  it('./ 与 ../ 显式相对形态', () => {
    expect(matchPathCandidates('./src/a.ts:3')[0]!.core).toBe('./src/a.ts')
    expect(matchPathCandidates('../lib/b.go')[0]!.core).toBe('../lib/b.go')
  })

  it('纯相对路径（至少一段斜杠）', () => {
    const m = matchPathCandidates('FAIL web/src/composables/useTerminalSession.ts:493')
    expect(m.map(x => x.core)).toContain('web/src/composables/useTerminalSession.ts')
    expect(m.find(x => x.core === 'web/src/composables/useTerminalSession.ts')!.line).toBe(493)
  })

  it('单文件名（无斜杠）不匹配：无工作区索引支撑误报过多', () => {
    expect(matchPathCandidates('error in main.go line 3')).toHaveLength(0)
  })

  it('反斜杠相对路径（Windows 工具链输出形态）', () => {
    const m = matchPathCandidates('got server\\api\\files\\file.go:18:5 back')
    expect(m).toHaveLength(1)
    expect(m[0]!.core).toBe('server\\api\\files\\file.go')
    expect(m[0]!.line).toBe(18)
    expect(m[0]!.col).toBe(5)
  })

  it('目录尾斜杠不并入（src/lib/ 取 src/lib，运行时按目录过滤）', () => {
    const m = matchPathCandidates('modules at src/lib/ here')
    expect(m).toHaveLength(1)
    expect(m[0]!.core).toBe('src/lib')
  })

  it('UNC 路径（\\\\server\\share）不匹配：起始被前置守卫拦截', () => {
    expect(matchPathCandidates('mount \\\\srv\\share\\f.go now')).toHaveLength(0)
  })

  it('http(s) 协议地址不匹配（留给 WebLinksAddon，不劫持）', () => {
    expect(matchPathCandidates('see http://example.com/a/b here')).toHaveLength(0)
    expect(matchPathCandidates('at https://host:8080/file.go:1 x')).toHaveLength(0)
  })

  it('协议相对地址 //cdn/x.js 不匹配', () => {
    expect(matchPathCandidates('load //cdn/x.js now')).toHaveLength(0)
  })

  it('不吃长 token 中段：a.b/c 不产出 b/c 候选', () => {
    const m = matchPathCandidates('value a.b/c here')
    expect(m).toHaveLength(1)
    expect(m[0]!.core).toBe('a.b/c')
  })

  it('host:8080/file 的 /file 不单独成链', () => {
    expect(matchPathCandidates('listening on localhost:8080/x')).toHaveLength(0)
  })

  it('句尾点号不并入路径核', () => {
    const m = matchPathCandidates('see src/x.go.')
    expect(m).toHaveLength(1)
    expect(m[0]!.core).toBe('src/x.go')
  })

  it('一行多候选，起始索引正确', () => {
    const m = matchPathCandidates('diff a/src/x.go b/src/y.go')
    expect(m).toHaveLength(2)
    expect(m[0]!.core).toBe('a/src/x.go')
    expect(m[0]!.start).toBe(5)
    expect(m[1]!.core).toBe('b/src/y.go')
    expect(m[1]!.start).toBe(16)
  })

  it('@scope 形态目录段可匹配', () => {
    const m = matchPathCandidates('entry @scope/pkg/index.js:9')
    expect(m.map(x => x.core)).toContain('@scope/pkg/index.js')
  })

  it('时间戳 3:4 等无斜杠数字串不匹配', () => {
    expect(matchPathCandidates('elapsed 3:4 done')).toHaveLength(0)
  })
})

describe('isAbsolutePath', () => {
  it('盘符 / POSIX 根 / 相对', () => {
    expect(isAbsolutePath('C:\\x\\y')).toBe(true)
    expect(isAbsolutePath('C:/x/y')).toBe(true)
    expect(isAbsolutePath('/usr/bin')).toBe(true)
    expect(isAbsolutePath('src/x.go')).toBe(false)
    expect(isAbsolutePath('./x')).toBe(false)
  })
})
