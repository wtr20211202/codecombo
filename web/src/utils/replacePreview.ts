/**
 * 批量替换预览共享层（P-20261003-71）：预览弹层的 after 行文本与确认后的执行
 * 必须出自同一替换函数——「预览看着对、执行写坏片」的漂移事故以抽共用杜绝，
 * regex 构造（字面量转义 / 整词 \b / 大小写开关）同样单点供给，一致性天然。
 *
 * 已知边界（行级预览的固有属性，与 VS Code 同限）：搜索按行命中（git grep / rg
 * 均行粒度），预览逐行生成 after；若 regex 形态能跨行命中文件内容（如含 \s、\n
 * 的病态模式），执行链全文替换会改到搜索结果未报告的行——预览不会显示这部分。
 * 同行内的贪婪/多次命中则两侧逐字节一致（同一函数、同一输入粒度）。
 */

/** 与搜索选项同语义的替换正则：字面量转义 / 整词 \b / 大小写敏感开关 g 标志。
 *  正则模式沿用查询原文（搜索端 git grep -E 的常用 ERE 语法与 JS regex 兼容）。
 *  预览与执行共用此构造——各自手写必然漂移。 */
export function buildReplaceRegex(query: string, opts: {
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
}): RegExp | null {
  const flags = opts.caseSensitive ? 'g' : 'gi'
  try {
    if (opts.useRegex) return new RegExp(query, flags)
    let src = query.replace(/[.*+?^${}()|\]\\]/g, '\\$&')
    if (opts.wholeWord) src = `\\b${src}\\b`
    return new RegExp(src, flags)
  } catch {
    return null
  }
}

/** 唯一替换出口：执行链写盘与预览生成 after 均调此处。函数形态替换字面量，
 *  规避 `$&` 等特殊序列被二次解释。preserveCase（P-20261006-16）时逐命中
 *  走 applyPreservedCase 形态跟随——与服务端 replaceWithShape 同语义双实现。 */
export function replaceMatches(content: string, re: RegExp, replacement: string, preserveCase = false): string {
  if (!preserveCase) return content.replace(re, () => replacement)
  return content.replace(re, matched => applyPreservedCase(replacement, matched))
}

/** 形态跟随推断（P-20261006-16 保留大小写）：按命中词自身形态变换 replacement——
 *  全小写（含空串/无大小写字符）→ 原样、全大写 → 大写化、首字母大写且其余全小写
 *  （Title 形态）→ replacement 首字母大写化；混合形态不猜——原样输出（提案克制
 *  边界：下划线/驼峰互转不做，三形态覆盖绝大多数重命名场景）。与 CaseSensitive
 *  正交：那管匹配、这管输出。与服务端 applyPreservedCase
 *  （server/api/files/replace.go）同语义双实现，改动须两处同步。 */
export function applyPreservedCase(replacement: string, matched: string): string {
  if (matched === matched.toLowerCase()) return replacement
  if (matched === matched.toUpperCase()) return replacement.toUpperCase()
  const head = matched.charAt(0)
  const rest = matched.slice(1)
  if (head !== head.toLowerCase() && rest === rest.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  }
  return replacement
}

/** 命中探测（执行链跳过无命中文件的守卫），test() 后复位 lastIndex 防串味 */
export function contentHasMatch(content: string, re: RegExp): boolean {
  re.lastIndex = 0
  const hit = re.test(content)
  re.lastIndex = 0
  return hit
}

/** 行内片段：命中段（预览红划/绿标）与上下文段（原样） */
export interface ReplaceSegment {
  text: string
  isMatch: boolean
}

/** 单行 before→after 对照 */
export interface LinePreview {
  /** 1-based 行号（与搜索结果行号同口径） */
  line: number
  before: string
  after: string
  beforeSegments: ReplaceSegment[]
  afterSegments: ReplaceSegment[]
}

/** 单文件预览：行级对照行 + 命中处数（处数口径与搜索计数一致，行数可小于处数） */
export interface FilePreview {
  path: string
  rows: LinePreview[]
  hitCount: number
}

/**
 * 用正则走一遍行内容产出片段。replacement 传入时命中段携带替换文本
 * （after 侧片段，preserveCase 时与 replaceMatches 同式形态跟随——两侧文本
 * 天然一致，重组校验才守得住）；返回片段 join 即该粒度的全文替换结果。
 */
function walkSegments(line: string, re: RegExp, replacement: string | null, preserveCase = false): ReplaceSegment[] {
  const segs: ReplaceSegment[] = []
  const global = re.global
  re.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  // String.replace 语义镜像：global 全量替换 / 非 global 仅首处
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index), isMatch: false })
    const text = replacement === null
      ? m[0]
      : (preserveCase ? applyPreservedCase(replacement, m[0]) : replacement)
    segs.push({ text, isMatch: true })
    last = m.index + m[0].length
    if (!global) break
    if (m[0].length === 0) re.lastIndex++ // 零宽命中（如 a*）防死循环：位置前移，占位字符留给上下文段
  }
  if (last < line.length) segs.push({ text: line.slice(last), isMatch: false })
  re.lastIndex = 0
  return segs
}

/**
 * 单行预览：after 文本出自 replaceMatches（权威），高亮片段由 walk 构造并
 * 校验可重组为同一文本——病态正则重组失败时降级为无高亮整行（文本仍正确）。
 * 该行无命中返回 null（调用方跳过）。
 */
export function buildLinePreview(
  line: number,
  content: string,
  re: RegExp,
  replacement: string,
  preserveCase = false,
): LinePreview | null {
  const beforeSegments = walkSegments(content, re, null)
  if (!beforeSegments.some(s => s.isMatch)) return null
  const after = replaceMatches(content, re, replacement, preserveCase)
  const afterSegments = walkSegments(content, re, replacement, preserveCase)
  const reassembled = afterSegments.map(s => s.text).join('')
  const safeSegments = reassembled === after
    ? afterSegments
    : [{ text: after, isMatch: false }]
  return { line, before: content, after, beforeSegments, afterSegments: safeSegments }
}

/**
 * 单文件预览：命中行逐行生成对照；同行多处命中只出一行（after 已含该行全部
 * 替换），hitCount 保持处数口径。matches 须属于同一文件（搜索结果已按路径分组）。
 */
export function buildFilePreview(
  path: string,
  matches: Array<{ line: number; content: string }>,
  re: RegExp,
  replacement: string,
  preserveCase = false,
): FilePreview {
  const byLine = new Map<number, LinePreview>()
  let hitCount = 0
  for (const m of matches) {
    hitCount++
    if (byLine.has(m.line)) continue
    const row = buildLinePreview(m.line, m.content, re, replacement, preserveCase)
    if (row) byLine.set(m.line, row)
  }
  return { path, rows: Array.from(byLine.values()).sort((a, b) => a.line - b.line), hitCount }
}
