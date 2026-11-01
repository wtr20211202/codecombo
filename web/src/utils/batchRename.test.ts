import { describe, expect, it } from 'vitest'
import { computeBatchRename, replaceAllLiteral } from './batchRename'

// 批量重命名预览纯函数（P-20261003-283）：字面替换 / changed 判定 /
// 非法红标四源（空名·分隔符·P-132 兼容·批内冲突）/ 父先子后排序。
describe('replaceAllLiteral', () => {
  it('字面全量替换，元字符无特殊义', () => {
    expect(replaceAllLiteral('a(b)c', '(', '-')).toBe('a-b)c')
    expect(replaceAllLiteral('aXbXc', 'X', '-')).toBe('a-b-c')
    expect(replaceAllLiteral('aaa', 'aa', 'b')).toBe('ba')
  })

  it('查找串为空：原样返回（不产生替换）', () => {
    expect(replaceAllLiteral('abc', '', 'x')).toBe('abc')
  })
})

describe('computeBatchRename', () => {
  it('命中项产出 changed 对照（全量出现都替换），未命中项 changed=false', () => {
    const rows = computeBatchRename(['docs/aaa.md'], 'a', 'A')
    expect(rows.map(r => [r.path, r.name, r.newName, r.changed])).toEqual([
      ['docs/aaa.md', 'aaa.md', 'AAA.md', true],
    ])
    // 叶子名不含查找串：unchanged（路径其余段不参与替换）
    const rows2 = computeBatchRename(['pkg/old/readme.md'], 'old', 'new')
    expect(rows2[0]).toMatchObject({ name: 'readme.md', newName: 'readme.md', changed: false, issue: null })
  })

  it('查找串为空：全部 unchanged（确认入口无从开启）', () => {
    const rows = computeBatchRename(['a.md', 'b.md'], '', 'x')
    expect(rows.every(r => !r.changed)).toBe(true)
  })

  it('整名被替换为空：emptyName 非法', () => {
    const rows = computeBatchRename(['tmp/x.log'], 'x.log', '')
    expect(rows[0]).toMatchObject({ changed: true, newName: '', issue: 'emptyName' })
  })

  it('替换串含路径分隔符：sepInName 非法（改名不得夹带挪目录）', () => {
    const rows = computeBatchRename(['a.txt'], 'a', 'x/y')
    expect(rows[0]).toMatchObject({ changed: true, issue: 'sepInName' })
  })

  it('P-132 兼容红标透传：Windows 保留设备名 / 段结尾点', () => {
    const rows = computeBatchRename(['do.txt'], 'do', 'con')
    expect(rows[0]).toMatchObject({ newName: 'con.txt', issue: 'reservedWindowsName' })
    const rows2 = computeBatchRename(['a.b'], 'b', 'c.')
    expect(rows2[0]).toMatchObject({ newName: 'a.c.', issue: 'trailingDotSpace' })
  })

  it('同父目录改名结果重名：后到者标 collision（先到先得同执行链）', () => {
    // 字面替换下两不同名收敛同结果：aa.txt/ab.txt 删 a 都得 b.txt
    const rows = computeBatchRename(['d/ab.txt', 'd/aab.txt'], 'a', '')
    expect(rows.map(r => r.newName)).toEqual(['b.txt', 'b.txt'])
    expect(rows.map(r => r.issue)).toEqual([null, 'collision'])
  })

  it('跨父目录同名结果不冲突；大小写敏感不误命中', () => {
    const rows = computeBatchRename(['p/Pkg/Pkg.md', 'q/x/Pkg.md', 'r/y/pkg.md'], 'Pkg', 'lib')
    // r/y/pkg.md 小写不含大写 Pkg：changed=false；两个命中行分属不同父目录不冲突
    expect(rows.map(r => [r.path, r.changed, r.issue])).toEqual([
      ['p/Pkg/Pkg.md', true, null],
      ['q/x/Pkg.md', true, null],
      ['r/y/pkg.md', false, null],
    ])
  })

  it('路径升序：父目录排在其子项前（执行链父先改名的预演）', () => {
    const rows = computeBatchRename(['p/pkg/readme.md', 'p/pkg'], 'pkg', 'lib')
    expect(rows.map(r => r.path)).toEqual(['p/pkg', 'p/pkg/readme.md'])
  })
})
