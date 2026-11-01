import { describe, expect, it } from 'vitest'
import { buildChangeSummary, changeStatusLetter, toStatMap } from './changeSummary'
import type { NumstatFile } from '../api/domains/git'

// 变更摘要纯函数（P-20261003-219）：标签面用桩翻译（无参键原样返回，带参键
// 键+参数 JSON——gitStatusSummary 同款「极小翻译面」约定），断言只盯结构与数字
const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

describe('changeStatusLetter', () => {
  it('FileStatus 状态 → git 短状态字母（语言中立）', () => {
    expect(changeStatusLetter('Modified')).toBe('M')
    expect(changeStatusLetter('Added')).toBe('A')
    expect(changeStatusLetter('Deleted')).toBe('D')
    expect(changeStatusLetter('Renamed')).toBe('R')
    expect(changeStatusLetter('Copied')).toBe('C')
    expect(changeStatusLetter('Unmerged')).toBe('U')
    expect(changeStatusLetter('Untracked')).toBe('?')
  })

  it('未知状态回落首字母大写（新状态字母不丢文件）', () => {
    expect(changeStatusLetter('Typechange')).toBe('T')
  })
})

describe('buildChangeSummary', () => {
  it('头部总计数行 + 每文件 stat 行式（路径字典序）', () => {
    const text = buildChangeSummary(
      [
        { path: 'src/b.ts', status: 'Modified' },
        { path: 'src/a.ts', status: 'Modified' },
        { path: 'notes/new.md', status: 'Untracked' },
      ],
      toStatMap([
        { path: 'src/a.ts', additions: 3, deletions: 1 },
        { path: 'src/b.ts', additions: 10, deletions: 2 },
        { path: 'notes/new.md', additions: 7, deletions: 0 },
      ] as NumstatFile[]),
      'main',
      t,
    )
    const lines = text.split('\n')
    expect(lines[0]).toContain('changes.summary.headBranch')
    expect(lines[0]).toContain('"n":3')
    expect(lines[0]).toContain('"a":20')
    expect(lines[0]).toContain('"d":3')
    // 行序 = 全路径字典序（notes < src）
    expect(lines.slice(1)).toEqual([
      '- ? notes/new.md +7 -0',
      '- M src/a.ts +3 -1',
      '- M src/b.ts +10 -2',
    ])
  })

  it('无分支时头部走无分支模板；分支两侧空白修剪', () => {
    const text = buildChangeSummary([{ path: 'a.ts', status: 'Modified' }], toStatMap([{ path: 'a.ts', additions: 1, deletions: 1 }]), '  ', t)
    expect(text.split('\n')[0]).toContain('changes.summary.head')
    expect(text.split('\n')[0]).not.toContain('headBranch')
  })

  it('同路径去重（porcelain 对「已暂存又改」会出两条记录，摘要一个文件一行）', () => {
    const text = buildChangeSummary(
      [
        { path: 'a.ts', status: 'Modified' },
        { path: 'a.ts', status: 'Modified' },
      ],
      toStatMap([{ path: 'a.ts', additions: 4, deletions: 4 }]),
      'main',
      t,
    )
    expect(text.split('\n')).toHaveLength(2) // 头 + 单文件行
    expect(text.split('\n')[0]).toContain('"n":1')
    expect(text.split('\n')[0]).toContain('"a":4')
  })

  it('二进制文件以标签代替行数且不入总计数', () => {
    const text = buildChangeSummary(
      [
        { path: 'logo.png', status: 'Added' },
        { path: 'a.ts', status: 'Modified' },
      ],
      toStatMap([
        { path: 'logo.png', additions: 0, deletions: 0, binary: true },
        { path: 'a.ts', additions: 2, deletions: 0 },
      ] as NumstatFile[]),
      'main',
      t,
    )
    expect(text).toContain('- A logo.png (changes.summary.binary)')
    expect(text.split('\n')[0]).toContain('"a":2')
  })

  it('numstat 未覆盖的文件只出状态字母不出行数（冲突未合并等，宁缺毋谎）', () => {
    const text = buildChangeSummary(
      [{ path: 'conflict.txt', status: 'Unmerged' }],
      toStatMap([]),
      'main',
      t,
    )
    expect(text.split('\n')[1]).toBe('- U conflict.txt')
    expect(text.split('\n')[0]).toContain('"a":0')
  })

  it('空变更集返回空串（调用方在空态不触发复制）', () => {
    expect(buildChangeSummary([], toStatMap([]), 'main', t)).toBe('')
  })
})

describe('toStatMap', () => {
  it('按 path 建索引，脏行（缺 path）防御性丢弃', () => {
    const map = toStatMap([
      { path: 'a.ts', additions: 1, deletions: 2 },
      { path: '', additions: 9, deletions: 9 },
      undefined as unknown as NumstatFile,
    ] as NumstatFile[])
    expect(map.size).toBe(1)
    expect(map.get('a.ts')).toEqual({ additions: 1, deletions: 2, binary: false })
  })
})
