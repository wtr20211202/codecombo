// theme-contrast-lib.mjs —— 主题对比度校验的纯函数层（P-20261019-4）
//
// 从 check-theme-contrast.mjs 抽出的可单测核心：颜色解析 / WCAG 相对亮度 /
// 字号绑定门槛 / 主题色对求值。CLI 脚本只负责读文件、套基线、输出与退出码；
// 单测（src/__tests__/theme-contrast.test.ts）直接 import 本文件构造 fixture。
//
// 门槛口径（WCAG 2.1）：阈值由「实际渲染字号/字重/是否非文本图形」决定，
// 不再按语义角色（secondary/muted 一律 3:1）拍脑袋：
//   - 常规文本（<24px，或粗体 <18.66px）→ 4.5:1（1.4.3 AA）
//   - 大字号（≥24px 常规 / ≥18.66px 粗体）→ 3:1（1.4.3 AA 大字例外）
//   - 非文本指示图形（状态点/图标）→ 3:1（1.4.11）
// 辅助文字（secondary/muted/dim/label）在组件面实际是 10~13px 元信息
// （commit 元信息、worktree 路径、远程 URL、占位符等），因此按 4.5:1 守，
// 不能套大字例外。

export const WCAG_NORMAL_TEXT = 4.5
export const WCAG_LARGE_TEXT = 3
export const WCAG_NON_TEXT = 3

/** WCAG 大字门槛：≥24px 常规，或 ≥18.66px（14pt）粗体 */
export const LARGE_TEXT_PX = 24
export const LARGE_BOLD_TEXT_PX = 18.66

/**
 * 颜色解析：值 → { r, g, b, a }（0~1 sRGB，未做线性化）。
 * resolveVar 可为 Map（token 名 → 原始值）或函数（name → 原始值），用于穿透
 * `var(--status-*)` 这类主题内间接引用；无法静态计算时返回 null。
 */
export function parseColor(raw, resolveVar, depth = 0) {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (v.startsWith('var(') && depth < 2) {
    const ref = v.slice(4, -1).trim().replace(/^--/, '')
    const next = typeof resolveVar === 'function' ? resolveVar(ref) : resolveVar?.get(ref)
    return next === undefined ? null : parseColor(next, resolveVar, depth + 1)
  }
  let m = v.match(/^#([0-9a-f]{3,8})$/i)
  if (m) {
    let h = m[1]
    if (h.length === 3) h = [...h].map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 }
  }
  m = v.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/i)
  if (m) {
    const ch = (x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x) / 255)
    const al = (x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x))
    return { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]), a: m[4] === undefined ? 1 : al(m[4]) }
  }
  return null // linear-gradient / transparent / 具名色等：非纯色，不可静态计算
}

/** alpha 混合：fg 以 a 叠到不透明 bg 上 */
export function compositeOver(fg, bg) {
  if (fg.a >= 1) return fg
  return {
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
    a: 1,
  }
}

/** WCAG 2.x 相对亮度 */
export function relativeLuminance({ r, g, b }) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 对比度（fg 允许带 alpha，先叠到 bg 上） */
export function contrastRatio(fg, bg) {
  const [l1, l2] = [relativeLuminance(compositeOver(fg, bg)), relativeLuminance(bg)]
    .sort((a, b) => b - a)
  return (l1 + 0.05) / (l2 + 0.05)
}

/** 是否满足 WCAG 大字例外（阈值 3:1 的前提） */
export function isLargeText({ sizePx, bold = false }) {
  return sizePx >= LARGE_TEXT_PX || (bold && sizePx >= LARGE_BOLD_TEXT_PX)
}

/**
 * 由实际用法推导最低对比度：文本按字号/字重，非文本图形固定 3:1。
 * usage: { kind: 'text', sizePx, bold? } | { kind: 'graphic' }
 */
export function requiredContrast(usage) {
  if (usage.kind === 'graphic') return WCAG_NON_TEXT
  return isLargeText(usage) ? WCAG_LARGE_TEXT : WCAG_NORMAL_TEXT
}

/** 报告用门槛说明（让失败项自带「为什么是 4.5 / 3」） */
export function thresholdLabel(usage) {
  if (usage.kind === 'graphic') return '3:1（非文本图形）'
  if (isLargeText(usage)) {
    return `3:1（大字号 ${usage.sizePx}px${usage.bold ? ' 粗体' : ''}）`
  }
  return `4.5:1（常规字号 ${usage.sizePx}px）`
}

// ---------- 色对表 ----------
// sizePx 取该 token 在组件面实际出现的最小字号（P-20261019-4 审计：辅助文字
// 10~13px、按钮/徽标 9~13px）；这些值决定「是否大字例外」，不是视觉猜测。
// 大字号/图形用法必须显式标注 kind，禁止再按 text-secondary/muted 语义角色
// 直接给 3:1——那正是 4.12:1 的 muted 被长期漏检的根因。
const SMALL_TEXT = Object.freeze({ kind: 'text', sizePx: 12, bold: false })
const SMALL_BOLD_TEXT = Object.freeze({ kind: 'text', sizePx: 10, bold: true })
const GRAPHIC = Object.freeze({ kind: 'graphic' })

export const PAIR_SPECS = [
  // 正文/链接：页面与面板正文，13~14px；链接承载正文语义
  { fg: 'text-primary', bg: 'bg-primary', usage: SMALL_TEXT },
  { fg: 'text-primary', bg: 'bg-panel', usage: SMALL_TEXT },
  { fg: 'text-primary', bg: 'bg-canvas', usage: SMALL_TEXT },
  { fg: 'text-primary', bg: 'bg-overlay', usage: SMALL_TEXT },
  { fg: 'text-body', bg: 'bg-primary', usage: SMALL_TEXT },
  { fg: 'text-body', bg: 'bg-panel', usage: SMALL_TEXT },
  { fg: 'text-hover', bg: 'bg-hover', usage: SMALL_TEXT },
  { fg: 'text-link', bg: 'bg-primary', usage: SMALL_TEXT },
  { fg: 'text-link', bg: 'bg-panel', usage: SMALL_TEXT },
  // 按钮/徽标上的反白字：9~13px（粗体也远小于 18.66px），按常规文本守 4.5。
  // 覆盖组件面真实用作底色的四类 accent：blue/green 主按钮、red 危险/通知徽标、
  // brand-accent 品牌徽标（AgentTerminalMini 等）
  { fg: 'text-on-accent', bg: 'accent-blue', usage: SMALL_BOLD_TEXT },
  { fg: 'text-on-accent', bg: 'accent-green', usage: SMALL_BOLD_TEXT },
  { fg: 'text-on-accent', bg: 'accent-red', usage: SMALL_BOLD_TEXT },
  { fg: 'text-on-accent', bg: 'brand-accent', usage: SMALL_BOLD_TEXT },
  // 等待档徽标（.aprv-badge 等）：暖底墨色 on-accent-warm 同守 4.5
  { fg: 'on-accent-warm', bg: 'accent-yellow-warm', usage: SMALL_BOLD_TEXT },
  // 辅助信息：commit 元信息/worktree 路径/远程 URL/占位符等 10~12px
  { fg: 'text-secondary', bg: 'bg-primary', usage: SMALL_TEXT },
  { fg: 'text-secondary', bg: 'bg-panel', usage: SMALL_TEXT },
  { fg: 'text-muted', bg: 'bg-primary', usage: SMALL_TEXT },
  { fg: 'text-muted', bg: 'bg-panel', usage: SMALL_TEXT },
  { fg: 'text-dim', bg: 'bg-primary', usage: SMALL_TEXT },
  { fg: 'text-label', bg: 'bg-primary', usage: SMALL_TEXT },
  { fg: 'text-label', bg: 'bg-panel', usage: SMALL_TEXT },
  // 状态徽标语义色四档（P-20261003-285）：徽标点/状态点是图形而非文本载体，
  // 按 1.4.11 非文本对比 3:1；值为 var() 间接引用，parseColor 可穿透到色相锚点
  { fg: 'status-running', bg: 'bg-panel', usage: GRAPHIC },
  { fg: 'status-running', bg: 'bg-primary', usage: GRAPHIC },
  { fg: 'status-success', bg: 'bg-panel', usage: GRAPHIC },
  { fg: 'status-success', bg: 'bg-primary', usage: GRAPHIC },
  { fg: 'status-failed', bg: 'bg-panel', usage: GRAPHIC },
  { fg: 'status-failed', bg: 'bg-primary', usage: GRAPHIC },
  { fg: 'status-waiting', bg: 'bg-panel', usage: GRAPHIC },
  { fg: 'status-waiting', bg: 'bg-primary', usage: GRAPHIC },
]

/**
 * 从主题源码截取 colors 块，逐行抽 `'key': 'value'`（行级正则，不做 AST）。
 * 返回 Map；调用方负责主题发现与文件读取。
 */
export function parseThemeColors(source) {
  const lines = source.split('\n')
  const map = new Map()
  let inColors = false
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (!inColors) {
      if (line === 'colors: {') inColors = true // 行首等值匹配，不会误中 monacoColors 等前缀键
      continue
    }
    if (line === '},' || line === '}') break
    if (!line || line.startsWith('//')) continue
    const m = line.match(/^'?([A-Za-z0-9-]+)'?\s*:\s*'(.*)'\s*,?\s*$/)
    if (m) map.set(m[1], m[2])
  }
  return map
}

/**
 * 求值单个主题的全部色对。返回行数组：
 *   { level: 'pass'|'fail'|'skip', theme, pair, min, ratio?, detail }
 * 基线套用留在 CLI（纯函数层不读盘）。
 */
export function evaluateTheme(theme, colors, specs = PAIR_SPECS) {
  const rows = []
  for (const { fg: fgKey, bg: bgKey, usage } of specs) {
    const pair = `${fgKey}/${bgKey}`
    const min = requiredContrast(usage)
    const fgRaw = colors.get(fgKey)
    const bgRaw = colors.get(bgKey)
    if (fgRaw === undefined || bgRaw === undefined) {
      rows.push({
        level: 'fail', theme, pair, min,
        detail: `token 缺失（${fgRaw === undefined ? fgKey : bgKey}）`,
      })
      continue
    }
    const fg = parseColor(fgRaw, colors)
    const bg = parseColor(bgRaw, colors)
    if (!fg || !bg || bg.a < 1) {
      const cause = !fg ? fgRaw : !bg ? bgRaw : `${bgRaw}（衬底含透明度）`
      rows.push({ level: 'skip', theme, pair, min, detail: `无法静态计算：${cause}` })
      continue
    }
    const ratio = contrastRatio(fg, bg)
    rows.push({
      level: ratio >= min ? 'pass' : 'fail',
      theme, pair, min, ratio, usage,
      detail: `实测 ${ratio.toFixed(2)} / 门槛 ${min}`,
    })
  }
  return rows
}
