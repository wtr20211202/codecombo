import { defineStore } from 'pinia'
import { ref } from 'vue'

// 终端 tabs 状态在 TerminalView.vue 内部维护（不全面重构）
// 本 store 仅提供跨组件的"切到指定 tab"信号通道：
// - notification store 设 pendingSwitch
// - TerminalView.vue watch pendingSwitch，命中时 selectTab + focus
export const useTerminalStore = defineStore('terminal', () => {
  // 待切换到的终端 sessionId；null 表示无待消费请求
  const pendingSwitch = ref<string | null>(null)

  function requestSwitch(sessionId: string) {
    pendingSwitch.value = sessionId
  }

  function consume() {
    pendingSwitch.value = null
  }

  return { pendingSwitch, requestSwitch, consume }
})
