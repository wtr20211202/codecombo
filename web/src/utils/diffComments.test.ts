import { describe, expect, it } from 'vitest'
import {
  normalizeDiffComments,
  capDiffComments,
  reconcileCommentDrift,
  newDiffCommentId,
  DIFF_COMMENTS_MAX_PER_PROJECT,
  type DiffComment,
} from './diffComments'

/** 造条目：lineText 缺省由 lines 表按行取（与 getLine 注入同源，测和解时行文
 *  恒一致），显式传可构造失配锚 */
function c(line: number, overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: overrides.id || `id-${line}`,
    line,
    text: overrides.text || '这里要改',
    lineText: overrides.lineText !== undefined ? overrides.lineText : `line ${line}`,
    createdAt: overrides.createdAt || line,
    resolved: overrides.resolved || false,
  }
}

/** 行号 → `line <n>` 文本（前后带空格可辨 trim 口径）；越界返回空串 */
function makeLines(lines: string[]): (n: number) => string {
  return (n: number) => lines[n - 1] ?? ''
}

describe('normalizeDiffComments 形状防御', () => {
  it('合法条目收紧字段；脏条目逐个剔除，按行升序稳定排序', () => {
    const out = normalizeDiffComments([
      { id: 'b', line: 9, text: 'x', lineText: 'l9', createdAt: 2, resolved: true },
      null,
      { id: '', line: 3, text: 'x', createdAt: 1 },
      { id: 'a', line: 0, text: 'x', createdAt: 1 },
      { id: 'c', line: 3.5, text: 'x', createdAt: 1 },
      { id: 'd', line: 3, text: 42, createdAt: 1 },
      { id: 'e', line: 3, text: 'x', lineText: 7, createdAt: 1 },
      { id: 'f', line: 3, text: 'x', createdAt: -1 },
      { id: 'g', line: 2, text: 'y', createdAt: 9 },
      { id: 'h', line: 9, text: 'z', lineText: 'l9', createdAt: 1 },
    ])
    expect(out).toEqual([
      { id: 'g', line: 2, text: 'y', lineText: '', createdAt: 9, resolved: false },
      { id: 'h', line: 9, text: 'z', lineText: 'l9', createdAt: 1, resolved: false },
      { id: 'b', line: 9, text: 'x', lineText: 'l9', createdAt: 2, resolved: true },
    ])
    // 同行按 createdAt 升序稳定序
    expect(out.map((x) => x.id)).toEqual(['g', 'h', 'b'])
  })

  it('非数组/空值回落空表；lineText 缺省补空串', () => {
    expect(normalizeDiffComments(undefined)).toEqual([])
    expect(normalizeDiffComments('x')).toEqual([])
    expect(normalizeDiffComments([{ id: 'k', line: 4, text: 't', createdAt: 5 }])).toEqual([
      { id: 'k', line: 4, text: 't', lineText: '', createdAt: 5, resolved: false },
    ])
  })
})

describe('capDiffComments 最旧先淘汰', () => {
  it('未超限原样返回；超出按 createdAt 保最新', () => {
    const three = [c(1, { createdAt: 3 }), c(2, { createdAt: 1 }), c(3, { createdAt: 2 })]
    expect(capDiffComments(three, 5)).toBe(three)
    expect(capDiffComments(three, 2).map((x) => x.createdAt)).toEqual([3, 2])
    expect(capDiffComments([], DIFF_COMMENTS_MAX_PER_PROJECT)).toEqual([])
  })
})

describe('reconcileCommentDrift 行锚点漂移和解', () => {
  it('锚内容在场：原地不动且 changed=false', () => {
    const list = [c(2), c(5)]
    const r = reconcileCommentDrift(list, 10, makeLines(['', 'line 2', '', '', 'line 5', 'l6', 'l7', 'l8', 'l9', 'l10']))
    expect(r.changed).toBe(false)
    expect(r.comments).toEqual(list)
  })

  it('整行下移（上方插入）：窗口内按内容找回并 retarget', () => {
    // 原 line 3 的 "line 3" 被上方两行插入推到 line 5
    const lines = makeLines(['n1', 'n2', '', '', 'line 3', 'line 4'])
    const r = reconcileCommentDrift([c(3)], 6, lines)
    expect(r.changed).toBe(true)
    expect(r.comments[0]!.line).toBe(5)
  })

  it('整行上移（上方删除）：同窗口逻辑找回', () => {
    const lines = makeLines(['line 5', 'l2', 'l3'])
    const r = reconcileCommentDrift([c(5)], 3, lines)
    expect(r.changed).toBe(true)
    expect(r.comments[0]!.line).toBe(1)
  })

  it('同距上下都命中时先上方（确定性）', () => {
    const lines = makeLines(['line 4', 'l2', 'line 4', 'l4'])
    const r = reconcileCommentDrift([c(2, { lineText: 'line 4' })], 4, lines)
    expect(r.comments[0]!.line).toBe(1)
  })

  it('窗口内找不回：留在原行号（越界则收敛）不丢弃', () => {
    const lines = makeLines(['x', 'y', 'z'])
    const r = reconcileCommentDrift([c(8, { lineText: 'gone' })], 3, lines, 2)
    expect(r.changed).toBe(true) // 行号收敛 8→3
    expect(r.comments[0]!.line).toBe(3)
    expect(r.comments[0]!.lineText).toBe('gone')
  })

  it('行号越界 clamp 后内容恰一致：不再搜索，只记 clamp 变化', () => {
    const lines = makeLines(['a', 'line 5'])
    const r = reconcileCommentDrift([c(5)], 2, lines)
    expect(r.changed).toBe(true)
    expect(r.comments[0]!.line).toBe(2)
  })

  it('lineText 为空（早期无锚数据）：只 clamp 不搜索', () => {
    const lines = makeLines(['l1', 'l2', 'l3'])
    const r = reconcileCommentDrift([c(2, { lineText: '' })], 3, lines, 5)
    expect(r.changed).toBe(false)
    expect(r.comments[0]!.line).toBe(2)
  })

  it('空文件：收敛到行 1 且不抛错', () => {
    const r = reconcileCommentDrift([c(4, { lineText: 'gone' })], 0, () => '')
    expect(r.comments[0]!.line).toBe(1)
    expect(r.changed).toBe(true)
  })
})

describe('newDiffCommentId', () => {
  it('同毫秒并发不撞号；时间前缀可读', () => {
    const a = newDiffCommentId(1700000000000)
    const b = newDiffCommentId(1700000000000)
    expect(a).not.toBe(b)
    expect(a.startsWith((1700000000000).toString(36) + '-')).toBe(true)
  })
})
