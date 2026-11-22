/**
 * 项目文件预览端点 URL 组装（P-20261119-4 S3 前端面）。
 *
 * 与 S2 六端点一一对应（api/files/preview.go）：raw/pdf-image-av 字节面、
 * rel/<路径> 通配回源（htmlview <base href> 的落点，query 型做不了 base）、
 * htmlview 沙箱预览（scripts=1 opt-in 红线同分享侧：只加 allow-scripts，
 * 绝不 allow-same-origin）、media/embed（docx 渲染产物内已自带，本模块
 * 不重复组装）、download（「原文件」态信息卡的下载出口，复用既有直链）。
 * 浏览器同源导航自动携带锁令牌 cookie，无需额外凭据参数。
 */

function enc(p: string): string {
  return encodeURIComponent(p)
}

/** 字节内联端点（<img>/<video>/<audio>/<iframe pdf> 的 src） */
export function fileRawURL(projectId: string, path: string): string {
  return `/api/projects/${enc(projectId)}/file/raw?path=${enc(path)}`
}

/** html 沙箱预览（scriptsOn opt-in 时带 ?scripts=1——响应 CSP 与 iframe
 *  sandbox 两层同步放开且都绝不含 allow-same-origin） */
export function fileHtmlViewURL(projectId: string, path: string, scriptsOn: boolean): string {
  return `/api/projects/${enc(projectId)}/file/htmlview?path=${enc(path)}${scriptsOn ? '&scripts=1' : ''}`
}

/** 渲染类 payload + 元数据（GET，axios 消费） */
export function filePreviewURL(projectId: string, path: string): string {
  return `/api/projects/${enc(projectId)}/file/preview?path=${enc(path)}`
}

/** 下载直链（「原文件」态信息卡出口；服务端恒 attachment 语义） */
export function fileDownloadURL(projectId: string, path: string): string {
  return `/api/projects/${enc(projectId)}/file/download?path=${enc(path)}`
}
