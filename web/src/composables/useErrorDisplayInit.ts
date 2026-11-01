import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { setMessageApi, setPanelSwitcher } from '@/api/client'
import { usePanelLayout } from '@/composables/usePanelLayout'

// 共享 ref：ConsoleView watch 此 ref 切换子标签
// 在文件顶部声明（不在函数内），让所有调用者共享同一份状态
export const errorConsoleSubTabRequested = ref<'commands' | 'errors' | null>(null)

/**
 * 在 Naive UI provider 内调用一次，把 message API 与面板切换器注入到 axios 拦截器。
 * 必须在 <n-message-provider> 与 <n-dialog-provider> 子树内调用。
 */
export function useErrorDisplayInit(): void {
  const message = useMessage()
  setMessageApi(message)

  const panel = usePanelLayout()

  setPanelSwitcher(() => {
    panel.bottomTab.value = 'console'
    panel.showBottomPanel.value = true
    // markAllRead 由 BottomPanel 的 bottomTab watch 处理（用户访问 Console → 清零）
    // 切到错误子标签：通过共享 ref，ConsoleView 监听
    errorConsoleSubTabRequested.value = 'errors'
  })
}
