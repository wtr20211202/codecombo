import { ref } from 'vue'
import { safeStorage } from '../utils/storage'

// 克隆 URL 历史（P-20261003-251）：换目录/重试再克隆同仓库时 URL 手打重复。
// 搜索查询历史同惯例（useSearchHistory P-20261003-48）：模块级单例（记录与展示
// 分离，写入不依赖对话框挂载）、去重置顶、环形封顶、localStorage safeStorage
// 通道（裸 localStorage 在屏蔽 Cookie/隐私模式下抛 SecurityError 是既有红线）、
// 下拉尾部「清空历史」入口兜底。
// 记录时机 = 克隆提交时（同搜索「发起时记录」：失败重试恰是本提案动机之一，
// 提交即用户意图；打错的 URL 随后改对重发会去重置顶，噪声由环形封顶与清空入口兜底）。
// 含凭据 URL 不入历史：明文密钥不落 localStorage——跳过而非剥离，剥离后的地址
// 凭据语义已变（再克隆多半要重配凭据），回填一个「不完全等价」的 URL 反而误导。

const MAX_HISTORY = 10
const STORAGE_KEY = 'clone-url-history'

/**
 * 含凭据形态判定：scheme:// 长形且 authority 段 userinfo 含冒号（user:pass@
 * Basic 形态，HTTP(S) 克隆地址唯一会夹带明文密钥的形态）。SCP 短形
 * git@host:path 无 :// 不命中；ssh://git@host（userinfo 无冒号 = SSH 登录名
 * 非凭据）不命中——标准 SSH 地址照常入史。
 */
const CREDENTIAL_URL_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i

/** 是否含 user:pass@ 凭据段（recordUrl 内部跳过的判定，导出供单测/复用锚定语义） */
export function hasUrlCredentials(url: string): boolean {
  return CREDENTIAL_URL_RE.test(url.trim())
}

// 模块级单例（useSearchHistory 同式）
const history = ref<string[]>(loadHistory())

function loadHistory(): string[] {
  try {
    const raw = safeStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 只收非空字符串且不含凭据段：存储层脏数据/旧版本残留不进内存态
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '' && !hasUrlCredentials(v))
  } catch {
    return []
  }
}

function persist() {
  safeStorage.setItem(STORAGE_KEY, JSON.stringify(history.value))
}

export function useCloneUrlHistory() {
  /** 记录一次克隆提交：含凭据/空白跳过；去重置顶 + 环形裁剪 */
  function recordUrl(raw: string) {
    const url = raw.trim()
    if (!url || hasUrlCredentials(url)) return
    const idx = history.value.indexOf(url)
    if (idx !== -1) history.value.splice(idx, 1)
    history.value.unshift(url)
    if (history.value.length > MAX_HISTORY) history.value.length = MAX_HISTORY
    persist()
  }

  /** 前缀匹配过滤（补全式）：大小写不敏感——克隆 URL 的 scheme/host 本就不区分大小写，同口径 */
  function filterByPrefix(prefix: string): string[] {
    const p = prefix.trim().toLowerCase()
    if (!p) return history.value.slice()
    return history.value.filter((h) => h.toLowerCase().startsWith(p))
  }

  /** 清空历史（下拉尾部入口）：持久层 + 内存态同清 */
  function clearHistory() {
    history.value = []
    safeStorage.removeItem(STORAGE_KEY)
  }

  return { history, recordUrl, filterByPrefix, clearHistory }
}
