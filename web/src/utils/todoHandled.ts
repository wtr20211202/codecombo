/**
 * TODO 面板「已处理」勾选（P-20261003-200）纯函数：面板态隐藏集合的键语义、
 * 增删与 localStorage 记录解析/序列化。勾选与代码注释生命周期独立——键按
 * path:line 匹配（不带 column：同行编辑会平移列，行号才是漂移容忍的最小稳定
 * 粒度），代码挪行/删注释后的陈旧键静默失配（条目自然重现），不按扫描结果
 * 修剪（面板态不该被代码态回写，上限 FIFO 兜底防无界）。
 *
 * 持久化形态是 localStorage `todo.handled`（safeStorage 通道）的一条记录：
 * { showHandled, byProject: { [projectId]: path:line 键列表 } }——项目维键控、
 * 显示开关全局一份。记录的读写与拼装归宿主（TodoPanel），此处只管纯语义；
 * 解析全程防御：坏 JSON/形态不符按默认值降级（等价 storage.ts 的容错立场）。
 */

/** 单项目已处理键上限：扫描本身截到 500 条，同量级 FIFO 淘汰最旧即可覆盖 */
export const MAX_HANDLED_PER_PROJECT = 500

/** 项目映射键数上限（防御性封顶，通知 projectMutes 同量级惯例） */
export const MAX_HANDLED_PROJECTS = 200

export interface TodoHandledRecord {
  /** 「显示已处理」开关（全局偏好，不分项目） */
  showHandled: boolean
  /** projectId -> 已处理键（path:line）列表；新→旧序（尾部最新，FIFO 淘汰头部） */
  byProject: Record<string, string[]>
}

/** 条目的已处理键：path:line（漂移容忍粒度，见文件头注） */
export function handledKeyOf(path: string, line: number): string {
  return `${path}:${line}`
}

/** 标记已处理：去重后置尾（新→旧序），超出上限淘汰最旧 */
export function markHandled(list: string[], key: string, max = MAX_HANDLED_PER_PROJECT): string[] {
  return [...list.filter(k => k !== key), key].slice(-max)
}

/** 撤销已处理 */
export function unmarkHandled(list: string[], key: string): string[] {
  return list.filter(k => k !== key)
}

const EMPTY_RECORD: TodoHandledRecord = { showHandled: false, byProject: {} }

/** 解析 localStorage 记录：坏 JSON/形态不符逐层降级，非字符串/空串键丢弃，
 *  单项目列表去重 + FIFO 截上限，空列表项目剔除（不占映射槽位） */
export function parseHandledRecord(raw: string | null): TodoHandledRecord {
  if (!raw) return { ...EMPTY_RECORD, byProject: {} }
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { ...EMPTY_RECORD, byProject: {} }
  }
  if (typeof obj !== 'object' || obj === null) return { ...EMPTY_RECORD, byProject: {} }
  const src = obj as { showHandled?: unknown; byProject?: unknown }
  const byProject: Record<string, string[]> = {}
  if (typeof src.byProject === 'object' && src.byProject !== null) {
    let kept = 0
    for (const [pid, list] of Object.entries(src.byProject as Record<string, unknown>)) {
      if (kept >= MAX_HANDLED_PROJECTS) break
      if (!Array.isArray(list)) continue
      const keys = [...new Set(list.filter((k): k is string => typeof k === 'string' && k.length > 0))]
      if (keys.length === 0) continue
      byProject[pid] = keys.slice(-MAX_HANDLED_PER_PROJECT)
      kept++
    }
  }
  return { showHandled: src.showHandled === true, byProject }
}

/** 序列化回 localStorage 记录 */
export function serializeHandledRecord(record: TodoHandledRecord): string {
  return JSON.stringify(record)
}
