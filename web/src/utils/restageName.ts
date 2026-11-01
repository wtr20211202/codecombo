/**
 * 回收站冲突恢复的建议名（P-20261006-15）纯函数：<stem>-restaged<步进>.<ext>。
 *
 * 服务端 restore?as= 是精确名（命中已存在目标照旧 409，不自行步进——agent
 * 编程化语义可预期），「建议名也冲突时自动步进 -restaged-2、-restaged-3…」
 * 是前端职责：弹层给首建议，执行链 409 驱动逐次换名重试。
 */

export const RESTAGED_TAG = '-restaged'

/**
 * 首建议名：foo.txt → foo-restaged.txt；foo（无扩展名）→ foo-restaged；
 * .env（点开头隐藏文件）整体作主干 → .env-restaged 而非「-restaged.env」
 *（服务端 duplicate splitNameExt 同口径）
 */
export function restageSuggestion(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return name + RESTAGED_TAG
  return name.slice(0, dot) + RESTAGED_TAG + name.slice(dot)
}

/**
 * 步进：foo-restaged.txt → foo-restaged-2.txt；foo-restaged-2.txt →
 * foo-restaged-3.txt。非建议名形态（无 -restaged 尾缀）回落为首建议——
 * 调用方约定只对建议名产物步进，回落是防误用的兜底而非正常路径
 */
export function restageStep(name: string): string {
  const m = /^(.*)-restaged(?:-(\d+))?(\.[^.]*)?$/.exec(name)
  if (!m) return restageSuggestion(name)
  const n = m[2] ? parseInt(m[2], 10) : 1
  return `${m[1]}${RESTAGED_TAG}-${n + 1}${m[3] || ''}`
}
