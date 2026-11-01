import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface CommandLog {
  command: string
  args: string
  output: string
  error: string
  workDir: string
  timestamp: string
}

export const useConsoleStore = defineStore('console', () => {
  const logs = ref<CommandLog[]>([])
  const maxLogs = 200

  function addLog(log: CommandLog) {
    logs.value.push(log)
    // 限制最大数量：使用 splice 就地移除多余元素，避免 slice 创建新数组的拷贝开销
    if (logs.value.length > maxLogs) {
      logs.value.splice(0, logs.value.length - maxLogs)
    }
  }

  function clear() {
    logs.value = []
  }

  return { logs, addLog, clear }
})
