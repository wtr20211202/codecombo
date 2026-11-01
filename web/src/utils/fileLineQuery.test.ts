import { describe, expect, it } from 'vitest'
import { parseFileLineQuery } from './fileLineQuery'

describe('parseFileLineQuery（P-20261003-302 文件名:行号直达语法）', () => {
  it('普通形态 name:N：剥离出文件名与行号', () => {
    expect(parseFileLineQuery('app.ts:42')).toEqual({ text: 'app.ts', line: 42 })
  })

  it('name:N:C 形态：行号 + 列号', () => {
    expect(parseFileLineQuery('app.ts:42:7')).toEqual({ text: 'app.ts', line: 42, col: 7 })
    expect(parseFileLineQuery('src/x/y.go:3:15')).toEqual({ text: 'src/x/y.go', line: 3, col: 15 })
  })

  it('首段懒惰匹配：文件名含数字冒号段不被吞进行号', () => {
    // 贪心会把 a:1:2 拆成 line=2——必须 line=1 col=2
    expect(parseFileLineQuery('a:1:2')).toEqual({ text: 'a', line: 1, col: 2 })
  })

  it('文件名自身含冒号（罕见）：仍按最后一个数字段取行', () => {
    expect(parseFileLineQuery('weird:name:9')).toEqual({ text: 'weird:name', line: 9 })
  })

  it('首尾空白容忍，text 已 trim 且保留原大小写', () => {
    expect(parseFileLineQuery('  UseRepo.ts:12  ')).toEqual({ text: 'UseRepo.ts', line: 12 })
    // 冒号与行号间夹空格不解析（终端粘贴形态是紧凑的 file.ts:42，宽格式从简）
    expect(parseFileLineQuery('UseRepo.ts : 12')).toBeNull()
  })

  it('无行号后缀：返回 null（整串当文件名匹配）', () => {
    expect(parseFileLineQuery('app.ts')).toBeNull()
    expect(parseFileLineQuery('')).toBeNull()
    expect(parseFileLineQuery('   ')).toBeNull()
  })

  it('后缀非正整数：不启用行语义（整串回退普通匹配）', () => {
    expect(parseFileLineQuery('app.ts:0')).toBeNull()
    expect(parseFileLineQuery('app.ts:abc')).toBeNull()
    expect(parseFileLineQuery('app.ts:4x2')).toBeNull()
    expect(parseFileLineQuery('app.ts:42:x')).toBeNull()
    expect(parseFileLineQuery(':42')).toBeNull()
  })

  it('尾巴才认行号：中部冒号数字段属文件名', () => {
    expect(parseFileLineQuery('v1:final.ts')).toBeNull()
    expect(parseFileLineQuery('v1:final.ts:5')).toEqual({ text: 'v1:final.ts', line: 5 })
  })
})
