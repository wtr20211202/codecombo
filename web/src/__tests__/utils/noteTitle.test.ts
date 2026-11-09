import { describe, it, expect } from 'vitest'
import { suggestNoteTitle } from '@/utils/noteTitle'

// 笔记标题建议（P-20261107-5「快捷键保存命名」）：未命名笔记 Ctrl+S 时以正文
// 首行预填命名框——纯函数分支表。
describe('suggestNoteTitle', () => {
  it('取首个非空行', () => {
    expect(suggestNoteTitle('\n\n  \n部署手册要点\n第二行')).toBe('部署手册要点')
  })

  it('剥 markdown 行首前缀（标题/引用/列表/任务列表/有序列表）', () => {
    expect(suggestNoteTitle('# 大标题')).toBe('大标题')
    expect(suggestNoteTitle('### 三级 标题')).toBe('三级 标题')
    expect(suggestNoteTitle('> 引用句')).toBe('引用句')
    expect(suggestNoteTitle('- 无序列表项')).toBe('无序列表项')
    expect(suggestNoteTitle('* 星号列表项')).toBe('星号列表项')
    expect(suggestNoteTitle('- [x] 已完成任务')).toBe('已完成任务')
    expect(suggestNoteTitle('1. 有序列表项')).toBe('有序列表项')
    expect(suggestNoteTitle('2) 另一种有序')).toBe('另一种有序')
  })

  it('剥行内强调标记与空白折叠', () => {
    expect(suggestNoteTitle('**加粗** 标题')).toBe('加粗 标题')
    expect(suggestNoteTitle('多   个   空白')).toBe('多 个 空白')
  })

  it('整行是标记/空白 → 空串（回退「无标题笔记」占位）', () => {
    expect(suggestNoteTitle('')).toBe('')
    expect(suggestNoteTitle('###\n\n   \n')).toBe('')
    expect(suggestNoteTitle('#\n> \n- \n')).toBe('')
  })

  it('按码点截断 ≤50（增补平面 emoji 不截出半边）', () => {
    const long = '一'.repeat(60)
    expect(Array.from(suggestNoteTitle(long))).toHaveLength(50)
    // 50 个 emoji（每码点 4 字节）= 200 字节，恰在服务端 200 字节上限内
    const emojis = '🦄'.repeat(60)
    const got = suggestNoteTitle(emojis)
    expect(Array.from(got)).toHaveLength(50)
    expect(Buffer.byteLength(got, 'utf8')).toBeLessThanOrEqual(200)
  })

  it('换行族全兼容（CRLF/CR/LF）', () => {
    expect(suggestNoteTitle('首行\r\n第二行')).toBe('首行')
    expect(suggestNoteTitle('首行\r第二行')).toBe('首行')
  })
})
