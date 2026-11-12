import { describe, it, expect } from 'vitest'
import { computeAnchoredSelection, mergeNoteLists } from './notesExternalSync'
import type { MultiNoteMeta } from '../api/client'

/** 外部更新无扰换装纯函数（P-20261111-4-S2）：清单合并身份复用 + 光标锚定映射 */

function meta(id: string, overrides: Partial<MultiNoteMeta> = {}): MultiNoteMeta {
  return { id, title: `t-${id}`, updatedAt: '2026-11-11T10:00:00Z', size: 10, ...overrides }
}

describe('mergeNoteLists（侧栏清单 diff 守卫）', () => {
  it('未变更条目复用 prev 对象身份（keyed 行零 DOM 写入的依据）', () => {
    const a = meta('a')
    const b = meta('b')
    const merged = mergeNoteLists([a, b], [meta('a'), meta('b')])
    expect(merged[0]).toBe(a) // 同字段 → 引用不变
    expect(merged[1]).toBe(b)
  })

  it('变更条目（updatedAt/title/size）换新对象，新条目直通、消失条目落出，序随服务端', () => {
    const a = meta('a')
    const b = meta('b', { updatedAt: '2026-11-11T09:00:00Z' })
    const merged = mergeNoteLists(
      [a, b],
      [meta('b', { updatedAt: '2026-11-11T09:00:00Z' }), meta('a', { updatedAt: '2026-11-11T11:00:00Z' }), meta('c')],
    )
    expect(merged.map(n => n.id)).toEqual(['b', 'a', 'c']) // 服务端序权威
    expect(merged[0]).toBe(b) // b 未变更 → 身份复用
    expect(merged[1]?.updatedAt).toBe('2026-11-11T11:00:00Z') // a 变更 → 新对象
    expect(merged[1]).not.toBe(a)
    expect(merged[2]?.id).toBe('c') // 新条目
  })

  it('deletedAt/deletedBy 只比有无（软删标记面防御性对齐）', () => {
    const a = meta('a')
    expect(mergeNoteLists([a], [meta('a', { deletedBy: 'someone' })])[0]).not.toBe(a)
    expect(mergeNoteLists([a], [meta('a', { deletedBy: 'someone' })])[0]?.deletedBy).toBe('someone')
  })

  it('空边界：prev 空 = 全新直通；next 空 = 全部落出', () => {
    expect(mergeNoteLists([], [meta('a')])).toEqual([meta('a')])
    expect(mergeNoteLists([meta('a')], [])).toEqual([])
  })
})

describe('computeAnchoredSelection（换装光标锚定）', () => {
  it('尾部追加（agent 高频形态）：光标前文字未变 → 偏移原地不动', () => {
    // 光标在 "abc" 末尾，外部追加 "def"
    expect(computeAnchoredSelection('abc', 'abcdef', 3, 3)).toEqual({ selectionStart: 3, selectionEnd: 3 })
    // 光标在中段，追加只发生在其后
    expect(computeAnchoredSelection('abc', 'abcdef', 1, 2)).toEqual({ selectionStart: 1, selectionEnd: 2 })
  })

  it('文首插入（改写区整体在光标前方）：沿稳定后缀端平移，视觉位置不变', () => {
    // "abc" → "xxabc"，光标原在 1（'a' 上）→ 新值 3（仍是 'a' 上）
    expect(computeAnchoredSelection('abc', 'xxabc', 1, 1)).toEqual({ selectionStart: 3, selectionEnd: 3 })
    // 选区 [1,3) 整体平移到 [3,5)
    expect(computeAnchoredSelection('abc', 'xxabc', 1, 3)).toEqual({ selectionStart: 3, selectionEnd: 5 })
  })

  it('同长中段替换、改动字符恰在光标下：后缀稳定段端映射（同偏移原地成立）', () => {
    // "abcXdef" → "abcYdef"，光标在 4（X 上）：光标后 "def" 与光标前 "abc" 都
    // 稳定 → 沿后缀端映射，偏移不变（光标停在改动字符新位置上）
    expect(computeAnchoredSelection('abcXdef', 'abcYdef', 4, 4)).toEqual({ selectionStart: 4, selectionEnd: 4 })
  })

  it('中段不等长替换：后缀稳定段内的偏移沿端映射，改写区内夹取（任务书认可降级形态）', () => {
    // "abcXXdef" → "abcYdef"：lcp=3、lcs=3
    // 光标在 7（'f' 前，后缀段内：旧尾距 1 ≤ lcs）→ newLen - 1 = 6
    expect(computeAnchoredSelection('abcXXdef', 'abcYdef', 7, 7)).toEqual({ selectionStart: 6, selectionEnd: 6 })
    // 光标在 5（'d'，后缀段内：旧尾距 3 ≤ lcs）→ newLen - 3 = 4
    expect(computeAnchoredSelection('abcXXdef', 'abcYdef', 5, 5)).toEqual({ selectionStart: 4, selectionEnd: 4 })
    // 光标在 4（第一个 X，改写区内：旧尾距 4 > lcs）→ 退化 lcp=3
    expect(computeAnchoredSelection('abcXXdef', 'abcYdef', 4, 4)).toEqual({ selectionStart: 3, selectionEnd: 3 })
  })

  it('选区跨界（起在后缀段、终在被改写区）：独立映射后保序', () => {
    // "abcXXdef" → "abcYdef"，选区 [5, 8)：5 → 4、8 超界夹取 7
    expect(computeAnchoredSelection('abcXXdef', 'abcYdef', 5, 8)).toEqual({ selectionStart: 4, selectionEnd: 7 })
  })

  it('全量改写（无稳定段）：退化到 0（行首，好过整篇重读全丢）', () => {
    expect(computeAnchoredSelection('abc', 'xyz', 2, 2)).toEqual({ selectionStart: 0, selectionEnd: 0 })
  })

  it('空值边界：空 → 有值 / 有值 → 空 / 双空', () => {
    expect(computeAnchoredSelection('', 'abc', 0, 0)).toEqual({ selectionStart: 0, selectionEnd: 0 })
    expect(computeAnchoredSelection('abc', '', 1, 2)).toEqual({ selectionStart: 0, selectionEnd: 0 })
    expect(computeAnchoredSelection('', '', 0, 0)).toEqual({ selectionStart: 0, selectionEnd: 0 })
  })

  it('超界/负值偏移夹取进合法区间（外部数据不设防不成立）', () => {
    // 偏移超旧值长：先夹进旧值界再映射
    expect(computeAnchoredSelection('abc', 'abcdef', 99, 99)).toEqual({ selectionStart: 3, selectionEnd: 3 })
    expect(computeAnchoredSelection('abc', 'abcdef', -5, 2)).toEqual({ selectionStart: 0, selectionEnd: 2 })
    // 终 < 起：拉平
    expect(computeAnchoredSelection('abc', 'abcdef', 2, 1)).toEqual({ selectionStart: 2, selectionEnd: 2 })
    // 新值比旧值短：映射结果夹进新值界
    expect(computeAnchoredSelection('abcdef', 'ab', 6, 6)).toEqual({ selectionStart: 2, selectionEnd: 2 })
  })

  it('多字节字符（中文）按 UTF-16 码元偏移映射，与 textarea selectionStart 语义一致', () => {
    // '笔记内容' → '笔记内容（外部追加）'：lcp=4，光标 2（'记' 后）原地不动
    expect(computeAnchoredSelection('笔记内容', '笔记内容（外部追加）', 2, 4)).toEqual({ selectionStart: 2, selectionEnd: 4 })
    // '笔记内容' → '前缀。笔记内容'：光标 4（末尾）→ 7
    expect(computeAnchoredSelection('笔记内容', '前缀。笔记内容', 4, 4)).toEqual({ selectionStart: 7, selectionEnd: 7 })
  })
})
