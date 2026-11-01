/**
 * 过程实况录制回放工具（P-20261001-15）：
 * - 敏感值兜底二次遮蔽（tap 层写盘前已按同一模式集遮蔽，回放渲染层双保险；
 *   模式集权威定义与实现在 utils/sensitiveMask，此处保持既有导出面）
 * - cast（asciinema v2）解析：header + 时序输出事件
 * - OSC 133（shell integration）事件提取：命令章节索引
 */

import { maskSensitive } from './sensitiveMask'

export { maskSensitive, SENSITIVE_MASK } from './sensitiveMask'

/** cast 输出事件（仅 "o" 型；t 为相对录制起点的秒） */
export interface CastEvent {
  t: number
  text: string
}

/** 命令章节（OSC 133 E→C→D 链；E 缺失时标签回落占位） */
export interface CastChapter {
  t: number
  label: string
  exitCode?: number
}

/** 章节标签占位符（E 帧缺失 = 无命令文本可考；运行书草稿映射时据此跳过） */
export const CAST_LABEL_PLACEHOLDER = '…'

/** 运行书草稿步骤（录制章节的映射中间形态，P-20261005-3「存为运行书」） */
export interface CastRunbookStep {
  command: string
  /** 折叠后末次尝试的退出码（undefined = cast 未捕获 D 帧，不标失败） */
  exitCode?: number
}

/** cast header 子集（回放只关心尺寸） */
export interface CastHeader {
  version?: number
  width?: number
  height?: number
}

/** OSC 133 帧匹配（线上字节序：ESC ] 133 ; <type> [; <params>] BEL） */
// eslint-disable-next-line no-control-regex -- ESC/BEL 是 OSC 133 线上字节的字面组成部分，匹配终端控制字节正是本正则的职责
const OSC133_RE = /\x1b\]133;([A-Za-z])(?:;([^\x07\x1b]*))?\x07/g

/** base64 → UTF-8 文本（E 帧命令文本；服务端 shellint 以 base64 回传整行命令） */
function b64ToUtf8(b64: string): string {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

export interface ParsedCast {
  header: CastHeader
  events: CastEvent[]
  chapters: CastChapter[]
}

/** 解析 cast 文本：非法行跳过（单行损坏不影响其余），事件文本过兜底遮蔽 */
export function parseCast(text: string): ParsedCast {
  const lines = text.split('\n')
  const parsed: ParsedCast = { header: {}, events: [], chapters: [] }
  let pendingLabel = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? ''
    if (!line) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (i === 0 && row && typeof row === 'object' && !Array.isArray(row)) {
      // header 行：asciinema v2 为对象形态（后续事件行才是 [t, type, data] 数组）
      parsed.header = row as CastHeader
      continue
    }
    if (!Array.isArray(row) || row.length < 3) continue
    if (typeof row[0] !== 'number' || row[1] !== 'o' || typeof row[2] !== 'string') continue
    const t = row[0]
    const raw = row[2] as string
    parsed.events.push({ t, text: maskSensitive(raw) })
    // 章节：E（命令文本）→ C（开始）→ D（结束/退出码）
    for (const m of raw.matchAll(OSC133_RE)) {
      const type = m[1]
      const params = m[2] ?? ''
      if (type === 'E') {
        // 兜底二次遮蔽也覆盖章节标签（命令文本可能含敏感值）
        pendingLabel = maskSensitive(b64ToUtf8(params))
      } else if (type === 'C') {
        parsed.chapters.push({ t, label: pendingLabel || CAST_LABEL_PLACEHOLDER })
        pendingLabel = ''
      } else if (type === 'D' && parsed.chapters.length > 0) {
        const parts = params.split(';')
        const last = parsed.chapters[parsed.chapters.length - 1]
        if (last && last.exitCode === undefined) {
          last.exitCode = parseInt(parts[0] || '0', 10) || 0
        }
      }
    }
  }
  return parsed
}

/**
 * 录制章节 → 运行书草稿步骤（P-20261005-3「存为运行书」，纯映射不涉 UI）：
 * - 无命令文本的章节（E 帧缺失回落占位符）跳过——占位符不能当命令进运行书；
 * - 相邻重复命令折叠为单步（现场重试的噪声不进书），退出码取末次尝试；
 * - 占位符参数化不做自动启发（保守防误参数化，正则注记留二阶段）
 */
export function castChaptersToSteps(chapters: CastChapter[]): CastRunbookStep[] {
  const steps: CastRunbookStep[] = []
  for (const c of chapters) {
    const command = c.label.trim()
    if (!command || command === CAST_LABEL_PLACEHOLDER) continue
    const last = steps[steps.length - 1]
    if (last && last.command === command) {
      last.exitCode = c.exitCode
      continue
    }
    steps.push({ command, exitCode: c.exitCode })
  }
  return steps
}

/** 字节数展示（列表项） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 秒 → m:ss 展示（进度条/时长） */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
