// favicon 待办角标（P-20261003-65）：固定标签页（pinned tab）不显示 title、
// 只露 favicon——title 前缀徽标（App.vue 同文件）在 pin 形态下不可见。本模块
// 在现有 favicon 上 canvas 叠角点+数字（>9 显 9+）换成 dataURL href，归零恢复
// 原图标；与 title 徽标共用同一 badge 计算值（App.vue watch 同点位触发）。
//
// 姿态与 agentTaskNotify / alertSound 同惯例：纯浏览器侧增强面、不持视图状态，
// 任何一步失败（fetch / SVG 解码 / 无 2d 上下文）静默保持原图标——角标缺失
// 只是退化，绝不能影响主功能，也不产生 toast 噪音。
//
// 浏览器兼容注记：Firefox 取「最后一个」icon link，Chrome 优先 SVG——合成
// 结果同写全部 icon link，两种取用策略都盖到；SVG 源注入显式 width/height
// （仅有 viewBox 时 Firefox drawImage 光栅化为 0×0）。

// 角点直径放不下两位以上数字：>9 一律显 9+（与 UI 徽标 99+ 上限不同源，
// 见 utils/badge.ts——favicon 像素预算小一个量级）
const BADGE_LIMIT = 9
const CANVAS_SIZE = 64
// 角点圆心/半径：右下角惯例位；白描边环隔离原图标线条（Gmail 同款手法）
const CENTER = 48
const RADIUS = 14
const RING_WIDTH = 3
// 底色跟主题 --accent-red（四主题已同步定义）。canvas 光栅在 CSS 级联之外，
// 读不到变量时兜底固定值——favicon.svg 自身同为硬编码品牌色（OS 级品牌面，
// 与主题适配规范针对的 DOM UI 着色不同界）；前景文字/描边固定白，红底白字
// 是注意力色惯例，与标签栏底色无关
const FALLBACK_BG = '#f44747'
const TEXT_COLOR = '#ffffff'
const RING_COLOR = '#ffffff'
// 合成结果按角标文案缓存（审批/通知事件驱动的低频路径，实际 ≤ 双位数档位；
// 上限防理论无界——超限按插入序逐出最早）
const CACHE_LIMIT = 50
// 角标态可观测锚：href 是光栅 dataURL 无法文本断言，属性值即角标文案
export const FAVICON_BADGE_ATTR = 'data-favicon-badge'

/** 角标文案：>9 显 9+ */
export function faviconBadgeLabel(count: number): string {
  return count > BADGE_LIMIT ? `${BADGE_LIMIT}+` : String(count)
}

// 原始 icon link 留档（恢复锚点）：href/type 均按字面属性值回写，不做 URL 归一
let originals: Array<{ el: HTMLLinkElement; href: string | null; type: string | null }> | null = null
// 原始 favicon 源文本（一次拉取后复用；切角标后再变档位不许从 dataURL 反解）
let sourceSvg: string | null = null
const composedCache = new Map<string, string>()
// 竞态令牌：慢合成期间计数又变（1→0/1→2），过期结果不得覆盖最新状态
let seq = 0

function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
}

/** 原始 favicon 源文本：按首个 icon link 的 href 解析（与浏览器加载同源，
 * 代理子路径下 baseURI 解析天然正确），一次拉取后缓存 */
async function loadSourceSvg(primary: HTMLLinkElement): Promise<string | null> {
  if (sourceSvg) return sourceSvg
  const href = primary.getAttribute('href')
  // 已是 dataURL（理论态：上游直接内联）则无源可拉，放弃角标
  if (!href || href.startsWith('data:')) return null
  try {
    const res = await fetch(new URL(href, document.baseURI).href)
    if (!res.ok) return null
    const text = await res.text()
    if (!/<svg[\s>]/i.test(text)) return null // 非 SVG favicon（ico 位等）不合成
    sourceSvg = text
    return text
  } catch {
    return null
  }
}

/** svg 根缺显式尺寸时注入 width/height：drawImage 光栅化需要固有尺寸 */
function withIntrinsicSize(svg: string, size: number): string {
  if (/<svg[^>]*\swidth=/i.test(svg)) return svg
  return svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => `<svg${attrs} width="${size}" height="${size}">`)
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('favicon svg decode failed'))
    // dataURL 而非 blob URL：免 revoke 簿记，且 canvas 不会被跨源污染
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
}

/** 光栅合成：原图标 + 右下角点数字；无 2d 上下文（jsdom 等）返回 null 放弃 */
function drawBadge(img: HTMLImageElement, label: string): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_SIZE
  canvas.height = CANVAS_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE)

  const bg = getComputedStyle(document.documentElement).getPropertyValue('--accent-red').trim() || FALLBACK_BG
  ctx.beginPath()
  ctx.arc(CENTER, CENTER, RADIUS, 0, Math.PI * 2)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.lineWidth = RING_WIDTH
  ctx.strokeStyle = RING_COLOR
  ctx.stroke()

  // 两位（「9+」）缩字号；+1 为 baseline middle 的视觉垂直配平
  ctx.fillStyle = TEXT_COLOR
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${label.length > 1 ? 15 : 20}px system-ui, sans-serif`
  ctx.fillText(label, CENTER, CENTER + 1)
  return canvas.toDataURL('image/png')
}

function restoreFavicon(): void {
  seq++ // 作废在途慢合成：恢复态永远赢
  if (!originals) return
  for (const { el, href } of originals) {
    if (el.getAttribute('href') !== href) {
      if (href === null) el.removeAttribute('href')
      else el.setAttribute('href', href)
    }
  }
  const primary = originals[0]
  if (primary) {
    if (primary.type === null) primary.el.removeAttribute('type')
    else primary.el.setAttribute('type', primary.type)
    primary.el.removeAttribute(FAVICON_BADGE_ATTR)
  }
}

/**
 * 按待办数更新 favicon 角标：count>0 叠角点（>9 显 9+），≤0 恢复原图标。
 * fire-and-forget 调用（App.vue watch 处 void 掉），内部失败静默保持现状。
 */
export async function updateFaviconBadge(count: number): Promise<void> {
  const links = iconLinks()
  const primary = links[0]
  if (!primary) return
  // 原始 href/type 首见留档——必须先于任何切换捕获
  if (!originals) {
    originals = links.map((el) => ({ el, href: el.getAttribute('href'), type: el.getAttribute('type') }))
  }

  if (count <= 0) {
    restoreFavicon()
    return
  }

  const mySeq = ++seq
  const label = faviconBadgeLabel(count)
  let dataUrl = composedCache.get(label) ?? null
  if (!dataUrl) {
    const svg = await loadSourceSvg(primary)
    if (!svg) return
    try {
      const img = await loadSvgImage(withIntrinsicSize(svg, CANVAS_SIZE))
      dataUrl = drawBadge(img, label)
    } catch {
      return
    }
    if (!dataUrl) return
    if (seq !== mySeq) return // 过期合成：期间计数又变，由最新一次调用接管
    if (composedCache.size >= CACHE_LIMIT) {
      composedCache.delete(composedCache.keys().next().value!)
    }
    composedCache.set(label, dataUrl)
  }
  if (seq !== mySeq) return

  // 全部 icon link 同换 dataURL；primary 的 type 提示同步校正为 PNG（href 实际
  // 内容已是光栅图，浏览器按 dataURL 自带 MIME 嗅探，type 仅作声明一致）
  links.forEach((el) => { el.setAttribute('href', dataUrl) })
  primary.setAttribute('type', 'image/png')
  primary.setAttribute(FAVICON_BADGE_ATTR, label)
}
