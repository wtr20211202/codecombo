import { safeStorage } from './storage'

// 运行书参数历史值（P-20261004-112）：带参运行书提交（填参运行/填好发送）时
// 记忆各占位符的历史填写值（per-book per-param 环形 ≤5），下次参数框聚焦弹
// 历史下拉点选回填——高频运行书（部署/巡检/构建）跨会话免重填。存储沿
// snippetParamHistory 同款形态（safeStorage 持久化，localStorage 被隐私模式
// 屏蔽时降级内存兜底，与会内其他存储一致不阻断）；下拉交互沿 useSearchHistory
// 惯例（前缀过滤补全 / Esc 收起 / 尾部清空兜底——历史值可能含敏感串，只落本机）

/** 参数名 → 历史值环形（新→旧，去重，≤ RUNBOOK_PARAM_VALUES_MAX 条） */
export type RunbookParamRing = string[]
/** 运行书 id → 参数名 → 历史值环形 */
export type RunbookParamHistory = Record<string, Record<string, RunbookParamRing>>

export const RUNBOOK_PARAM_HISTORY_KEY = 'runbook-params-history'
/** 每参数历史值上限：环形——重复值去重置顶，新值插头后裁尾 */
export const RUNBOOK_PARAM_VALUES_MAX = 5
/** 运行书数上限：按最近提交时间 LRU——超出时淘汰最久未提交的书
 *  （防跨书无界膨胀，与 snippetParamHistory 的片段封顶同思路） */
export const RUNBOOK_PARAM_HISTORY_MAX = 50

function parseHistory(raw: string | null): RunbookParamHistory {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: RunbookParamHistory = {}
    for (const [bookId, params] of Object.entries(parsed as Record<string, unknown>)) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) continue
      const rings: Record<string, RunbookParamRing> = {}
      let has = false
      for (const [name, ring] of Object.entries(params as Record<string, unknown>)) {
        if (!Array.isArray(ring)) continue
        // 只收非空白字符串：存储层脏数据（手改/旧版本残留）不进内存态
        const vals = ring.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        if (vals.length > 0) {
          rings[name] = vals
          has = true
        }
      }
      if (has) out[bookId] = rings
    }
    return out
  } catch {
    return {}
  }
}

/** 读取全量历史；损坏条目逐条丢弃 */
export function loadRunbookParamHistory(): RunbookParamHistory {
  return parseHistory(safeStorage.getItem(RUNBOOK_PARAM_HISTORY_KEY))
}

export function saveRunbookParamHistory(history: RunbookParamHistory): void {
  safeStorage.setItem(RUNBOOK_PARAM_HISTORY_KEY, JSON.stringify(history))
}

/** 记一次提交：该书的各参数非空白值入环形史（重复值去重置顶）并刷新该书
 *  LRU 位次（纯函数，返回新 map；值全空白时不动历史）。书数超上限时按 LRU
 *  淘汰最久未提交的书——高频运行书不会被挤出 */
export function recordRunbookParamValues(
  history: RunbookParamHistory,
  bookId: string,
  values: Record<string, string>,
): RunbookParamHistory {
  if (!bookId) return history
  const vals: Record<string, RunbookParamRing> = {}
  for (const [name, v] of Object.entries(values)) {
    if (typeof v === 'string' && v.trim()) {
      const prev = history[bookId]?.[name] || []
      vals[name] = [v, ...prev.filter((x) => x !== v)].slice(0, RUNBOOK_PARAM_VALUES_MAX)
    }
  }
  if (Object.keys(vals).length === 0) return history
  const prevBook = history[bookId]
  const next: RunbookParamHistory = {}
  for (const [id, rings] of Object.entries(history)) {
    if (id !== bookId) next[id] = rings
  }
  next[bookId] = prevBook ? { ...prevBook, ...vals } : vals
  const oldest = Object.keys(next)[0]
  if (Object.keys(next).length > RUNBOOK_PARAM_HISTORY_MAX && oldest) delete next[oldest]
  return next
}

/** 前缀匹配过滤（补全式）：大小写不敏感——useSearchHistory.filterByPrefix 同口径 */
export function filterRunbookParamValues(ring: RunbookParamRing, prefix: string): RunbookParamRing {
  const p = prefix.trim().toLowerCase()
  if (!p) return ring.slice()
  return ring.filter((v) => v.toLowerCase().startsWith(p))
}

/** 清除一书一参的环形史（纯函数）；书内已无参数时连书条目一并摘除 */
export function clearRunbookParamValues(
  history: RunbookParamHistory,
  bookId: string,
  name: string,
): RunbookParamHistory {
  const book = history[bookId]
  if (!book || !book[name]) return history
  const rings: Record<string, RunbookParamRing> = {}
  for (const [n, ring] of Object.entries(book)) {
    if (n !== name) rings[n] = ring
  }
  const next: RunbookParamHistory = {}
  for (const [id, v] of Object.entries(history)) {
    if (id !== bookId) next[id] = v
  }
  if (Object.keys(rings).length > 0) next[bookId] = rings
  return next
}

/** 记一次提交的便捷入口：读改写一次落库 */
export function rememberRunbookParamValues(bookId: string, values: Record<string, string>): void {
  saveRunbookParamHistory(recordRunbookParamValues(loadRunbookParamHistory(), bookId, values))
}

/** 清除一书一参历史的便捷入口：读改写一次落库 */
export function forgetRunbookParamValues(bookId: string, name: string): void {
  saveRunbookParamHistory(clearRunbookParamValues(loadRunbookParamHistory(), bookId, name))
}
