/**
 * 诊断快照数值展示切片（P-20261002-18 纯函数）：
 * 服务端以 MB 口径落盘，前端统一在此转人类可读；弹窗对比条与
 * 主机卡悬停趋势共用同一格式化，避免两处口径漂移。
 */

/** MB → 人类可读（≥1GB 转 GB 保留一位小数） */
export function formatMB(mb: number): string {
  if (!Number.isFinite(mb)) return '—'
  const abs = Math.abs(mb)
  if (abs >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

/** 带符号 MB 差值文本：+2.3 GB / -512 MB / ±0 MB（0 视为持平） */
export function formatDeltaMB(mb: number): string {
  const body = formatMB(Math.abs(mb))
  if (mb > 0) return `+${body}`
  if (mb < 0) return `-${body}`
  return `±${body}`
}

/** 带符号负载差值文本：+0.35 / -0.20 / ±0.00（两位小数） */
export function formatDeltaLoad(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (v > 0) return `+${v.toFixed(2)}`
  if (v < 0) return v.toFixed(2)
  return '±0.00'
}

/** 带符号整数差值文本（会话/终端计数类）：+2 / -1 / ±0（本机体检趋势条，
 * P-20261005-169——与 formatDeltaMB/formatDeltaLoad 同族，符号惯例一致） */
export function formatDeltaCount(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (v > 0) return `+${v}`
  if (v < 0) return `${v}`
  return '±0'
}

/** 快照时间短格式（卡片行内展示）：MM/DD HH:mm */
export function formatDiagShortTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
