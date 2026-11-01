import { ref, type Ref } from 'vue'
import { safeStorage } from '../utils/storage'

// 通用查询历史（P-20261003-48 项目搜索首发；P-20261004-109 泛化为域无关参数件，
// 终端搜索二次兑现）：环形去重置顶 + safeStorage 持久化的通用查询记忆。各域以
// options 声明自己的存储通道与容量（同键共享同一份内存态），缺省即项目搜索域。
// 历史含敏感串只落本机（用户自域），下拉尾部「清空历史」入口兜底。

export interface SearchHistoryOptions {
  /** safeStorage 通道键：历史全局域（搜索词与仓库/会话无关，常跨域复用） */
  storageKey: string
  /** 环形容量：超出裁最旧 */
  maxHistory: number
}

// 缺省域 = 项目搜索（P-48 现状：15 条全域）
const DEFAULT_OPTIONS: SearchHistoryOptions = {
  storageKey: 'project-search-history',
  maxHistory: 15,
}

export interface SearchHistoryApi {
  history: Ref<string[]>
  recordQuery: (q: string) => void
  filterByPrefix: (prefix: string) => string[]
  clearHistory: () => void
}

// 按通道键分域的模块级单例（useRecentFiles 同式）：记录与展示分离，写入不依赖
// 面板挂载；同域多消费者（如多终端 pane）共享同一份历史。同键二次调用以首次
// 注册的容量为准（各域容量是域常量，调用方不会传不同值）
const instances = new Map<string, SearchHistoryApi>()

function loadHistory(storageKey: string): string[] {
  try {
    const raw = safeStorage.getItem(storageKey)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 只收非空字符串：存储层脏数据（手改/旧版本残留）不进内存态
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  } catch {
    return []
  }
}

function createSearchHistory(opts: SearchHistoryOptions): SearchHistoryApi {
  const history = ref<string[]>(loadHistory(opts.storageKey))

  function persist() {
    safeStorage.setItem(opts.storageKey, JSON.stringify(history.value))
  }

  /** 记录一次查询：去重置顶 + 环形裁剪。调用方在搜索发起时调用 */
  function recordQuery(q: string) {
    const term = q.trim()
    if (!term) return
    const idx = history.value.indexOf(term)
    if (idx !== -1) history.value.splice(idx, 1)
    history.value.unshift(term)
    if (history.value.length > opts.maxHistory) history.value.length = opts.maxHistory
    persist()
  }

  /** 前缀匹配过滤（补全式）：大小写不敏感——搜索默认即大小写不敏感，记忆同口径 */
  function filterByPrefix(prefix: string): string[] {
    const p = prefix.trim().toLowerCase()
    if (!p) return history.value.slice()
    return history.value.filter((h) => h.toLowerCase().startsWith(p))
  }

  /** 清空历史（下拉尾部入口）：持久层 + 内存态同清 */
  function clearHistory() {
    history.value = []
    safeStorage.removeItem(opts.storageKey)
  }

  return { history, recordQuery, filterByPrefix, clearHistory }
}

export function useSearchHistory(options?: Partial<SearchHistoryOptions>): SearchHistoryApi {
  const storageKey = options?.storageKey ?? DEFAULT_OPTIONS.storageKey
  const existing = instances.get(storageKey)
  if (existing) return existing
  const created = createSearchHistory({
    storageKey,
    maxHistory: options?.maxHistory ?? DEFAULT_OPTIONS.maxHistory,
  })
  instances.set(storageKey, created)
  return created
}
