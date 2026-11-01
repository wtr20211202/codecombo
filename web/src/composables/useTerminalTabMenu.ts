import { ref } from 'vue'
import type { Ref } from 'vue'
import type { TermTab } from './useTerminalTabs'

/**
 * 终端 tab 右键菜单（置顶 / 重命名 / 复制会话 / 复制会话 ID / 关闭 / 批量关闭 /
 * 拖出浮动窗 / 直播分享 / 输出快照分享 / 回放分享 / 导出输出 / 对比输出 /
 * 敏感标记 / 收工摘要）。
 * 从 TerminalView.vue 抽出（债项拆分）。
 */
export type TerminalTabMenuAction = 'pin' | 'rename' | 'duplicate' | 'copySessionId' | 'close' | 'closeOthers' | 'closeRight' | 'closeAll' | 'float' | 'liveShare' | 'frozenShare' | 'replayShare' | 'exportOutput' | 'compareOutput' | 'markSensitive' | 'wrapUp' | 'bookmarkList'

export function useTerminalTabMenu(options: {
  tabs: Ref<TermTab[]>
  selectTab: (id: string) => void
  startRename: (tab: TermTab) => void
  requestCloseTab: (id: string) => Promise<void> | void
  closeOtherTabs: (id: string) => Promise<void> | void
  closeRightTabs: (id: string) => Promise<void> | void
  closeAllTabs: () => Promise<void> | void
  /** 拖出浮动窗 / 收回面板（按当前浮动状态二选一） */
  toggleFloatTab: (tab: TermTab) => void
  /** 直播分享（P-20261003-306）：tab.id 即终端会话 ID，创建只读直播短链 */
  liveShareTab?: (tab: TermTab) => void
  /** 输出快照分享（P-20261005-205）：tab.id 即终端会话 ID，创建时刻输出定格短链 */
  frozenShareTab?: (tab: TermTab) => void
  /** 回放分享（P-20261004-103）：tab.id 即终端会话 ID——取该会话最近一次
   *  过程录制生成只读回放短链（异步 walkthrough） */
  replayShareTab?: (tab: TermTab) => void
  /** 导出输出（P-20261003-100）：tab.id 即终端会话 ID，服务端 scrollback 链直出 txt 留档 */
  exportOutputTab?: (tab: TermTab) => void
  /** 对比输出（P-20261005-210）：tab.id 即终端会话 ID（diff 左侧=当前会话），
   *  弹会话选择浮层后双取数进 DiffEditor 快照对比 */
  compareOutputTab?: (tab: TermTab) => void
  /** 敏感标记切换（P-20261003-155）：tab.id 即终端会话 ID，落会话元数据 */
  toggleSensitiveTab?: (tab: TermTab) => void
  /** 敏感标记读数（菜单文案「标记敏感/取消敏感标记」按它翻转） */
  isTabSensitive?: (id: string) => boolean
  /** 置顶切换（P-20261004-53）：tab.id 即终端会话 ID，纯前端显示偏好 */
  togglePinTab?: (tab: TermTab) => void
  /** 置顶读数（菜单文案「置顶/取消置顶」按它翻转） */
  isTabPinned?: (id: string) => boolean
  /** 收工摘要（P-20261004-35）：tab.id 即终端会话 ID，命令账本聚合 + 最近进度 */
  wrapUpTab?: (tab: TermTab) => void
  /** 复制会话（P-20261004-1）：tab.id 即终端会话 ID，取源会话创建配置
   *  （projectId/kind/dir/runtime）建同配置新会话并激活 */
  duplicateTab?: (tab: TermTab) => void
  /** 复制会话 ID（P-20261004-123）：tab.id 即终端会话 ID——协作协议的地址
   *  （agent 收件箱/接续链/ui.snapshot 归属/任务进度跳转全用它），一键入剪贴板 */
  copySessionIdTab?: (tab: TermTab) => void
  /** 书签列表（P-20261004-16）：tab.id 即终端会话 ID，面板展示该会话的
   *  scrollback 书签（内存态），点击行滚动定位 */
  openBookmarkListTab?: (tab: TermTab) => void
}) {
  const { tabs, selectTab, startRename, requestCloseTab, closeOtherTabs, closeRightTabs, closeAllTabs, toggleFloatTab, liveShareTab, frozenShareTab, replayShareTab, exportOutputTab, compareOutputTab, toggleSensitiveTab, isTabSensitive, togglePinTab, isTabPinned, wrapUpTab, duplicateTab, copySessionIdTab, openBookmarkListTab } = options

  const tabContextMenu = ref<{ x: number; y: number; tabId: string } | null>(null)

  function showTabContextMenu(e: MouseEvent, tab: TermTab): void {
    e.preventDefault()
    selectTab(tab.id)
    tabContextMenu.value = { x: e.clientX, y: e.clientY, tabId: tab.id }
  }
  function closeTabContextMenu(): void {
    tabContextMenu.value = null
  }
  // 全局 capture click：点击非菜单区域时关闭。
  // 守卫必须存在：capture 先于菜单项自身的 click 触发，若无守卫，点击菜单项时
  // 菜单先被关闭卸载，事件传到按钮时 emit 对已卸载实例静默失效（菜单永远无响应）
  function closeTabContextMenuOnGlobal(e: MouseEvent): void {
    if (!tabContextMenu.value) return
    const target = e.target as HTMLElement | null
    if (target && target.closest('.term-tab-context-menu')) return
    tabContextMenu.value = null
  }
  /** 右键菜单目标 tab 的敏感标记态（文案翻转用；无读数回调 = 未标记） */
  function menuTabSensitive(): boolean {
    return isTabSensitive?.(tabContextMenu.value?.tabId ?? '') === true
  }
  /** 右键菜单目标 tab 的置顶态（文案翻转用；无读数回调 = 未置顶） */
  function menuTabPinned(): boolean {
    return isTabPinned?.(tabContextMenu.value?.tabId ?? '') === true
  }
  async function handleTabContextAction(action: TerminalTabMenuAction): Promise<void> {
    const tabId = tabContextMenu.value?.tabId
    if (!tabId) return
    closeTabContextMenu()
    if (action === 'rename') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) startRename(tab)
    } else if (action === 'pin') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) togglePinTab?.(tab)
    } else if (action === 'close') {
      void requestCloseTab(tabId)
    } else if (action === 'closeOthers') {
      void closeOtherTabs(tabId)
    } else if (action === 'closeRight') {
      void closeRightTabs(tabId)
    } else if (action === 'closeAll') {
      void closeAllTabs()
    } else if (action === 'float') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) toggleFloatTab(tab)
    } else if (action === 'liveShare') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) liveShareTab?.(tab)
    } else if (action === 'frozenShare') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) frozenShareTab?.(tab)
    } else if (action === 'replayShare') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) replayShareTab?.(tab)
    } else if (action === 'exportOutput') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) exportOutputTab?.(tab)
    } else if (action === 'compareOutput') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) compareOutputTab?.(tab)
    } else if (action === 'markSensitive') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) toggleSensitiveTab?.(tab)
    } else if (action === 'wrapUp') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) wrapUpTab?.(tab)
    } else if (action === 'duplicate') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) duplicateTab?.(tab)
    } else if (action === 'copySessionId') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) copySessionIdTab?.(tab)
    } else if (action === 'bookmarkList') {
      const tab = tabs.value.find(t => t.id === tabId)
      if (tab) openBookmarkListTab?.(tab)
    }
  }

  return {
    tabContextMenu,
    showTabContextMenu,
    closeTabContextMenu,
    closeTabContextMenuOnGlobal,
    handleTabContextAction,
    menuTabSensitive,
    menuTabPinned,
  }
}
