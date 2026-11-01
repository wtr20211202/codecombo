import { nextTick } from 'vue'
import type { Ref } from 'vue'

/**
 * 终端工具栏动作（「更多」菜单与两级最大化切换的宿主实现）：
 * 清屏/刷新/重启/全量复制/导出/最大化。pane 动作经 paneRefs 下发，
 * fit 刷新经共享 termInstances；重启复用 useTerminalTabs.restartTerminal。
 * 从 TerminalView.vue 抽出（债项拆分）。
 */
export function useTerminalToolbarActions(options: {
  tabs: Ref<Array<{ id: string; name: string }>>
  activeTabId: Ref<string>
  paneRefs: Map<string, {
    clear(): void
    copyAll(): void
    exportAsText(name: string): void
    fit(deep?: boolean): void
    focus(): void
  }>
  termInstances: Map<string, { fit: { fit(): void }; term: { focus(): void } }>
  restartTerminal: (tab: { id: string }) => Promise<void>
  maximizeTerminal: () => void
  maximizeBottomPanelEditor: () => void
}) {
  const { tabs, activeTabId, paneRefs, termInstances, restartTerminal } = options

  function fitAllInstances() {
    nextTick(() => {
      termInstances.forEach(({ fit }) => {
        try { fit.fit() } catch { /* ignore */ }
      })
    })
  }

  function toggleMaximize() {
    options.maximizeTerminal()
    fitAllInstances()
  }

  // 切换 BottomPanel 编辑器区域最大化（与 BottomPanel 顶部按钮等价）：
  // 终端会随整个底部面板覆盖到编辑器区域
  function toggleEditorMaximize() {
    options.maximizeBottomPanelEditor()
    fitAllInstances()
  }

  function clearActiveTerminal() {
    paneRefs.get(activeTabId.value)?.clear()
  }

  // 刷新终端显示：走 TerminalPane.fit(true) 深度链路（safeFit 按当前窗口尺寸
  // 重算行列 + xterm 滚动区 refresh + 行数抖动强制滚动区重同步 + 权威重绘
  // redrawCall）——v6 视口的滚动区尺寸只由真实 resize 重算，refresh 对失步
  // 无效，抖动是与拖窗口/F12 等效的唯一可编程自愈。不重放历史——业界 web
  // 终端（VS Code/Hyper/Tabby/wetty/ttyd）均不持久化终端内容，
  // "刷新显示历史"是 tmux 才有的能力（Unix 限定，refresh-client 重发整屏）
  function refreshActiveTerminal() {
    const tabId = activeTabId.value
    if (!tabId) return
    const pane = paneRefs.get(tabId)
    if (!pane) return
    pane.fit(true)
    pane.focus()
  }

  // 重启当前活动 tab 的 shell：close + 同名 create 复用 tab 位置
  function restartActiveShell() {
    const tabId = activeTabId.value
    if (!tabId) return
    const tab = tabs.value.find((tb) => tb.id === tabId)
    if (!tab) return
    void restartTerminal(tab)
  }

  function copyAllForActive() {
    paneRefs.get(activeTabId.value)?.copyAll()
  }

  function exportActiveAsText() {
    const tab = tabs.value.find((tb) => tb.id === activeTabId.value)
    paneRefs.get(activeTabId.value)?.exportAsText(tab?.name || 'terminal')
  }

  // 「更多」菜单动作分发（clear | refresh | restart | copyAll | export | maxEditor | maxPanel）
  function onMoreSelect(key: string): void {
    switch (key) {
      case 'clear': clearActiveTerminal(); break
      case 'refresh': refreshActiveTerminal(); break
      case 'restart': restartActiveShell(); break
      case 'copyAll': copyAllForActive(); break
      case 'export': exportActiveAsText(); break
      case 'maxEditor': toggleEditorMaximize(); break
      case 'maxPanel': toggleMaximize(); break
    }
  }

  return {
    onMoreSelect,
    toggleMaximize,
    toggleEditorMaximize,
    clearActiveTerminal,
    refreshActiveTerminal,
    restartActiveShell,
    copyAllForActive,
    exportActiveAsText,
  }
}
