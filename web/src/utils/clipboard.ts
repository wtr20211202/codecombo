// 剪贴板工具：统一处理 secure context / 权限拒绝的降级
// navigator.clipboard 仅在 secure context（HTTPS 或 localhost/127.0.0.1）可用，
// 通过局域网 IP 访问（http://192.168.x.x:9999）时为 undefined 或被权限策略拒绝，
// 此时降级为隐藏 textarea + execCommand('copy')（用户手势内有效）
import { useClipboardHistoryStore } from '@/stores/clipboardHistory'

/**
 * 读剪贴板文本（secure context + 权限允许时）；失败返回 null。
 * 读面没有 execCommand 级降级（读取必须经异步 API 的焦点/权限校验），调用方拿
 * null 自行降级（片段变量替换保留 ${CLIPBOARD} 原样等）。
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      return (await navigator.clipboard.readText()) ?? null
    }
  } catch {
    // 权限拒绝 / 文档失焦等
  }
  return null
}

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  // 首选异步 clipboard API（secure context 且权限允许）
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      // 多剪贴板历史（P-20261002-149）：writeText 不派发 copy 事件，程序化复制
      // 在此补位入史（降级路径的 execCommand 会冒泡 copy 事件，store 内去重兜住双记）
      useClipboardHistoryStore().record(text)
      return true
    }
  } catch {
    // 权限拒绝 / 文档失焦等，走降级
  }
  // 降级：execCommand（同步，需在用户手势调用栈内）。
  // 用 Range 选区而不是 textarea focus+select——focus 会被 Naive UI 模态框的
  // 焦点陷阱拉回（textarea 挂 body 上拿不到焦点，此时 execCommand 仍返回 true
  // 但实际没复制任何内容）；Range 选区不依赖焦点，弹窗内外都能工作
  try {
    // pre 而不是 span：Range 复制取的是渲染后文本，普通行内元素的空白折叠会把
    // 换行变空格——多行邀请信息（链接/口令/有效期分行）在局域网 http 等无
    // Clipboard API 的环境里会被压成一行。pre 保留换行；离屏定位不占布局
    const span = document.createElement('pre')
    span.textContent = text
    span.style.position = 'fixed'
    span.style.left = '-9999px'
    span.style.margin = '0'
    span.style.whiteSpace = 'pre-wrap'
    span.setAttribute('aria-hidden', 'true')
    document.body.appendChild(span)
    const range = document.createRange()
    range.selectNodeContents(span)
    const sel = window.getSelection()
    if (!sel) return false
    sel.removeAllRanges()
    sel.addRange(range)
    const ok = document.execCommand('copy')
    sel.removeAllRanges()
    span.remove()
    return ok
  } catch {
    return false
  }
}
