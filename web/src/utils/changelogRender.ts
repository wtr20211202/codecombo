import { marked } from 'marked'
import DOMPurify from 'dompurify'
// heading id 渲染 hook（页内锚点的渲染侧）：显式 import 保证锚点契约不依赖
// 编辑器 chunk 的加载顺序
import './markedHeadingIds'

/**
 * 发布说明（GitHub Release body）渲染链单源（P-20261112-2-S1 自 useDshVersions
 * 抽出）：dsh 版本弹层与自更新面板「更新内容」同源消费，防两处净化策略漂移。
 *
 * 内容是**外部输入**（发布页正文，可含任意 html）——任何 v-html 渲染点必须
 * 经 renderChangelog，净化策略由 changelogRender.test.ts 钉住，放宽须同步改测试。
 */

/** changelog markdown → 消毒后的 HTML（GitHub release notes 含 html 标签，
 *  与 MonacoEditor 的 markdown 预览同一条 marked+DOMPurify 管线）。
 *  允许面只在 DOMPurify 默认之上加 a[target]（发布说明外链常带 target=_blank；
 *  现代浏览器对其隐式 noopener，无反向标签泄露面）。
 *  收紧两项 DOMPurify 默认放行、但对「外部正文进产品面板」不安全的标签
 *  （P-20261112-2-S1 抽公时由净化单测实锚）：style——v-html 注入的样式表全局
 *  生效，可改写/遮盖整个应用界面；form——无需脚本即可把面板内的点击提交到
 *  外部地址（仿冒「立即更新」）。GitHub 发布页自身渲染也剥这两者，正常说明不受影响 */
export function renderChangelog(body: string): string {
  const html = marked.parse(body || '', { async: false }) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form'] })
}

/** changelog 简要：渲染后取纯文本（markdown 标记自然剥净）压成单行，
 *  超 150 字截断——收起态摘要 */
export function changelogBrief(body: string): string {
  if (!body.trim()) return ''
  const div = document.createElement('div')
  div.innerHTML = renderChangelog(body)
  const text = (div.textContent || '').replace(/\s+/g, ' ').trim()
  return text.length > 150 ? text.slice(0, 150) + '…' : text
}

/** marked 对非 ASCII href 走 encodeURI（「#中文」成 #%E4%B8%AD… 形态），按 id
 *  匹配前先解码；坏编码原样回落（落入坏锚点分支，不炸） */
function decodeFragment(frag: string): string {
  try {
    return decodeURIComponent(frag)
  } catch {
    return frag
  }
}

/** changelog 内的页内锚链接（中/英文小节切换）拦截：preventDefault 防止
 *  hash 写进 SPA 地址栏，改为在 changelog 滚动容器内平滑滚动到目标小节。
 *  挂在 v-html 容器的 click 上（currentTarget = 容器）；非 # 链接不接管 */
export function onChangelogClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  const href = a.getAttribute('href') || ''
  if (!href.startsWith('#')) return
  // 命中与否都不放行默认行为：坏锚点同样不得污染地址栏 hash
  e.preventDefault()
  const container = e.currentTarget as HTMLElement
  const raw = href.slice(1)
  const decoded = decodeFragment(raw)
  // 逐元素比对 id 而非拼选择器：fragment 是外部内容，拼进 querySelector
  // 遇引号/反斜杠会抛 SyntaxError
  let target: Element | null = null
  for (const el of Array.from(container.querySelectorAll('[id]'))) {
    if (el.id === decoded || el.id === raw) {
      target = el
      break
    }
  }
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
