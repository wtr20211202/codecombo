import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ErrorLogEntry } from '@/api/error-types'

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
  }

  return { logs, unreadCount, add, markAllRead, markRecovered, clear }
})
