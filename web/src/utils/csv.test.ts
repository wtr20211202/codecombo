import { describe, it, expect } from 'vitest'
import { buildCsv, sanitizeCsvCell } from './csv'

/**
 * 前端 CSV 构建（P-20261003-272）单测：与服务端导出族同模式的三个不变量——
 * RFC 4180 转义、公式注入防护（=+/-@ 前置单引号）、UTF-8 BOM。
 * e2e（search-export-csv.spec.ts）在此基础上对真下载产物对账。
 */
describe('sanitizeCsvCell 公式注入防护', () => {
  it('= 开头前置单引号（任务书点名的转义）', () => {
    expect(sanitizeCsvCell('=cmd')).toBe("'=cmd")
  })

  it('+ - @ 及制表/回车开头同防护（与 shared.SanitizeCSVCell 同字符集）', () => {
    expect(sanitizeCsvCell('+1')).toBe("'+1")
    expect(sanitizeCsvCell('-flag')).toBe("'-flag")
    expect(sanitizeCsvCell('@x')).toBe("'@x")
    expect(sanitizeCsvCell('\tz')).toBe("'\tz")
    expect(sanitizeCsvCell('\r\n')).toBe("'\r\n")
  })

  it('普通/空内容原样', () => {
    expect(sanitizeCsvCell('plain')).toBe('plain')
    expect(sanitizeCsvCell('')).toBe('')
    expect(sanitizeCsvCell("a'b")).toBe("a'b")
  })
})

describe('buildCsv RFC 4180 与整体形状', () => {
  it('含逗号/引号/换行的字段加引号且内部引号翻倍', () => {
    expect(buildCsv(['c'], [['a,b']])).toBe('\uFEFFc\n"a,b"\n')
    expect(buildCsv(['c'], [['say "hi"']])).toBe('\uFEFFc\n"say ""hi"""\n')
    expect(buildCsv(['c'], [['l1\nl2']])).toBe('\uFEFFc\n"l1\nl2"\n')
  })

  it('无需引用的字段保持裸值；多行 LF 分隔 + 尾随换行', () => {
    expect(buildCsv(['file', 'line', 'content'], [['a.txt', '3', '=cmd']]))
      .toBe('\uFEFFfile,line,content\na.txt,3,\'=cmd\n')
  })

  it('空数据行集只余 BOM + 表头', () => {
    expect(buildCsv(['h1', 'h2'], [])).toBe('\uFEFFh1,h2\n')
  })

  it('防注入与加引号叠加：=开头且含逗号 → 引号包裹内保留单引号前缀', () => {
    expect(buildCsv(['c'], [['=a,b']])).toBe('\uFEFFc\n"\'=a,b"\n')
  })
})
