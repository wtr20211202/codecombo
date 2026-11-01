/**
 * md heading → 页内锚点 id 的 slug 纯函数（P-20261007-7）。
 *
 * 生成与查找单源：渲染侧（useEditorMdPreview 的 heading renderer hook）用本
 * 函数把标题纯文本折叠为 id 挂到 <h1..h6>；点击侧（views/editor/mdAnchorNav）
 * 只需按 href fragment 对 DOM 里已挂的 id 做精确匹配、不重算 slug——两侧行为
 * 一致由「id 全部出自本函数」保证，规则漂移无处发生。
 *
 * 折叠规则（GitHub 风格，以本实现为准）：trim → 小写 → 剔除非「字母 / 数字 /
 * 空白 / 连字符 / 下划线」字符（Unicode 字母集 \p{L}，中文保留）→ 空白逐个转
 * 连字符。产物只含字母/数字/连字符/下划线/CJK——无 HTML 特殊字符，可安全直插
 * id 属性，也可经 CSS.escape 进选择器。重名去重由 createMdHeadingSlugger 的
 * per-parse 计数器承担（首个原名，后续 -1 -2 递增，github-slugger 同款）。
 */

/** 折叠标题纯文本为 slug；空串 / 纯标点标题折叠为空串（调用方据此不挂 id） */
export function mdHeadingSlug(text: string): string {
  return (text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

export interface MdHeadingSlugger {
  /** 取下一个 slug：同 base 重名时按出现序缀 -1 / -2 递增 */
  (text: string): string
  /** 复位去重计数（每个 parse 开始时调用，挂在 marked preprocess 钩子上） */
  reset(): void
}

/** 造一枚带 per-parse 去重计数的 slugger（marked.parse 同步执行，无重入交错） */
export function createMdHeadingSlugger(): MdHeadingSlugger {
  const seen = new Map<string, number>()
  const slug = ((text: string): string => {
    const base = mdHeadingSlug(text)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}-${n}`
  }) as MdHeadingSlugger
  slug.reset = () => {
    seen.clear()
  }
  return slug
}
