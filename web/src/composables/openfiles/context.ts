/**
 * useOpenFiles 域拆分（P-20261003-98）：域间装配契约（OpenFilesCtx）。
 *
 * 各域模块（core/split/tabs/persist/untitled/diff/save/external）互不 import——
 * 全部跨域引用经本接口走同一份 ctx 对象（组合根 useOpenFiles.ts 创建并按域填充）。
 * 这样设计的「为什么」：
 * 1. 循环依赖按构造即不可能（import-x/no-cycle 门禁零命中），域间关系全部
 *    在本文件一处可读（谁依赖谁看字段分组即可）；
 * 2. useOpenFiles 是 per-call 状态（生产唯一调用点 useLayoutShell、单测
 *    beforeEach 各建新实例）——ctx 由每次调用独立创建，域函数只经 ctx 触达
 *    状态，「多调用方共享同一状态」的单例纪律由组合根保证，不靠模块级全局；
 * 3. 填充时序：ctx 以 `{} as OpenFilesCtx` 起步、各工厂同步填充后才从
 *    useOpenFiles() 返回；所有工厂在「创建期」只注册（watch/事件监听/computed
 *    均惰性），对 ctx 函数与状态的解引用全部发生在运行期（装配完成后），
 *    故字段后填充是安全的——这一前提是各域模块的共同纪律。
 */
import type { ComputedRef, Ref, WritableComputedRef } from 'vue'
import type { Composer } from 'vue-i18n'
import { createDiscreteApi } from 'naive-ui'
import type { useFontStore } from '../../stores/font'
import type { useNotificationStore } from '../../stores/notification'
import type { useProjectStore } from '../../stores/project'
import type {
  ClosedFileRecord, DraftOffer, EditorGroup, OpenFile, OpenFileHooks,
  OpenFileOptions, SplitDirection, WriteFileResult,
} from './types'

export type ProjectStore = ReturnType<typeof useProjectStore>
export type FontStore = ReturnType<typeof useFontStore>
export type NotificationStore = ReturnType<typeof useNotificationStore>
/** createDiscreteApi(['message', 'dialog']) 的返回切片（组合根创建、全域共用） */
type DiscreteMessageDialog = ReturnType<typeof createDiscreteApi<'message' | 'dialog'>>

/** 标签溢出下拉选项（tabs 域产出，宿主 naive-ui dropdown 消费） */
export interface TabOverflowOption {
  label: string
  key: string
  props: { style?: { fontWeight: number } | undefined }
}

export interface OpenFilesCtx {
  // ── 装配基础设施（组合根填充）──
  t: Composer['t']
  message: DiscreteMessageDialog['message']
  dialog: DiscreteMessageDialog['dialog']
  hooks: OpenFileHooks
  projectStore: ProjectStore
  fontStore: FontStore
  notificationStore: NotificationStore

  // ── 核心打开集状态（core 填充）──
  groups: Ref<EditorGroup[]>
  activeGroup: Ref<number>
  splitOpen: Ref<boolean>
  /** 组 0 兼容视图（uiState 持久化与既有单测锚点） */
  openFiles: WritableComputedRef<OpenFile[]>
  activeFileIndex: WritableComputedRef<number>
  allOpenFiles: ComputedRef<OpenFile[]>
  currentFile: ComputedRef<OpenFile | null>
  hasUnsavedChanges: ComputedRef<boolean>
  closedFiles: Ref<ClosedFileRecord[]>
  canReopenClosed: ComputedRef<boolean>

  // ── 标签条 UI 状态（tabs 填充）──
  tabContextMenuIndex: Ref<number>
  tabContextMenuX: Ref<number>
  tabContextMenuY: Ref<number>
  showTabContextMenu: Ref<boolean>
  draggedTabIndex: Ref<number | null>
  isTabOverflow: Ref<boolean>
  tabOverflowOptions: ComputedRef<TabOverflowOption[]>

  // ── 持久化状态（persist 填充：IndexedDB 草稿 + 自动保存挂起态）──
  draftOffers: Ref<DraftOffer[]>
  draftOffer: ComputedRef<DraftOffer | null>
  /** 409 待裁决熔断集：冲突对话框未裁决前停掉该路径的自动保存
   *  （关闭文件/保存收尾/读盘回净态等处按路径解除） */
  autoSaveBlocked: Set<string>

  // ── 核心打开集（core 填充）──
  groupAt: (gi: number) => EditorGroup
  findOpenFile: (path: string) => { gi: number; idx: number } | null
  isPathOpenElsewhere: (path: string, exceptGi: number) => boolean
  openFileInto: (gi: number, file: { path: string; name: string }, opts?: OpenFileOptions) => Promise<void>
  openFile: (file: { path: string; name: string }, opts?: OpenFileOptions) => Promise<void>
  openFileByPath: (filePath: string, opts?: OpenFileOptions) => Promise<void>
  reopenClosedFile: () => Promise<void>
  switchFileInGroup: (gi: number, index: number) => void
  switchFile: (index: number) => void
  cycleActiveTab: (delta: number) => void
  closeActiveGroupTab: () => void
  closeFileInGroup: (gi: number, index: number) => Promise<void>
  closeFile: (index: number) => Promise<void>
  closeOtherTabsInGroup: (gi: number, idx: number) => Promise<void>
  closeOtherTabs: (idx: number) => Promise<void>
  closeAllTabsInGroup: (gi: number) => Promise<void>
  closeAllTabs: () => Promise<void>
  closeSavedTabsInGroup: (gi: number) => Promise<void>
  closeSavedTabs: () => Promise<void>
  closeTabsToRightInGroup: (gi: number, idx: number) => Promise<void>
  closeTabsToRight: (idx: number) => Promise<void>
  getUnsavedFiles: () => OpenFile[]
  updateContent: (path: string, content: string) => void
  retryRemoteFile: (path: string) => Promise<void>

  // ── 分屏双组（split 填充）──
  /** 分屏方向（core 填充，P-20261005-230）：缺省 horizontal = P-13 既有行为 */
  splitDirection: Ref<SplitDirection>
  /** direction 缺省 = 不改当前方向；分屏未开时落横向（P-13「右侧」既有语义） */
  openInSplit: (file: { path: string; name: string }, direction?: SplitDirection) => Promise<void>
  openInSplitByPath: (filePath: string, direction?: SplitDirection) => Promise<void>
  restoreSplitFromPaths: (paths: string[], activeFile?: string) => Promise<void>
  closeSplit: () => void
  moveTabToGroup: (fromGi: number, path: string, toGi: number, copy?: boolean) => Promise<void>
  toggleSplit: () => Promise<void>
  /** 下方分屏/方向切换（P-20261005-230）：未分屏以活跃文件开纵向分屏；已开
   *  异方向切纵向、同向再按取消拆分（终端 splitTab toggle 语义对称） */
  splitDown: () => Promise<void>
  focusOtherGroup: () => void

  // ── 标签条 UI 交互（tabs 填充）──
  handleTabContextMenu: (e: MouseEvent, idx: number) => void
  closeTabContextMenu: () => void
  onTabDragStart: (idx: number) => void
  onTabDragOver: (e: DragEvent, idx: number) => void
  onTabDragEnd: () => void
  reorderGroupTabs: (gi: number, from: number, to: number) => void
  /** 键盘移动活跃标签（P-20261005-201，Alt+Shift+←/→ 键位）：delta -1 前 /
   *  1 后，组内到头静默停（复用 reorderGroupTabs 归位链） */
  moveActiveTab: (delta: number) => void
  togglePinTab: (idx: number) => void
  togglePinTabInGroup: (gi: number, idx: number) => void
  checkTabOverflow: (el: HTMLElement | null) => void

  // ── 持久化（persist 填充：草稿落库/恢复探测 + 自动保存排程）──
  clearFileDraft: (projectId: string, path: string) => void
  scheduleDraftWrite: (file: OpenFile) => void
  probeDraftRestore: (projectId: string, file: OpenFile) => Promise<void>
  applyDraftRestore: (projectId: string, path: string) => void
  discardDraftRestore: (projectId: string, path: string) => void
  /** 草稿对比预览（P-20261004-71，提示条第三键）：草稿 vs 磁盘现内容并排
   *  diff（openDiffView 左直供右现拉）；只读动作，不消费 offer */
  previewDraftRestore: (projectId: string, path: string) => Promise<void>
  /** 草稿库陈旧对账（P-20261003-152）：文件已删除的草稿清账 + 一条汇总提示；
   *  bootstrap 恢复链在项目恢复落地后调用（项目不可达整段跳过防误清） */
  reconcileStaleDrafts: () => Promise<void>
  cancelAutoSave: (path: string) => void
  scheduleAutoSave: (file: OpenFile) => void
  /** 项目切换清场用：取消全部挂起自动保存防抖并解除 409 熔断 */
  cancelAllAutoSave: () => void

  // ── 未命名草稿域（untitled 填充）──
  openUntitled: () => void
  saveUntitledAs: (file: OpenFile) => Promise<void>
  /** 启动恢复 untitled 草稿（P-20261003-97 草稿热退出）：读当前项目 untitled
   *  命名空间记录重建草稿 tab（编号重新分配）+ toast；bootstrap 恢复链在
   *  项目恢复落地后调用 */
  restoreUntitledDrafts: () => Promise<void>

  // ── diff 视图域（diff 填充）──
  openDiffView: (params: { path: string; name: string; oldRef: string; newRef?: string; leftContent?: string; oldLabel?: string; rightContent?: string }) => Promise<void>
  openTwoFilesDiff: (params: { basePath: string; baseName: string; targetPath: string; targetName: string }) => Promise<boolean>
  /** 冲突对话框「并排对比」两入口（save 域消费） */
  openConflictDiff: (file: OpenFile) => void
  openRemoteConflictDiff: (file: OpenFile) => Promise<void>

  // ── 保存链（save 填充）──
  saveCurrentFile: () => Promise<void>
  saveAllFiles: () => Promise<{ saved: number; failed: number }>
  writeOpenFile: (file: OpenFile, opts?: { force?: boolean; toast?: boolean }) => Promise<WriteFileResult>
  /** 脏点「保存并关闭」（P-20261003-138）：保存该文件并关闭其标签；
   *  关闭复用 core 的 closeFileInGroup（跨域经本契约触达） */
  saveCloseFileInGroup: (gi: number, index: number) => Promise<void>
  /** tab/编辑器右键「放弃未保存修改」（P-20261005-156，VS Code Revert File
   *  对位）：脏 buffer 回磁盘/远端当前内容（loadDiskVersion/loadRemoteVersion
   *  全链；仅脏文件可达，untitled/diff 不提供） */
  revertFileInGroup: (gi: number, index: number) => Promise<void>
  reloadFileWithEncoding: (encoding: string) => Promise<void>
  saveFileWithEncoding: (encoding: string) => Promise<void>
}
