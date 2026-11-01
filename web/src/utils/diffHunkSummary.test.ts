import { describe, expect, it } from 'vitest'
import { buildDiffHunkSummary, findChangeAtLine } from './diffHunkSummary'
import type { DiffLineChange } from './diffHunkSummary'

/** 夹具一：单行修改（original/mod 第 2 行），两侧各 4 行内容 */
const MODIFY: DiffLineChange[] = [
  { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
]
const LINES: Record<'original' | 'modified', string[]> = {
  original: ['l1', 'l2', 'l3', 'l4'],
  modified: ['L1', 'L2', 'L3', 'L4', 'new5'],
}
function getLine(m: 'original' | 'modified', n: number): string {
  return LINES[m][n - 1] ?? ''
}

describe('findChangeAtLine 行→变更块定位（P-20261003-208）', () => {
  // 夹具二：修改块（modified 2-3）+ 纯插入块（modified 6-7，original 零行侧
  // end = start - 1，对齐 Monaco getLineChanges 语义）
  const changes: DiffLineChange[] = [
    { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 3 },
    { originalStartLineNumber: 4, originalEndLineNumber: 3, modifiedStartLineNumber: 6, modifiedEndLineNumber: 7 },
  ]

  it('点击变更块内行：含所属命中', () => {
    expect(findChangeAtLine(changes, 3, 'modified')).toBe(changes[0])
    expect(findChangeAtLine(changes, 7, 'modified')).toBe(changes[1])
    expect(findChangeAtLine(changes, 2, 'original')).toBe(changes[0])
  })

  it('点击块间上下文行：取最近块（距离最小）', () => {
    // modified 第 4 行：距块 1（止于 3）为 1，距块 2（起于 6）为 2 → 块 1
    expect(findChangeAtLine(changes, 4, 'modified')).toBe(changes[0])
    // modified 第 5 行：距块 1 为 2，距块 2 为 1 → 块 2
    expect(findChangeAtLine(changes, 5, 'modified')).toBe(changes[1])
  })

  it('纯插入块零行侧：original 侧不反向命中所属（end=start-1），距离按 start 计', () => {
    // original 第 4 行：块 2 零行侧 start=4 距离 0，块 1（第 2 行）距离 2 → 块 2
    expect(findChangeAtLine(changes, 4, 'original')).toBe(changes[1])
  })

  it('无变更块（两侧全同）：null', () => {
    expect(findChangeAtLine([], 1, 'modified')).toBeNull()
  })
})

describe('buildDiffHunkSummary 行→hunk 摘要构造（P-20261003-208）', () => {
  it('修改块：hunk 头（@@ -o,count +m,count @@）+ 两侧样本行（-/+ 前缀）', () => {
    expect(buildDiffHunkSummary(MODIFY, 2, 'modified', getLine)).toBe('@@ -2,1 +2,1 @@\n- l2\n+ L2')
  })

  it('纯插入块：零行侧计 0（对齐 git hunk 头语义）、无 original 样本行', () => {
    // original 零行侧（end = start - 1）不产样本行；modified 越界行（内容
    // 未知侧）回落空串仍带 + 前缀——真实调用方传入 model 真实行文本
    const changes: DiffLineChange[] = [
      { originalStartLineNumber: 5, originalEndLineNumber: 4, modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 },
    ]
    const rows = buildDiffHunkSummary(changes, 5, 'modified', getLine).split('\n')
    expect(rows[0]).toBe('@@ -5,0 +5,2 @@')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toBe('+ new5')
    expect(rows[2]).toBe('+ ')
  })

  it('上下文行取最近块（与 findChangeAtLine 同一归属）', () => {
    expect(buildDiffHunkSummary(MODIFY, 1, 'original', getLine)).toBe('@@ -2,1 +2,1 @@\n- l2\n+ L2')
  })

  it('超长块每侧采样 3 行封顶（摘要长度有界，字节裁剪交装箱层）', () => {
    const changes: DiffLineChange[] = [
      { originalStartLineNumber: 1, originalEndLineNumber: 10, modifiedStartLineNumber: 1, modifiedEndLineNumber: 10 },
    ]
    const big: Record<'original' | 'modified', string[]> = {
      original: Array.from({ length: 10 }, (_, i) => `o${i + 1}`),
      modified: Array.from({ length: 10 }, (_, i) => `m${i + 1}`),
    }
    const rows = buildDiffHunkSummary(changes, 1, 'original', (m, n) => big[m][n - 1] ?? '').split('\n')
    expect(rows[0]).toBe('@@ -1,10 +1,10 @@')
    expect(rows).toHaveLength(7) // 头 + 3 + 3
    expect(rows[1]).toBe('- o1')
    expect(rows[3]).toBe('- o3')
    expect(rows[4]).toBe('+ m1')
  })

  it('无变更块：空串（调用方退化纯定位头）', () => {
    expect(buildDiffHunkSummary([], 1, 'modified', getLine)).toBe('')
  })
})
