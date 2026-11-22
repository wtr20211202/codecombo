/**
 * 统一双视图（原文件 ↔ 预览）的分流判定与偏好记忆（P-20261119-4 S3）。
 *
 * kind 数据源 = 服务端 file-preview 注册表（file-policy 响应增量 pv 字段，
 * 与分享访客面同一判定源——扩展格式两侧同时生效）。零依赖纯函数模块 +
 * localStorage 设备本地偏好（remotePathMemory.ts 同族口径：设备本地偏好
 * 不进车道 1）。
 *
 * 分流默认态（用户定向修订定案）：
 *  - 预览 Kind 命中的二进制类（docx/pdf/image/av/html/csv/sheet）→ 默认
 *    预览态（S2 能力直出，「binary not previewable」从用户路径消失）；
 *  - markdown/text 从编辑器缓冲渲染（必改2a：md 前端管线），缓冲在二进制
 *    嗅探下恒为空——sniffed-binary 的 md/txt 不给预览态（回落信息卡现状）；
 *  - info/未注册 → 无预览态（信息卡+下载，真未知格式如实交代）。
 */

/** 视图态（tab 内「原文件 | 预览」双态） */
export type FileViewMode = 'source' | 'preview'

/** 服务端 pv.kind 全集中可出预览态的子集（终态统一按本表判定） */
const PREVIEW_KINDS = new Set([
  'markdown', 'html', 'csv', 'sheet', 'docx', 'pdf', 'image', 'video', 'audio', 'text',
])

/** 二进制文件可默认预览态的 kind（服务端读数的 kind 全在内；markdown/text
 *  渲染自缓冲，sniffed-binary 下缓冲为空故不在集合） */
const BINARY_PREVIEW_KINDS = new Set(['docx', 'pdf', 'image', 'video', 'audio', 'html', 'csv', 'sheet'])

/** pv.kind 是否可出预览态（tab 双态开关可见性的唯一判据） */
export function pvPreviewable(pvKind: string | undefined): boolean {
  return !!pvKind && PREVIEW_KINDS.has(pvKind)
}

/** 二进制文件（filepolicy kind=binary）是否可默认进预览态 */
export function pvBinaryPreviewable(pvKind: string | undefined): boolean {
  return !!pvKind && BINARY_PREVIEW_KINDS.has(pvKind)
}

const KEY_PREFIX = 'sc.filePreview.mode.'

function extOf(path: string): string {
  const base = path.split('/').pop() || path
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/** 读某扩展名的上次视图偏好（无记录/脏值 = null，调用方回落 kind 默认态） */
export function preferredViewMode(path: string): FileViewMode | null {
  const ext = extOf(path)
  if (!ext) return null // 无扩展名（Makefile 等）不落偏好——prefers nothing to a shared catch-all
  try {
    const v = localStorage.getItem(KEY_PREFIX + ext)
    return v === 'source' || v === 'preview' ? v : null
  } catch {
    return null
  }
}

/** 记住视图偏好（GitHub/VS Code 惯例：切换即写，下次打开同扩展名生效） */
export function rememberViewMode(path: string, mode: FileViewMode): void {
  const ext = extOf(path)
  if (!ext) return
  try {
    localStorage.setItem(KEY_PREFIX + ext, mode)
  } catch { /* 环境无 localStorage 静默跳过 */ }
}

/** 打开链的默认视图态：偏好优先，缺省按 kind 分流（二进制可预览类默认
 *  preview，其余 source = 现工作流零回归） */
export function defaultViewMode(path: string, pvKind: string | undefined, binaryKind: boolean): FileViewMode {
  const stored = preferredViewMode(path)
  if (stored) return stored
  if (binaryKind && pvBinaryPreviewable(pvKind)) return 'preview'
  return 'source'
}
