import { describe, expect, it } from 'vitest'
import { collectAllFilePaths, collectRangePaths } from './rangeSelection'
import type { RangeRow } from './rangeSelection'

/**
 * 键盘多选范围收集（P-20261003-271）：变更树扁平行序（目录行+文件行混合）上的
 * 锚点区间收集与全选——目录行不参与、锚点缺省回落光标行、越界行安全跳过。
 */

// 模拟变更树扁平行序：nested(dir) → nested/kappa → alpha → beta → gamma
const rows: RangeRow[] = [
  { isDir: true, path: 'nested' },
  { isDir: false, path: 'nested/kappa.txt', file: { path: 'nested/kappa.txt' } },
  { isDir: false, path: 'alpha.txt', file: { path: 'alpha.txt' } },
  { isDir: false, path: 'beta.txt', file: { path: 'beta.txt' } },
  { isDir: false, path: 'gamma.txt', file: { path: 'gamma.txt' } },
]

describe('collectRangePaths', () => {
  it('锚点在目录行：闭区间内只收集文件行路径，按行序入集', () => {
    expect(collectRangePaths(rows, 0, 2)).toEqual(new Set(['nested/kappa.txt', 'alpha.txt']))
  })

  it('反向扩展（active < anchor）：min/max 归一同区间', () => {
    expect(collectRangePaths(rows, 3, 1)).toEqual(new Set(['nested/kappa.txt', 'alpha.txt', 'beta.txt']))
  })

  it('同行为区间：单文件集', () => {
    expect(collectRangePaths(rows, 4, 4)).toEqual(new Set(['gamma.txt']))
  })

  it('锚点缺省（-1）回落光标行：首次 Shift+↑↓ 从光标处起选', () => {
    expect(collectRangePaths(rows, -1, 3)).toEqual(new Set(['beta.txt']))
  })

  it('区间越界（行被收起/删减后）：越界下标安全跳过不抛错', () => {
    expect(collectRangePaths(rows, 3, 99)).toEqual(new Set(['beta.txt', 'gamma.txt']))
  })
})

describe('collectAllFilePaths', () => {
  it('全选可见文件行：目录行不参与', () => {
    expect(collectAllFilePaths(rows)).toEqual(
      new Set(['nested/kappa.txt', 'alpha.txt', 'beta.txt', 'gamma.txt']),
    )
  })

  it('空列表得空集', () => {
    expect(collectAllFilePaths([])).toEqual(new Set())
  })
})
