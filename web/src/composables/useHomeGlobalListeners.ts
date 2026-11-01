import { onMounted, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import { useLockStore } from '../stores/lock'
import { OPEN_SETTINGS_EVENT } from '../utils/openSettings'
import { OPEN_HELP_EVENT } from '../utils/openHelp'
import { matchShortcut } from '../utils/shortcut'
import { OPS_PROJECTS_CHANGED } from '../utils/opsEvents'

/**
 * 首页全局监听（自 HomeView 抽出）：
 * - 锁定快捷键（设置弹窗打开时不拦截）
 * - OPEN_SETTINGS_EVENT → 打开设置弹窗
 * - OPEN_HELP_EVENT → 打开帮助中心（锚点条目由 HelpCenter 监听同一事件自行消化）
 * - OPS_PROJECTS_CHANGED → 项目清单变化联动刷新
 */
export function useHomeGlobalListeners(options: {
  showSettingsModal: Ref<boolean>
  showHelpCenter?: Ref<boolean>
  onProjectsChanged: () => void
  onShortcutsHelp: () => void
}) {
  const lockStore = useLockStore()

  function handleHomeViewKeyDown(e: KeyboardEvent) {
    if (options.showSettingsModal.value) return
    if (lockStore.lockShortcut && matchShortcut(e, lockStore.lockShortcut)) {
      e.preventDefault()
      void lockStore.lock()
      return
    }
    // Ctrl/Cmd+, 打开设置：与项目页全局快捷键对齐（VS Code 惯例）；
    // 锁定态门控同 Round 231（快捷键不穿透锁屏）
    if (lockStore.isLocked) return
    const isMod = e.ctrlKey || e.metaKey
    if (isMod && !e.shiftKey && e.key === ',') {
      e.preventDefault()
      options.showSettingsModal.value = true
      return
    }
    // ?（Shift+/）呼出快捷键备忘单：与项目页惯例对齐（焦点不在输入框时）
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      options.onShortcutsHelp()
    }
  }

  function onOpenSettingsRequest() {
    options.showSettingsModal.value = true
  }

  function onOpenHelpRequest() {
    if (options.showHelpCenter) options.showHelpCenter.value = true
  }

  function onOpsProjectsChanged() {
    options.onProjectsChanged()
  }

  onMounted(() => {
    document.addEventListener('keydown', handleHomeViewKeyDown)
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsRequest)
    window.addEventListener(OPEN_HELP_EVENT, onOpenHelpRequest)
    window.addEventListener(OPS_PROJECTS_CHANGED, onOpsProjectsChanged)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleHomeViewKeyDown)
    window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsRequest)
    window.removeEventListener(OPEN_HELP_EVENT, onOpenHelpRequest)
    window.removeEventListener(OPS_PROJECTS_CHANGED, onOpsProjectsChanged)
  })
}
