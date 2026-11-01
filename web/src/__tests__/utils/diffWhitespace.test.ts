import { describe, it, expect } from 'vitest'
import { coalesceWhitespaceOnly, type DiffLine, type HunkGroup } from '@/utils/diffWhitespace'

/** 快捷构造行 */
function line(type: DiffLine['type'], content: string, oldLineNo?: number, newLineNo?: number): DiffLine {
  return { type, content, oldLineNo, newLineNo }
}

function hunk(lines: DiffLine[]): HunkGroup {
  return { oldStart: 1, oldCount: 0, newStart: 1, newCount: 0, lines }
}

function types(h: HunkGroup): string[] {
  return h.lines.map(l => l.type)
}

describe('coalesceWhitespaceOnly', () => {
  it('仅首尾空白差异的 del/add 对降级为 context（行号两侧各留）', () => {
    const out = coalesceWhitespaceOnly(hunk([
      line('del', 'alpha', 1),
      line('add', '    alpha', undefined, 1),
    ]))
    expect(types(out)).toEqual(['context'])
    expect(out.lines[0]).toMatchObject({ content: '    alpha', oldLineNo: 1, newLineNo: 1 })
  })

  it('实质内容差异的行对原样保留', () => {
    const out = coalesceWhitespaceOnly(hunk([
      line('del', 'alpha', 1),
      line('add', 'beta', undefined, 1),
    ]))
    expect(types(out)).toEqual(['del', 'add'])
  })

  it('段内逐对判定：混合段只合并 trim 等价的对', () => {
    const out = coalesceWhitespaceOnly(hunk([
      line('del', 'keep', 1),
      line('del', 'changed', 2),
      line('add', '  keep', undefined, 1),
      line('add', 'changed v2', undefined, 2),
    ]))
    expect(types(out)).toEqual(['context', 'del', 'add'])
  })

  it('del/add 段长不等时整段保留（错位比噪声更糟）', () => {
    const out = coalesceWhitespaceOnly(hunk([
      line('del', 'a', 1),
      line('del', 'b', 2),
      line('add', ' a', undefined, 1),
    ]))
    expect(types(out)).toEqual(['del', 'del', 'add'])
  })

  it('纯空白行与空行 trim 等价；CRLF 残留 \\r 参与等价', () => {
    const out = coalesceWhitespaceOnly(hunk([
      line('del', '  ', 1),
      line('add', '', undefined, 1),
      line('del', 'text\r', 2),
      line('add', 'text', undefined, 2),
    ]))
    expect(types(out)).toEqual(['context', 'context'])
  })

  it('hunk 头/header/context 行原样透传，hunk 对象其余字段不变', () => {
    const src = hunk([
      line('hunk', '@@ -1,3 +1,3 @@'),
      line('context', 'ctx', 1, 1),
      line('del', 'x', 2),
      line('add', '  x', undefined, 2),
    ])
    const out = coalesceWhitespaceOnly(src)
    expect(types(out)).toEqual(['hunk', 'context', 'context'])
    expect(out.oldStart).toBe(src.oldStart)
    expect(out.newCount).toBe(src.newCount)
  })
})
