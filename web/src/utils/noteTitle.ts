/**
 * 笔记标题建议（P-20261107-5「快捷键保存命名」）：未命名笔记 Ctrl+S 保存时
 * 以正文首行预填命名框——纯函数，无副作用。
 *
 * 规则：取首个非空行 → 剥 markdown 行首前缀（井号标题/引用/列表/强调标记）→
 * 空白折叠 → 按码点截断 ≤50（标题服务端上限 200 UTF-8 字节；50 码点 × 最宽
 * 4 字节恰好 ≤200，emoji 等增补平面字符不会被截出非法半边）。剥不出可读文本
 * （整行是标记/空白）返回空串，调用方回退「无标题笔记」占位。
 */

// 剥前缀标记：标题井号、引用、无序/有序列表、强调星号/下划线（行首形态）
const MARKDOWN_PREFIX_RE = /^(?:#{1,6}(?:\s+|$)|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|[*_]{1,3})+/

export function suggestNoteTitle(content: string, maxCodePoints = 50): string {
  for (const raw of content.split(/\r\n|\n|\r/)) {
    const line = raw.replace(MARKDOWN_PREFIX_RE, '').replace(/[*_`]{1,3}/g, '').trim()
    if (!line) continue
    const collapsed = line.replace(/\s+/g, ' ')
    const pts = Array.from(collapsed)
    return pts.length > maxCodePoints ? pts.slice(0, maxCodePoints).join('') : collapsed
  }
  return ''
}
