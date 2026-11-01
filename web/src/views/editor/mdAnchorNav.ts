/**
 * md 预览页内锚点跳转的 DOM 动作层（P-20261007-7 二阶段）：在预览内容根里按
 * fragment 找目标并滚动 + 呼吸高亮，坏锚点不炸只 title 提示（诚实边界）。
 *
 * 查找口径：只做「fragment === 元素 id」精确匹配、不重算 slug——预览 DOM 里的
 * heading id 全部由 utils/mdAnchorSlug 单一规则生成（useEditorMdPreview 的
 * heading renderer hook 挂载），两侧行为一致靠同源保证；显式 HTML 锚点
 * （<a id="custom">）同样按 id 命中。找不到（手写锚点与 slug 规则不符，或 id
 * 被 DOMPurify SANITIZE_DOM 剥除——与 document 属性撞名的 id 如 title/body）
 * 就近回退：不炸不跳，title 悬浮提示锚点未命中。
 */

const HIT_CLASS = 'md-anchor-hit'
/** 高亮兜底摘类时点（CSS 动画 0.8s ease-in-out × 2 轮 ≈ 1.6s，末态=初态无跳变） */
const HIT_MS = 1700
/** 目标标题与容器上缘的呼吸空隙（block:start 贴顶易顶死边框） */
const TOP_BREATHING_ROOM = 8

/** 滚动容器：预览面板的 DOM 契约（.md-preview 滚动 > .md-preview-content 内容），
 * 见 EditorMdPreviewPane.vue；closest 不到（测试桩等）以内容根自滚兜底 */
function findScroller(contentRoot: Element): HTMLElement {
  return (contentRoot.closest('.md-preview') as HTMLElement | null) ?? (contentRoot as HTMLElement)
}

function byId(contentRoot: Element, id: string): HTMLElement | null {
  // 逐元素精确匹配而非 #id 选择器：免 CSS.escape 依赖（jsdom 测试环境无 CSS
  // 全局），也无选择器注入面；预览内容是单文档量级（几百节点内），点击期
  // 一次线性扫描可忽略
  const all = contentRoot.querySelectorAll<HTMLElement>('[id]')
  for (const el of all) {
    if (el.id === id) return el
  }
  return null
}

// ── 呼吸高亮：时间线 is-focus 同款惯例（类挂/摘与兜底定时器在 JS 侧）。
// 模块级单枚举：跨编辑器组连点时先摘上一枚，防高亮叠加；v-html 重渲染整体
// 换 DOM 后残留引用摘类是无害空操作，1.7s 内释放 ──
let lastHit: { el: HTMLElement; timer: number | undefined } | null = null

function clearMdAnchorHighlight(): void {
  if (!lastHit) return
  lastHit.el.classList.remove(HIT_CLASS)
  if (lastHit.timer !== undefined) window.clearTimeout(lastHit.timer)
  lastHit = null
}

function breatheHighlight(el: HTMLElement): void {
  clearMdAnchorHighlight()
  el.classList.add(HIT_CLASS)
  lastHit = { el, timer: window.setTimeout(clearMdAnchorHighlight, HIT_MS) }
}

/** 只滚预览容器自身：scrollIntoView 会连带滚动一切可滚祖先（SPA 布局跟着被
 * 拽动），容器内位差换算把滚动约束在预览面板内 */
function scrollToInScroller(scroller: HTMLElement, target: HTMLElement): void {
  const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  scroller.scrollTo({
    top: Math.max(0, scroller.scrollTop + delta - TOP_BREATHING_ROOM),
    behavior: 'smooth',
  })
}

/**
 * 跳转到页内锚点。命中：平滑滚动 + 呼吸高亮，返回 true；#top 特例（浏览器
 * 原生片段语义同款——有 id="top" 元素优先元素，否则回滚容器顶）；未命中：
 * anchorEl.title 提示（下次 hover 可见；150ms 防抖重渲染整体换 DOM 提示自然
 * 消散），返回 false。
 */
export function jumpToMdAnchor(
  contentRoot: Element,
  frag: string,
  anchorEl: HTMLElement | null,
  missTitle: string,
): boolean {
  const scroller = findScroller(contentRoot)
  const hit = byId(contentRoot, frag)
  if (!hit) {
    if (frag === 'top') {
      // #top 特例：无同名元素时回滚容器顶（[返回顶部](#top) 常见形态）
      scroller.scrollTo({ top: 0, behavior: 'smooth' })
      return true
    }
    if (anchorEl) anchorEl.title = missTitle
    return false
  }
  scrollToInScroller(scroller, hit)
  breatheHighlight(hit)
  return true
}
