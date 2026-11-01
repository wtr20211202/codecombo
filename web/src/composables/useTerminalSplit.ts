import { ref } from 'vue'
import type { Ref } from 'vue'
import type { TermTab } from './useTerminalTabs'
import { useLayoutLockStore } from '../stores/layoutLock'

/**
 * 分屏（split panes）交互状态与操作：
 * - 开关分屏走 useTerminalTabs 的 splitTab/requestClosePane/setActivePane（tabs 数据源唯一）
 * - 本组合式函数负责 divider 拖拽 / 键盘调整 / 50-50 重置 / pane fit 等纯交互
 * 从 TerminalView.vue 抽出（债项拆分：视图组件只做装配与模板）
 */
export function useTerminalSplit(options: {
  tabs: Ref<TermTab[]>
  activeTabId: Ref<string>
  termInstances: Map<string, { fit: { fit(): void } }>
  splitTab: (tab: TermTab, direction: 'horizontal' | 'vertical') => Promise<void>
  // pane 关闭统一过 tabs 域的条件保全入口（P-20261004-145）：running 的
  // secondary 弹两选弹层而非直接处决；闲 pane / primary / 单 pane 直拆——
  // 与 × 按钮（requestCloseTab）同判，键路径不再各杀各的
  requestClosePane: (tab: TermTab, paneId: string) => Promise<void>
  setActivePane: (tab: TermTab, paneId: string) => void
}) {
  const { tabs, activeTabId, termInstances, splitTab, requestClosePane, setActivePane } = options

  /** 开当前活动 tab 的分屏 */
  function splitActiveTab(direction: 'horizontal' | 'vertical'): void {
    const tab = tabs.value.find((t) => t.id === activeTabId.value)
    if (!tab) return
    void splitTab(tab, direction)
  }

  /** 关当前活动 pane：split 模式关 active pane；非 split 关整个 tab */
  function closeActivePane(): void {
    const tab = tabs.value.find((t) => t.id === activeTabId.value)
    if (!tab) return
    const paneId = (tab.panes && tab.panes.length >= 2 && tab.activePaneId) || tab.id
    void requestClosePane(tab, paneId)
  }

  /** pane 焦点切换：点击 pane 容器时更新 activePaneId */
  function handlePaneClick(tab: TermTab, paneId: string): void {
    if (tab.activePaneId !== paneId) {
      setActivePane(tab, paneId)
    }
  }

  /**
   * 键盘切换 pane（P-20261004-111，编辑器组 focusOtherGroup 同款对称）：按键
   * pane 所在 tab 内切到对侧 pane。以按键 pane 为基准而非 activePaneId——浮动
   * 窗聚焦时 activeTabId 可能指向别的 tab，activePaneId 与实际焦点 pane 也可短
   * 暂失步，按键 pane 才是用户意图锚点。切换走 setActivePane 既有收口（fit +
   * 滚动区重同步 + xterm focus 链）。
   * @returns 是否完成切换——单 pane（无 split）返回 false，键位链放行 PTY
   */
  function focusOtherPane(sessionId: string): boolean {
    const tab = tabs.value.find((t) => t.id === sessionId || t.panes?.includes(sessionId))
    if (!tab?.panes || tab.panes.length < 2) return false
    const other = sessionId === tab.id ? tab.panes[1] : tab.id
    if (!other) return false
    setActivePane(tab, other)
    return true
  }

  // divider 拖拽：调整两 pane 的相对大小（CSS 变量 --term-split-first 控制）
  // 拖动期间把当前比例写入 splitResizing（驱动比例浮层显示）
  const splitResizing = ref<{ first: number; second: number; tabId: string } | null>(null)

  function startPaneResize(e: MouseEvent, tab: TermTab): void {
    if (!tab.panes || tab.panes.length < 2 || !tab.paneDirection) return
    // 布局锁定（P-20261003-180）：拖拽类交互统一短路，键盘调整（onDividerKeydown）不受影响
    if (useLayoutLockStore().interceptDrag(e)) return
    e.preventDefault()
    const container = (e.currentTarget as HTMLElement).parentElement
    if (!container) return
    const containerEl: HTMLElement = container
    const direction = tab.paneDirection
    const startCoord = direction === 'horizontal' ? e.clientX : e.clientY
    const rect = containerEl.getBoundingClientRect()
    const totalSize = direction === 'horizontal' ? rect.width : rect.height
    const startFirst = parseFloat(
      getComputedStyle(containerEl).getPropertyValue('--term-split-first') || '50',
    )

    function onMove(ev: MouseEvent) {
      const currentCoord = direction === 'horizontal' ? ev.clientX : ev.clientY
      const deltaPct = ((currentCoord - startCoord) / totalSize) * 100
      const firstPct = Math.max(20, Math.min(80, startFirst + deltaPct))
      containerEl.style.setProperty('--term-split-first', `${firstPct}%`)
      containerEl.style.setProperty('--term-split-second', `${100 - firstPct}%`)
      splitResizing.value = { first: firstPct, second: 100 - firstPct, tabId: tab.id }
      fitAllPanes(tab)
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      splitResizing.value = null
      fitAllPanes(tab)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // 拖拽 / 双击重置后，把 split 内所有 pane fit 一遍防止文字被裁剪
  function fitAllPanes(tab: TermTab): void {
    tab.panes?.forEach((pid) => {
      const inst = termInstances.get(pid)
      try { inst?.fit.fit() } catch { /* ignore */ }
    })
  }

  // 双击 divider 重置 50/50
  function resetPaneSplit(tab: TermTab): void {
    if (!tab.panes || tab.panes.length < 2) return
    const container = document.querySelector(`.term-pane-layout[data-tab-id="${tab.id}"]`) as HTMLElement | null
    if (!container) return
    container.style.setProperty('--term-split-first', '50%')
    container.style.setProperty('--term-split-second', '50%')
    fitAllPanes(tab)
  }

  // divider 键盘操作：方向键调整 5%，Enter/Space 重置 50/50
  function onDividerKeydown(e: KeyboardEvent, tab: TermTab): void {
    if (!tab.panes || tab.panes.length < 2) return
    const container = document.querySelector(`.term-pane-layout[data-tab-id="${tab.id}"]`) as HTMLElement | null
    if (!container) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      resetPaneSplit(tab)
      return
    }
    const current = parseFloat(getComputedStyle(container).getPropertyValue('--term-split-first') || '50')
    const step = e.shiftKey ? 10 : 5
    // 水平 divider（左右）：ArrowLeft 减小第一 pane / ArrowRight 增大；垂直同理
    const isHorizontal = tab.paneDirection === 'horizontal'
    let next: number
    if ((isHorizontal && e.key === 'ArrowLeft') || (!isHorizontal && e.key === 'ArrowUp')) next = current - step
    else if ((isHorizontal && e.key === 'ArrowRight') || (!isHorizontal && e.key === 'ArrowDown')) next = current + step
    else return
    e.preventDefault()
    next = Math.max(20, Math.min(80, next))
    container.style.setProperty('--term-split-first', `${next}%`)
    container.style.setProperty('--term-split-second', `${100 - next}%`)
    fitAllPanes(tab)
  }

  return {
    splitResizing,
    splitActiveTab,
    closeActivePane,
    handlePaneClick,
    focusOtherPane,
    startPaneResize,
    resetPaneSplit,
    onDividerKeydown,
    fitAllPanes,
  }
}
