import { describe, expect, it } from 'vitest'
import { buildDiffTree, flattenDiffTree, type DiffFile } from './diffTree'

function f(path: string, status = 'Modified'): DiffFile {
  return { path, name: path.split('/').pop()!, status }
}

describe('buildDiffTree', () => {
  it('共享前缀合并同目录，文件携带条目', () => {
    const tree = buildDiffTree([f('src/a.ts'), f('src/b.ts'), f('README.md')])
    // 顶层：src 目录 + README 文件
    expect(tree).toHaveLength(2)
    expect(tree[0]).toMatchObject({ name: 'src', isDir: true, path: 'src' })
    expect(tree[0]!.children.map(c => c.name)).toEqual(['a.ts', 'b.ts'])
    expect(tree[0]!.children[0]!.file).toMatchObject({ path: 'src/a.ts', status: 'Modified' })
    expect(tree[1]).toMatchObject({ name: 'README.md', isDir: false })
  })

  it('目录优先、同层按名称排序（深层同样生效）', () => {
    const tree = buildDiffTree([
      f('zeta.txt'), f('app/main.go'), f('beta/x.ts'), f('app/util/y.go'),
    ])
    expect(tree.map(n => `${n.isDir ? 'D' : 'F'}:${n.name}`)).toEqual([
      'D:app', 'D:beta', 'F:zeta.txt',
    ])
    expect(tree[0]!.children.map(n => n.name)).toEqual(['util', 'main.go']) // 目录优先、文件在后
    expect(tree[0]!.children[0]!.children[0]!.path).toBe('app/util/y.go')
  })
})

describe('flattenDiffTree', () => {
  it('展开目录时递归产出子行并携带深度', () => {
    const tree = buildDiffTree([f('src/a.ts'), f('src/util/b.go')])
    const rows = flattenDiffTree(tree, new Set(['src', 'src/util']))
    // 目录优先排序：util 目录排在 a.ts 文件前
    expect(rows.map(r => `${r.depth}:${r.name}`)).toEqual([
      '0:src', '1:util', '2:b.go', '1:a.ts',
    ])
  })

  it('未展开目录的子树跳过（折叠态只产目录行）', () => {
    const tree = buildDiffTree([f('src/a.ts'), f('README.md')])
    const rows = flattenDiffTree(tree, new Set())
    expect(rows.map(r => r.name)).toEqual(['src', 'README.md'])
    expect(rows[0]!.children).toHaveLength(1)
  })
})
