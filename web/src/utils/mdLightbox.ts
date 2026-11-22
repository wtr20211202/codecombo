/**
 * md 预览图片灯箱（P-20261120-3）：点击预览内图片全屏看原图，点击遮罩/Esc
 * 关闭。移植分享访客页 openLightbox 同款交互（server/share/page_js_core.go）——
 * 分享侧已有而主应用反而没有的不一致面。纯 DOM 单例层：元素挂 document.body
 * （v-html 内容绑不了组件事件，灯箱又须盖过组件树），样式在全局
 * styles/md-preview.css（scoped 不可达）。宿主（FilePreviewView 整幅预览 +
 * EditorMdPreviewPane 侧栏实时预览，经 useEditorMdPreview 委托分流）共用本
 * 出口防漂移；宿主卸载时调 closeMdLightbox 收口（灯箱不在组件树内，不随
 * v-if 自动摘除）。
 */

let activeLb: HTMLElement | null = null
let escHandler: ((e: KeyboardEvent) => void) | null = null

/** 关闭当前灯箱（幂等）：点击遮罩 / Esc / 宿主组件卸载三入口共用同一清理 */
export function closeMdLightbox(): void {
  if (escHandler) {
    document.removeEventListener('keydown', escHandler)
    escHandler = null
  }
  activeLb?.remove()
  activeLb = null
}

export function openMdLightbox(src: string): void {
  // 单例：遮罩全屏挡住内容，灯箱开着时点不开第二张（分享页直 append 的
  // 形态连点会叠层，这里收口）
  if (activeLb) return
  const lb = document.createElement('div')
  lb.className = 'md-lightbox'
  const img = document.createElement('img')
  img.src = src
  img.alt = ''
  lb.appendChild(img)
  lb.addEventListener('click', closeMdLightbox)
  escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeMdLightbox()
  }
  document.addEventListener('keydown', escHandler)
  document.body.appendChild(lb)
  activeLb = lb
}
