import { safeStorage } from './storage'

// 命令片段参数历史值（P-20261002-123）：带参片段确认填充时记忆各占位符的
// 上次填写值，下次展开参数输入区预填——高频命令「一步填」。
// safeStorage 持久化（localStorage 被隐私模式屏蔽时降级内存兜底，与会内其他
// 存储一致不阻断）；片段数封顶防无限膨胀（与 paletteUsage 的封顶先例同思路）

/** 参数名 → 上次填写值（仅非空白值入史） */
export type SnippetParamValues = Record<string, string>
/** 片段 id → 该片段各占位符的历史值 */
export type SnippetParamHistory = Record<string, SnippetParamValues>

export const SNIPPET_PARAM_HISTORY_KEY = 'sc.snippet.paramValues'
/** 片段数上限：按最近确认时间 LRU——超出时淘汰最久未确认的片段 */
export const SNIPPET_PARAM_HISTORY_MAX = 50

function parseHistory(raw: string | null): SnippetParamHistory {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: SnippetParamHistory = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const vals: SnippetParamValues = {}
      let has = false
      for (const [name, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string' && val.trim()) {
          vals[name] = val
          has = true
        }
      }
      if (has) out[id] = vals
    }
    return out
  } catch {
    return {}
  }
}

/** 读取全量历史；损坏条目逐条丢弃 */
export function loadSnippetParamHistory(): SnippetParamHistory {
  return parseHistory(safeStorage.getItem(SNIPPET_PARAM_HISTORY_KEY))
}

export function saveSnippetParamHistory(history: SnippetParamHistory): void {
  safeStorage.setItem(SNIPPET_PARAM_HISTORY_KEY, JSON.stringify(history))
}

/** 记一次确认填充：合并该片段的非空白参数值并刷新其 LRU 位次
 *  （纯函数，返回新 map；值全空白时不动历史）。超上限时按 LRU 淘汰
 *  最久未确认的片段——高频片段不会被挤出 */
export function recordSnippetParamValues(
  history: SnippetParamHistory,
  snippetId: string,
  values: SnippetParamValues,
): SnippetParamHistory {
  const vals: SnippetParamValues = {}
  for (const [name, v] of Object.entries(values)) {
    if (typeof v === 'string' && v.trim()) vals[name] = v
  }
  if (Object.keys(vals).length === 0) return history
  const prev = history[snippetId]
  const next: SnippetParamHistory = {}
  for (const [id, v] of Object.entries(history)) {
    if (id !== snippetId) next[id] = v
  }
  next[snippetId] = prev ? { ...prev, ...vals } : vals
  const oldest = Object.keys(next)[0]
  if (Object.keys(next).length > SNIPPET_PARAM_HISTORY_MAX && oldest) delete next[oldest]
  return next
}

/** 确认填充的便捷入口：读改写一次落库 */
export function rememberSnippetParamValues(snippetId: string, values: SnippetParamValues): void {
  saveSnippetParamHistory(recordSnippetParamValues(loadSnippetParamHistory(), snippetId, values))
}
