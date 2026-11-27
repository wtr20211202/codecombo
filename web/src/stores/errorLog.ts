import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ErrorLogEntry } from '@/api/error-types'
import { clearBrowserDiagnostics, projectErrorLogEntry, recordDiagEntry } from '@/utils/browserDiagnostics'

const MAX_ENTRIES = 200

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const useErrorLogStore = defineStore('errorLog', () => {
  const logs = ref<ErrorLogEntry[]>([])
  const unreadCount = ref(0)

  function add(entry: Omit<ErrorLogEntry, 'id' | 'timestamp'>): ErrorLogEntry {
    const full: ErrorLogEntry = {
      ...entry,
      id: genId(),
      timestamp: new Date().toISOString(),
    }
    logs.value.unshift(full)
    if (logs.value.length > MAX_ENTRIES) logs.value.length = MAX_ENTRIES
    unreadCount.value++
    // 浏览器诊断投影（P-20261124-2 S1a②）：错误中心是唯一 HTTP 错误真源，
    // 此处把同一条目投影进诊断环（白名单字段 + URL 模板化）；Vue errorHandler
    // 入账的渲染错误按 script 类记录——不新建第二套 HTTP 环，也不重复捕获
    recordDiagEntry(projectErrorLogEntry(full, full.method === 'VUE' ? 'vue' : 'xhr'))
    return full
  }

  function markAllRead(): void {
    unreadCount.value = 0
  }

  // 错误中心重试成功后把原条目标记已恢复（P-20261003-179）：就地补 recoveredAt，
  // 不动时间戳/未读数/条目顺序——恢复是原条目的状态迁移，不是新账
  function markRecovered(id: string): void {
    const entry = logs.value.find(l => l.id === id)
    if (entry) entry.recoveredAt = new Date().toISOString()
  }

  function clear(): void {
    logs.value = []
    unreadCount.value = 0
    // 诊断环/会话快照同步清（P-20261124-2 S1b b）：实例切换复用本 clear，
    // 跨实例的失败请求/WS 记录不应带到新实例
    clearBrowserDiagnostics()
  }

  return { logs, unreadCount, add, markAllRead, markRecovered, clear }
})
