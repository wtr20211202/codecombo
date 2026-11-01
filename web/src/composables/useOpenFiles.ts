/**
 * 编辑器打开集组合式（组合根）——P-20261003-98 起按域拆分为 openfiles/ 子模块：
 *
 *   core     核心打开集（双组模型/打开/关闭/切换/关闭栈/项目切换清场）
 *   split    分屏双组（开合/切换/跨组拖签）
 *   tabs     标签条 UI 交互（右键菜单/拖拽排序/固定/溢出）
 *   persist  持久化映射（IndexedDB 草稿 P-6 + 自动保存 P-129）
 *   untitled 未命名草稿域（P-24）
 *   diff     diff 视图域（对比标签/冲突并排/两文件互比）
 *   save     保存链（baseHash 冲突检测/三选对话框/远程写回/编码转码）
 *   external 外部改写重载（OPS_FILES_EXTERNAL_CHANGE 消费）
 *
 * 对外 API 逐字不变（本文件再导出类型，消费方继续从 '@/composables/useOpenFiles'
 * 取一切导出）。域间互不 import，全部跨域引用经 OpenFilesCtx 装配契约
 * （见 openfiles/context.ts 头注）——循环依赖按构造即不可能。
 *
 * 单例纪律：状态是 per-call 的（每次 useOpenFiles() 产出一份独立 ctx/状态），
 * 生产唯一调用点是 useLayoutShell（Layout 组件树经 provide/inject 共享同一
 * 实例，「多调用方共享同一状态」由该装配点保证）；单测 beforeEach 各建新实例
 * 依赖的正是 per-call 语义，不得改为模块级全局状态。
 */
import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import { useNotificationStore } from '../stores/notification'
import { useThemeStore } from '../stores/theme'
import { useFontStore } from '../stores/font'
import { useI18n } from './useI18n'
import { createCore } from './openfiles/core'
import { createSplit } from './openfiles/split'
import { createTabs } from './openfiles/tabs'
import { createPersist } from './openfiles/persist'
import { createUntitled } from './openfiles/untitled'
import { createDiff } from './openfiles/diff'
import { createSave } from './openfiles/save'
import { createExternal } from './openfiles/external'
import type { OpenFilesCtx } from './openfiles/context'
import type { OpenFileHooks } from './openfiles/types'

// 公共类型与 untitled 内部键：入口统一再导出（历史导入路径不变）
export type {
  ClosedFileRecord, DraftOffer, EditorGroup, OpenFile, OpenFileMeta,
  OpenFileHooks, OpenFileOptions,
} from './openfiles/types'
export { UNTITLED_PATH_PREFIX, isUntitledPath } from './openfiles/types'

export function useOpenFiles(hooks?: OpenFileHooks) {
  const projectStore = useProjectStore()
  const notificationStore = useNotificationStore()
  const themeStore = useThemeStore()
  const fontStore = useFontStore()
  const { t } = useI18n()

  const { message, dialog } = createDiscreteApi(['message', 'dialog'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  // 装配：ctx 以空对象起步、各域工厂同步填充（时序安全性论证见 context.ts 头注；
  // 工厂创建期只注册 watch/监听/computed，运行期才解引用，字段后填充无碍）。
  // 各工厂同步串联在 useOpenFiles() 调用栈内，useI18n 等实例上下文不丢失。
  const ctx = {} as OpenFilesCtx
  ctx.t = t
  ctx.message = message
  ctx.dialog = dialog
  ctx.hooks = hooks || {}
  ctx.projectStore = projectStore
  ctx.fontStore = fontStore
  ctx.notificationStore = notificationStore
  createCore(ctx)
  createPersist(ctx)
  createSplit(ctx)
  createTabs(ctx)
  createUntitled(ctx)
  createDiff(ctx)
  createSave(ctx)
  createExternal(ctx)

  return {
    // 状态
    openFiles: ctx.openFiles,
    activeFileIndex: ctx.activeFileIndex,
    // 分屏双组（MVP：组 0 主组 / 组 1 分屏组）
    groups: ctx.groups,
    activeGroup: ctx.activeGroup,
    splitOpen: ctx.splitOpen,
    // 分屏方向（P-20261005-230 正交拆分：horizontal=左右缺省 / vertical=上下）
    splitDirection: ctx.splitDirection,
    allOpenFiles: ctx.allOpenFiles,
    currentFile: ctx.currentFile,
    hasUnsavedChanges: ctx.hasUnsavedChanges,
    // 标签页右键菜单
    tabContextMenuIndex: ctx.tabContextMenuIndex,
    tabContextMenuX: ctx.tabContextMenuX,
    tabContextMenuY: ctx.tabContextMenuY,
    showTabContextMenu: ctx.showTabContextMenu,
    handleTabContextMenu: ctx.handleTabContextMenu,
    closeTabContextMenu: ctx.closeTabContextMenu,
    // 标签拖拽
    draggedTabIndex: ctx.draggedTabIndex,
    onTabDragStart: ctx.onTabDragStart,
    onTabDragOver: ctx.onTabDragOver,
    onTabDragEnd: ctx.onTabDragEnd,
    reorderGroupTabs: ctx.reorderGroupTabs,
    // 键盘移动活跃标签（P-20261005-201，Alt+Shift+←/→ 键位消费）
    moveActiveTab: ctx.moveActiveTab,
    // 标签固定
    togglePinTab: ctx.togglePinTab,
    togglePinTabInGroup: ctx.togglePinTabInGroup,
    // 标签溢出
    isTabOverflow: ctx.isTabOverflow,
    checkTabOverflow: ctx.checkTabOverflow,
    tabOverflowOptions: ctx.tabOverflowOptions,
    // 核心操作
    openFile: ctx.openFile,
    openFileByPath: ctx.openFileByPath,
    openUntitled: ctx.openUntitled,
    // 未命名草稿启动恢复（P-20261003-97 草稿热退出，bootstrap 恢复链消费）
    restoreUntitledDrafts: ctx.restoreUntitledDrafts,
    // 草稿库陈旧对账（P-20261003-152，bootstrap 恢复链消费）
    reconcileStaleDrafts: ctx.reconcileStaleDrafts,
    switchFile: ctx.switchFile,
    switchFileInGroup: ctx.switchFileInGroup,
    cycleActiveTab: ctx.cycleActiveTab,
    openDiffView: ctx.openDiffView,
    openTwoFilesDiff: ctx.openTwoFilesDiff,
    closeFile: ctx.closeFile,
    closeFileInGroup: ctx.closeFileInGroup,
    closeActiveGroupTab: ctx.closeActiveGroupTab,
    saveCurrentFile: ctx.saveCurrentFile,
    saveAllFiles: ctx.saveAllFiles,
    saveCloseFileInGroup: ctx.saveCloseFileInGroup,
    // tab/编辑器右键「放弃未保存修改」（P-20261005-156，VS Code Revert File 对位）
    revertFileInGroup: ctx.revertFileInGroup,
    reloadFileWithEncoding: ctx.reloadFileWithEncoding,
    saveFileWithEncoding: ctx.saveFileWithEncoding,
    updateContent: ctx.updateContent,
    closeOtherTabs: ctx.closeOtherTabs,
    closeOtherTabsInGroup: ctx.closeOtherTabsInGroup,
    closeAllTabs: ctx.closeAllTabs,
    closeAllTabsInGroup: ctx.closeAllTabsInGroup,
    closeSavedTabs: ctx.closeSavedTabs,
    closeSavedTabsInGroup: ctx.closeSavedTabsInGroup,
    closeTabsToRight: ctx.closeTabsToRight,
    closeTabsToRightInGroup: ctx.closeTabsToRightInGroup,
    getUnsavedFiles: ctx.getUnsavedFiles,
    // 分屏操作
    openInSplit: ctx.openInSplit,
    openInSplitByPath: ctx.openInSplitByPath,
    restoreSplitFromPaths: ctx.restoreSplitFromPaths,
    closeSplit: ctx.closeSplit,
    moveTabToGroup: ctx.moveTabToGroup,
    toggleSplit: ctx.toggleSplit,
    // 下方分屏/方向切换（P-20261005-230，键位 splitDown 消费）
    splitDown: ctx.splitDown,
    focusOtherGroup: ctx.focusOtherGroup,
    // 最近关闭重开
    canReopenClosed: ctx.canReopenClosed,
    reopenClosedFile: ctx.reopenClosedFile,
    // 未保存草稿恢复（提示条消费：队首 offer + 恢复/对比预览/丢弃三键动作）
    draftOffer: ctx.draftOffer,
    applyDraftRestore: ctx.applyDraftRestore,
    discardDraftRestore: ctx.discardDraftRestore,
    previewDraftRestore: ctx.previewDraftRestore,
    // 远程文件编辑（P-20261003-15）：离线横幅重试
    retryRemoteFile: ctx.retryRemoteFile,
  }
}
