import { marked } from 'marked'
import DOMPurify from 'dompurify'
import './markedHeadingIds'

/**
 * markdown → 净化 HTML 的前端单一管线（P-20261119-4 S3 必改2(a) 定案的
 * 防漂移收口）：编辑器侧栏实时预览（useEditorMdPreview）与统一预览视图
 * （FilePreviewView）共用同一渲染+净化配置——GFM/换行/任务列表 input 白
 * 名单/target 属性透传/heading id 锚点。后端 md 渲染零新增（S2 只回 kind），
 * 全应用 md 渲染出口收敛为本函数。
 */

marked.setOptions({
  gfm: true,
  breaks: true,
})

/** md 文本 → 净化 HTML（DOMPurify 白名单；ADD 面与 P-20261003-301 定案一致） */
export function renderMdPreviewHtml(md: string): string {
  if (!md) return ''
  const raw = marked.parse(md, { async: false }) as string
  // 允许 input 元素以支持 GFM 任务列表。a/target 在允许面（P-20261003-108 复核）：
  // 落盘的 target 属性是惰性的——左键点击被预览容器委托 preventDefault 接管
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target'],
    ADD_TAGS: ['input'],
  })
}
