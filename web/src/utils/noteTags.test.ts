import { describe, expect, it } from 'vitest'
import { collectNoteTags, NOTE_TAGS_MAX, normalizeNoteTags } from './noteTags'

/**
 * 笔记标签纯函数单测（P-20261112-7 S2）：归一化语义与 S1 服务端
 * normalizeNoteTags 对齐（trim/空串丢弃/去重保序/超 32 rune 丢弃/超 8 截断），
 * 双侧单测各自钉住同语义。
 */
describe('normalizeNoteTags', () => {
  it('trim 每项、空串丢弃、去重保序（首现位置）', () => {
    expect(normalizeNoteTags([' a ', 'a', '', '  ', 'b', 'a'])).toEqual(['a', 'b'])
  })

  it('非数组/非字符串项防御：返回空/跳过该项（服务端 decode 容错同哲学）', () => {
    expect(normalizeNoteTags(undefined)).toEqual([])
    expect(normalizeNoteTags('tags')).toEqual([])
    expect(normalizeNoteTags([1, 'a', null, 'b'])).toEqual(['a', 'b'])
  })

  it(`超 ${NOTE_TAGS_MAX} 个截断保前 ${NOTE_TAGS_MAX}（服务端 NotesMaxTags 同值）`, () => {
    const tags = Array.from({ length: 12 }, (_, i) => `t${i + 1}`)
    expect(normalizeNoteTags(tags)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'])
  })

  it('单个标签超 32 rune 丢弃（rune=码点非 UTF-16 码元——emoji 代理对按 1 计）', () => {
    // 32 个 emoji = 32 码点：放行（JS string.length=64 的码元口径会误杀）
    expect(normalizeNoteTags(['😀'.repeat(32)])).toEqual(['😀'.repeat(32)])
    // 33 个 emoji = 33 码点：丢弃
    expect(normalizeNoteTags(['😀'.repeat(33)])).toEqual([])
  })

  it('恰好 32 rune 的中英混排放行、33 丢弃（S1 服务端边界同款）', () => {
    expect(normalizeNoteTags(['项目'.repeat(16)])).toEqual(['项目'.repeat(16)])
    expect(normalizeNoteTags(['a'.repeat(32)])).toEqual(['a'.repeat(32)])
    expect(normalizeNoteTags(['a'.repeat(33)])).toEqual([])
  })

  it('空结果归空数组（服务端 omitempty 省字段同形的读面统一形态）', () => {
    expect(normalizeNoteTags(['', '   '])).toEqual([])
  })
})

describe('collectNoteTags', () => {
  it('全库标签去重保序（清单序遍历——热门笔记标签先出现）', () => {
    expect(collectNoteTags([
      { tags: ['交接', 'demo'] },
      { tags: undefined },
      { tags: ['交接', 'proj-b'] },
      {},
    ])).toEqual(['交接', 'demo', 'proj-b'])
  })

  it('空清单/全无标签 → 空数组', () => {
    expect(collectNoteTags([])).toEqual([])
    expect(collectNoteTags([{}, { tags: [] }])).toEqual([])
  })
})
