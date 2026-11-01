// useLayoutShell Layout 装配枢纽（roadmap M3.1）：把原 Layout.vue script 的
// 全部装配胶水（store 实例化 / 面板宿主 / 键盘监听 / 引导恢复 / 生命周期挂载）
// 收敛到一个组合式，Layout.vue 只保留模板编排。
// 本文件只做「接线」——业务逻辑在各自 composable/store 内，禁止在此新增行为。
import { onMounted, onBeforeUnmount, ref, computed, watch, nextTick, provide, getCurrentScope, onScopeDispose } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import { useNotificationStore } from '../stores/notification'
import { usePreviewPortStore } from '../stores/previewPort'
import { OPS_PANEL, OPS_REMOTE_OPEN_IN_EDITOR, OPS_SHARE_DROP, type RemoteOpenInEditorDetail, type ShareDropDetail } from '../utils/opsEvents'
import { buildRemoteEditorPath } from '../utils/remoteEditorPath'
import { activateRailPanel, railPanelCount } from '../panels/registry'
import { toggleablePanelIds } from '../panels/registry'
import { openSettingsTab } from '../utils/openSettings'
import { prefetchMonacoLanguageWorkers } from '../utils/monacoWorkerPrefetch'
import { safeStorage } from '../utils/storage'
import { recordFileUsage, removeFileUsage } from '../utils/paletteUsage'
import { setMonacoModelOpenPathProvider, clearMonacoModelOpenPathProvider } from '../views/editor/monacoModelOpenSet'

import { useWebSocket } from './useWebSocket'
import { useWsDisconnectBar } from './useWsDisconnectBar'
import { useFontStore } from '../stores/font'
import { useI18n } from './useI18n'
import { useWorkspaceSnapshot } from './useWorkspaceSnapshot'
import { OPS_COLLAPSE_TREE, type CollapseTreeDetail } from '../utils/opsEvents'
import { useChangesStore } from '../stores/changes'
import { useUIStateStore } from '../stores/uiState'
import { useInstanceStore } from '../stores/instance'
import { usePostmortemStore } from '../stores/postmortem'
import { useGitFailHintStore, isGitFailHintFresh } from '../stores/gitFailHint'
import { useThemeFont } from './useThemeFont'
import { usePanelLayout, restoreDshConsoleOnce } from './usePanelLayout'
import { useAgentTerminal } from './useAgentTerminal'
import { useAgentFix } from './useAgentFix'
import { useCronRetry } from './useCronRetry'
import { useStashRecover } from './useStashRecover'
import { useQuickdrop } from './useQuickdrop'
import { useShareDrop } from './useShareDrop'
import { bumpDirectInputShares } from './useDirectInputShares'
import { useQuickNav } from './useQuickNav'
import { useOpenFiles, isUntitledPath } from './useOpenFiles'
import { useRecentFiles } from './useRecentFiles'
import { useRemoteRecentFiles } from './useRemoteRecentFiles'
import { useProjectActions } from './useProjectActions'
import { useFetchAll } from './useFetchAll'
import { useLayoutState } from './useLayoutState'
import { useErrorDisplayInit } from './useErrorDisplayInit'
import { useLayoutKeyboard } from './useLayoutKeyboard'
import { useLayoutBootstrap } from './useLayoutBootstrap'
import { useApprovalActions } from './useApprovalActions'
import { requestTerminalOutputLocate } from './terminalOutputLocate'
import { useLayoutPanelResize } from './useLayoutPanelResize'
import { useLockStore } from '../stores/lock'
import TopBar from '../components/layout/TopBar.vue'
import EditorArea from '../components/layout/EditorArea.vue'
import BottomPanel from '../components/layout/BottomPanel.vue'
import SidePanel from '../components/layout/SidePanel.vue'
import { useLayoutBridge } from './useLayoutBridge'
import { useLayoutViews } from './useLayoutViews'
import { usePresentMode } from './usePresentMode'
import { flushSessionReplayDeepLink } from './useSessionReplayDeepLink'
import { startUiSnapshotReporter } from './useUiSnapshotReporter'
import { copyText } from '../utils/clipboard'
import { watchFallbackApi } from '../api/domains/system'
import { shareApi } from '../api/domains/share'

export function useLayoutShell() {
  const router = useRouter()
  const projectStore = useProjectStore()
  const message = useMessage()
  const changesStore = useChangesStore()
  const fontStore = useFontStore()
  const { t } = useI18n()
  const uiStateStore = useUIStateStore()
  const instanceStore = useInstanceStore()
  const lockStore = useLockStore()
  const { pushRecent, removeRecent } = useRecentFiles()
  // 远程文件「最近打开」清单（P-20261004-137）：远程打开/保存成功即记录，
  // Quick Open 远程层从该单例派生（useQuickNav 内部同源读取）
  const { pushRemoteRecent, removeRemoteRecent } = useRemoteRecentFiles()
  const showInstanceDetail = ref(false)

  const { connected: wsConnected } = useWebSocket()
  // 断连指示条（P-20261002-5）：消费上面装配实例的 connected ref（useWebSocket
  // 非单例——横条只读此 ref，任何地方都不得为取状态再调一次 useWebSocket）
  const { visible: wsDisconnectBarVisible } = useWsDisconnectBar(wsConnected)
  const { cycleTheme } = useThemeFont()
  // 通知跳终端会话复用审批卡「查看发起会话」原语（agent/项目会话统一激活）
  const approvalActions = useApprovalActions()
  // 通知 agent-fix 动作（P-20261003-289 部署失败 + P-20261005-150 哨兵命中）：
  // 复用 P-109 修复链发起，payload 前缀分流两源（useAgentFix 收口）
  const { handNotificationAgentFix } = useAgentFix()
  // 定时任务发起失败通知「一键重试」（P-20261006-14）：调既有试跑端点重新发起，
  // 发起/终端直达/任务面板刷新联动收口 useCronRetry
  const { retryFromNotification } = useCronRetry()
  // 快投递行内动作（P-20261006-51）：「交给当前会话」broadcast-write /
  // 「新会话处理」createAgent——取数与编排全在 useQuickdrop 收口
  const { forwardToActiveSession, handToNewSession } = useQuickdrop()
  // 协作素材「交给当前会话/新会话处理」（P-20261024-1）——取数与编排全在
  // useShareDrop 收口（通知行内动作 + sc-ops:share.drop 广播双出口共用）
  const { forwardToActiveSession: shareDropForward, handToNewSession: shareDropNew } = useShareDrop()
  /** 协作素材到达直通分发（P-20261024-1）：sc-ops:share.drop → toast 即时
   *  感知（主人正在主界面时不用翻通知中心）。带行内动作双出口的通知条目由
   *  服务端入账，动作链仍在通知中心/useShareDrop——本 handler 只播报元数据 */
  function onShareDrop(ev: Event): void {
    const d = (ev as CustomEvent<ShareDropDetail>).detail
    if (!d?.name) return
    message.info(t('share.drop.arrived', {
      name: d.shareName || d.token || '',
      file: d.name,
      nick: d.nick || t('share.msg.anon'),
    }))
  }
  // autoStash 通知「恢复」（P-20261006-48）：条目重定位与 pop 反馈收口
  // useStashRecover（pop 冲突走 stashKept 同款 warning 语义）
  const { recoverFromNotification: stashRecoverFromNotification } = useStashRecover()
  // 注入 message API 与面板切换器到 axios 拦截器（必须在 provider 子树内调用）
  useErrorDisplayInit()

  // 子组件 ref 用于 UI 状态收集与组件访问（先声明：useOpenFiles 回调引用）
  const topBarRef = ref<InstanceType<typeof TopBar> | null>(null)
  const sidePanelRef = ref<InstanceType<typeof SidePanel> | null>(null)
  const editorAreaRef = ref<InstanceType<typeof EditorArea> | null>(null)
  const bottomPanelRef = ref<InstanceType<typeof BottomPanel> | null>(null)

  const {
    openFiles, activeFileIndex, groups, activeGroup, splitOpen, splitDirection, allOpenFiles,
    currentFile, openFile, openFileByPath, openUntitled, saveCurrentFile, saveAllFiles, updateContent, openDiffView, openTwoFilesDiff,
    // 未命名草稿启动恢复（P-20261003-97 草稿热退出，bootstrap 恢复链消费）
    restoreUntitledDrafts,
    // 草稿库陈旧对账（P-20261003-152，bootstrap 恢复链消费）
    reconcileStaleDrafts,
    // 编码徽标菜单（P-20261002-146）：以指定编码重载 / 转为指定编码保存
    reloadFileWithEncoding, saveFileWithEncoding,
    canReopenClosed, reopenClosedFile,
    // 未保存草稿恢复（提示条消费：队首 offer + 恢复/对比预览/丢弃动作）
    draftOffer, applyDraftRestore, discardDraftRestore, previewDraftRestore,
    // 分屏双组（组感知操作供 EditorArea 分组 emit 转调）
    openInSplitByPath, closeSplit, moveTabToGroup,
    toggleSplit, splitDown, focusOtherGroup, restoreSplitFromPaths,
    switchFileInGroup, closeFileInGroup, togglePinTabInGroup,
    // 脏点「保存并关闭」（P-20261003-138，EditorGroupPane saveCloseFile 转调）
    saveCloseFileInGroup,
    // tab/编辑器右键「放弃未保存修改」（P-20261005-156，EditorArea revertFile 转调）
    revertFileInGroup,
    closeOtherTabsInGroup, closeAllTabsInGroup, closeSavedTabsInGroup, closeTabsToRightInGroup,
    reorderGroupTabs, cycleActiveTab, closeActiveGroupTab,
    // 键盘移动活跃标签（P-20261005-201，Alt+Shift+←/→ 键位消费）
    moveActiveTab,
    // 远程文件编辑（P-20261003-15）：离线横幅重试（EditorArea remoteRetry 转调）
    retryRemoteFile,
  } = useOpenFiles({
    onRemoveRecent: (p) => {
      removeRecent(p)
      // 文件层 frecency（P-20261005-222）：打开失败=路径已失效（删除/改名），
      // 同步清记录防同分带/置顶段引用僵尸路径（useRecentFiles.removeRecent 同口径）
      if (projectStore.currentProjectId) removeFileUsage(projectStore.currentProjectId, p)
    },
    onPushRecent: (item) => {
      // 直接写模块级最近文件记录：不走欢迎面板 ref（打开文件必然切走欢迎页，ref 已卸载会静默丢记录）
      pushRecent(item)
      // 文件层 frecency（P-20261005-222）：打开成功即计数——Quick Open 同分带
      // 破平与空查询置顶段的数据源（命令层 paletteUsage 同机制分 key 持久化）
      recordFileUsage(item.projectId, item.path)
    },
    onDisposeModel: (path) => {
      editorAreaRef.value?.monacoEditorRef?.disposeModel(path)
    },
    // 远程文件「最近远程」记录（P-20261004-137）：打开/保存成功置顶；主机已删
    // 404 惰性清死条目（openfiles/core+save 两处回调）
    onPushRemoteRecent: pushRemoteRecent,
    onRemoveRemoteRecent: removeRemoteRecent,
    onUntitledSavedAs: (p) => {
      // 草稿另存为成功 → 文件树定位新文件。先刷新根再 reveal：树列表有 10s
      // 缓存（FileTreeView fileTreeCache），直接 reveal 可能命中陈旧列表落空
      const layout = usePanelLayout()
      layout.sideView.value = 'files'
      layout.showSidePanel.value = true
      void nextTick(async () => {
        await sidePanelRef.value?.fileTreeRef?.refreshRoot()
        sidePanelRef.value?.fileTreeRef?.revealFile(p)
      })
    },
  })
  // Monaco model 缓存打开集保活（P-20261002-90）：把当前打开文件路径集注入
  // 缓存层，LRU 淘汰只清已关闭文件——openFiles 里的 model 免遭淘汰后切回
  // 重新分词。经 monacoModelOpenSet 注册表注入而非直接 import 缓存模块，
  // monaco-editor 保持 EditorGroupPane 的懒加载 chunk 不进主包
  setMonacoModelOpenPathProvider(() => {
    const paths = new Set<string>()
    for (const f of allOpenFiles.value) paths.add(f.path)
    return paths
  })
  if (getCurrentScope()) {
    // Layout 卸载即注销（useOpenFiles 同款守卫）：防陈旧闭包跨实例残留，
    // 重挂后由新 shell 重新注册
    onScopeDispose(() => clearMonacoModelOpenPathProvider())
  }
  const { showCommandPalette, showQuickOpen, showProjectSearch, projectSearchSeed, projectSearchGlobSeed, showOutline, showTaskRunner, showBookmarkList, showTerminalHistorySearch, showTerminalOutputSearch, showTerminalPorts, showSelfCheck, paletteFiles, paletteFilesLoading, paletteFilesTruncated, paletteRemoteFiles, paletteCommands, openCommandPalette, openQuickOpen, openProjectSearch, closePalettes, paletteInitialMode, loadPaletteFiles } = useQuickNav(allOpenFiles)

  // 快捷键备忘单（? 键呼出）
  const showShortcutsHelp = ref(false)

  // 多剪贴板粘贴弹层（P-20261002-149，Ctrl+Alt+V 呼出）
  const showClipboardHistory = ref(false)

  // 帮助中心抽屉（顶栏 ? / 命令面板呼出）
  const showHelpCenter = ref(false)

  // 项目操作 composable（替代原内联的大量重复代码）
  const {
    showAddModal, showCloneModal, showPushModal, showRemoveProjectConfirm,
    remoteLoading, showSettingsModal, aheadBehindMap,
    openSettings,
    currentAheadBehind,
    fetchAllAheadBehind,
    handleFetch, handlePull,
    handleCreatePr,
    copyRemoteUrl,
    buildInfo, fetchBuildInfo,
  } = useProjectActions(() => allOpenFiles.value)

  // 批量拉取全部项目（P-20261003-309）：面板「Fetch 全部项目」与首页工具栏
  // 同源 useFetchAll；ahead/behind 刷新接 useProjectActions 的既有 map
  // （TopBar 项目下拉的 ahead/behind 徽标数据源）
  const { fetchAllProjects } = useFetchAll({ refreshAheadBehind: fetchAllAheadBehind })

  // 面板状态
  const { sideView, showSidePanel, showBottomPanel, bottomTab, commitLocation, sidePanelWidth, bottomPanelHeight, bottomPanelMaximized, bottomPanelEditorMaximized, togglePanel, toggleRemoteConsole, exitMaximizedByEsc, dismissBottomPanelByEsc, showRemoteConsole, showShareManager, toggleShareManager, toggleEditorGroupMaximized } = usePanelLayout()

  // 编辑器组临时最大化（P-20261004-64）命令面板入口：splitOpen 守卫（单组无
  // 对侧可藏，最大化失义）+ 活跃组取号——与 EditorArea tab 条双击同一 toggle
  const toggleGroupMaximize = () => {
    if (splitOpen.value) toggleEditorGroupMaximized(activeGroup.value)
  }

  // 分屏方向切换（P-20261005-230）命令面板入口：splitOpen 守卫（未分屏无方向
  // 可言，no-op 与 toggleGroupMaximize 同门）；双组仅排列轴翻转零状态重建
  const toggleSplitDirection = () => {
    if (splitOpen.value) {
      splitDirection.value = splitDirection.value === 'horizontal' ? 'vertical' : 'horizontal'
    }
  }

  // UI 状态持久化（P-20261002-94 起分屏组清单/活跃位与开合、主组清单一起记忆；
  // P-20261005-230 起分屏方向一并记忆；P-20261002-8 键级补丁基线对齐）
  const { setupAutoSave, createBeforeUnloadHandler, alignBaselineAfterRestore } = useLayoutState(
    { sidePanelWidth, bottomPanelHeight, showSidePanel, showBottomPanel, sideView, bottomTab, commitLocation, bottomPanelMaximized, bottomPanelEditorMaximized },
    { openFiles, activeFileIndex, splitOpen, splitDirection, allFiles: allOpenFiles, groups }
  )

  // 工作现场存档（P-20261002-84）：命令面板「保存当前现场/恢复现场」的流程编排。
  // 编辑器/文件树应用器是本 shell 作用域状态（useOpenFiles 非单例、侧栏树 ref 在
  // 宿主），以 deps 闭包注入
  const snapshotApi = useWorkspaceSnapshot({
    openFilePaths: () => openFiles.value.filter(f => !f.isDiff && !isUntitledPath(f.path)).map(f => f.path),
    activeFilePath: () => {
      const f = openFiles.value[activeFileIndex.value]
      return f && !f.isDiff && !isUntitledPath(f.path) ? f.path : ''
    },
    // 分屏开合（P-20261003-68）：采集直读双组模型 ref；应用开/关两链合成——
    // 开=直写 ref（boot 恢复同款直写，文件清单随后按 splitFiles 串行恢复），
    // 关=closeSplit 既有链路（组 1 文件并回组 0，随后整表换签覆盖，模型释放不泄漏）
    splitOpen: () => splitOpen.value,
    applySplitOpen: (v) => {
      if (v) splitOpen.value = true
      else closeSplit()
    },
    unsavedCount: () => allOpenFiles.value.filter(f => f.content !== f.originalContent).length,
    // 主组整表换签：先释放不被分屏组共享的 Monaco model（closeFile 同语义——
    // 共享对象他组仍打开时不释放），整表替换后按快照重开（openFileByPath 对已删
    // 文件走既有降级：占位摘除 + 从最近文件清理），最后落活跃位。
    // 不走 closeAllTabsInGroup：入口处已一次性确认未保存丢失，逐签 confirm 会二次打断
    applyEditor: async (paths, activeFile) => {
      const g1Paths = new Set(groups.value[1]!.files.map(f => f.path))
      for (const f of openFiles.value) {
        if (!f.isDiff && !isUntitledPath(f.path) && !g1Paths.has(f.path)) {
          editorAreaRef.value?.monacoEditorRef?.disposeModel(f.path)
        }
      }
      openFiles.value = []
      activeFileIndex.value = -1
      for (const p of paths) await openFileByPath(p)
      if (activeFile) {
        const idx = openFiles.value.findIndex(f => f.path === activeFile)
        if (idx >= 0) activeFileIndex.value = idx
      }
    },
    // 树展开重放：先就地收起（P-74 同款事件，等收起的 watch 回写收敛），再写快照
    // 展开表（树未挂载时下次进入 restoreExpanded 生效），挂载中逐目录 reveal 展开
    //（revealFile 对目录路径同样逐层展开；快照里已删除的目录静默跳过）
    applyTreeExpansion: async (dirs) => {
      const pid = projectStore.currentProjectId
      if (!pid) return
      window.dispatchEvent(new CustomEvent(OPS_COLLAPSE_TREE, { detail: { projectId: pid } satisfies CollapseTreeDetail }))
      await nextTick()
      safeStorage.setItem(`sc.fileTree.expanded.${pid}`, JSON.stringify(dirs))
      const tree = sidePanelRef.value?.fileTreeRef
      if (tree && dirs.length > 0) {
        for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
          await tree.revealFile(d)
        }
      }
    },
  })

  // P0/P1 新功能状态
  // 通知中心已提升为全局 store（App.vue 挂载，跨页面共享）——此处不再持有
  // showNotifications 状态（曾与 App.vue 实例形成双 DOM，且该 ref 无人置真）
  const notificationStore = useNotificationStore()

  // 底部面板高度拖拽抽至 useLayoutPanelResize（「在终端中打开」目录直达已并入
  // useLayoutViews.openInTerminal，P-20261005-192 起为目录级真实创建链）
  const resizeApi = useLayoutPanelResize({
    bottomPanelHeight,
  })
  const startBottomResize = resizeApi.startBottomResize

  // 主区视图互斥/保活 + 面板/搜索跳转 + 终端联动（装配胶水）抽至 useLayoutViews
  const {
    openFileFromPanel, openDiffFromPanel, openCompareWithBaseline,
    remoteEverOpened, remoteAutoHost, shareEverOpened,
    showInstanceSessions, showInstanceFleet, showFleetNotify, showQrRelay, showFleetBulkAgent,
    showExportCenter, handleExportCenterNavigate,
    handlePaletteCommand, handlePaletteOpenFile, handlePaletteOpenFileSplit, handleSearchOpenFile,
    navBack, navForward, bookmarkJump, bookmarkJumpCount,
    revealCurrentFileInTree, openInTerminal, searchInDir, onSync,
    flushFileDeepLink, hasPendingFileDeepLink,
  } = useLayoutViews({
    showRemoteConsole,
    showShareManager,
    toggleShareManager,
    showPushModal, showSettingsModal, openProjectSearch,
    showBottomPanel, showSidePanel, bottomTab, sideView,
    currentFile: () => currentFile.value,
    openFile, openFileByPath, openDiffView, openTwoFilesDiff,
    // Quick Open Ctrl/Cmd+Enter 分屏打开（P-20261002-106）：复用 P-13 既有 API
    openInSplitByPath,
    reopenClosedTab: () => { void reopenClosedFile() },
    // 全部保存（P-20261002-101）：命令面板 save-all 分发（toast 汇总在 saveAllFiles 内闭环）
    saveAll: () => { void saveAllFiles() },
    snapshotSave: () => { void snapshotApi.saveSnapshotFlow() },
    snapshotOpenManager: () => snapshotApi.openManager(),
    togglePanel, toggleRemoteConsole, handleFetch, fetchAllProjects, handlePull, cycleTheme,
    toggleGroupMaximize, toggleSplitDirection,
    currentProjectId: () => projectStore.currentProjectId || '',
    hasProject: (id: string) => projectStore.projects.some(p => p.id === id),
    selectProject: (id: string) => projectStore.selectProject(id),
    openShortcutsHelp: () => { showShortcutsHelp.value = true },
    openHelpCenter: () => { showHelpCenter.value = true },
    openTaskRunner: () => { showTaskRunner.value = true },
    openBookmarkList: () => { showBookmarkList.value = true },
    openTerminalHistorySearch: () => { showTerminalHistorySearch.value = true },
    openTerminalOutputSearch: () => { showTerminalOutputSearch.value = true },
    openTerminalPorts: () => { showTerminalPorts.value = true },
    openSelfCheck: () => { showSelfCheck.value = true },
    editorAreaRef: () => editorAreaRef.value,
    sidePanelRef: () => sidePanelRef.value,
    bottomPanelRef: () => bottomPanelRef.value,
  })
  // 标签拖拽重排序（由 EditorArea 分组 emit 触发，useOpenFiles.reorderGroupTabs 组内应用）

  /** Quick Open 空结果降级（P-20261002-86）：文件模式无命中时点动作行/按 Enter——
   *  关面板并带查询词打开项目搜索（经 useQuickNav 统一入口写入种子词，
   *  搜索面板打开时填入并自动搜索） */
  function handlePaletteFallbackSearch(query: string) {
    closePalettes()
    openProjectSearch(query)
  }

  // 子组件 provide 装配（pushNotification 兼容层 + TopBar 共享状态 + 文件树定位）抽至 useLayoutBridge
  useLayoutBridge({
    projectName: () => projectStore.currentProject?.name,
    projectId: () => projectStore.currentProjectId || '',
    aheadBehindMap, remoteLoading, fetchAllAheadBehind,
    handleFetch, handlePull, handleCreatePr,
    showBottomPanel, bottomTab, sideView, showSidePanel,
    // 编辑器活跃 tab 路径（P-20261004-39）：GitPanel 经桥订阅，感知「编辑器内切
    // tab 回看 git 面板」——本 shell 是 useOpenFiles 生产实例唯一调用点
    activeEditorPath: computed(() => currentFile.value?.path || ''),
    sidePanelRef: () => sidePanelRef.value,
    openFile,
    // 面包屑「在此目录打开终端」（P-20261005-192）：目录段/当前文件所在目录
    // 右键经桥上抛，动作链与文件树 open-terminal 同一条创建链
    openTerminalInDir: openInTerminal,
    // 侧栏「舰队发起」钮（P-20261005-152）：经桥翻 showFleetBulkAgent，弹层
    // 宿主仍在 Layout——与 palette 入口共用同一弹层实例与状态位
    openFleetBulkAgent: () => { showFleetBulkAgent.value = true },
  })

  // git 失败恢复直达消费端（P-20261005-194）：拦截器动作 toast 的按钮经
  // gitFailHint store 送达宿主。「先拉取」在本 shell 消费——跨项目先切换（守卫
  // 取消即放弃，P-105 同款语义）再走既有拉取流（handlePull 内含完整回告与
  // ahead/behind 刷新）；「解决冲突」只负责把 git 底部 tab 带上屏，冲突视图
  // 展开由 GitPanel 挂载后消费（消费方按 kind 分工不重复清位）
  const gitFailHintStore = useGitFailHintStore()
  watch(() => gitFailHintStore.pending, async (req) => {
    if (!req) return
    if (!isGitFailHintFresh(req)) {
      gitFailHintStore.consume()
      return
    }
    if (req.kind === 'conflict') {
      showBottomPanel.value = true
      bottomTab.value = 'git'
      return
    }
    gitFailHintStore.consume()
    try {
      if (req.projectId && req.projectId !== projectStore.currentProjectId
        && projectStore.projects.some(p => p.id === req.projectId)) {
        await projectStore.selectProject(req.projectId)
        await nextTick()
      }
      if (req.projectId === (projectStore.currentProjectId || '')) await handlePull()
    } catch { /* 拉取流内部已有完整回告 */ }
  })

  /** 「新建文件」按钮直达树内联创建：切到文件面板并就地开始输入文件名
   *  （原先只打开面板，用户还需右键 → 新建文件，两步且按钮名不副实） */
  function startNewFileFromEditor() {
    sideView.value = 'files'
    showSidePanel.value = true
    void nextTick(() => {
      sidePanelRef.value?.fileTreeRef?.startCreateFile?.()
    })
  }

  /** Monaco 右键「与剪贴板对比」：剪贴板内容为 diff 左侧（内存直供不落盘），
   *  右侧为当前工作区文件。oldRef 用伪 ref 'clipboard'（面包屑/标签名有专门映射）。
   *  全组查找：Monaco 所在组可能是分屏组 */
  function openClipboardDiff(payload: { path: string; text: string }) {
    const f = allOpenFiles.value.find(x => x.path === payload.path)
    if (!f) return
    void openDiffView({ path: payload.path, name: f.name, oldRef: 'clipboard', leftContent: payload.text, oldLabel: t('changes.clipboard') })
  }

  // 多剪贴板粘贴（P-20261002-149）历史选中：写回系统剪贴板（JetBrains 同语义，
  // 选中项成为当前剪贴板，终端等非编辑器目标可随即 Ctrl+V）+ 活跃编辑器光标处
  // 插入；无可用编辑器（欢迎页/diff 标签）降级为仅复制并提示
  function pasteClipboardHistory(text: string) {
    void copyText(text)
    const monaco = editorAreaRef.value?.monacoEditorRef as
      | { insertClipboardText?: (t: string) => boolean }
      | null
      | undefined
    if (!monaco?.insertClipboardText?.(text)) {
      message.success(t('clip.history.copied'))
    }
  }

  // 全局快捷键（Esc/B/`/W/Tab/K/P/F/O/Alt+↑↓/锁定）抽至 useLayoutKeyboard
  useLayoutKeyboard({
    // 自定义弹层（大纲/任务运行器/全工程搜索/通知中心）打开时同样门控全局
    // 快捷键——否则 Ctrl+B/W 等会穿透弹层改到背后的布局（VS Code 同惯例）
    isDialogOpen: () => showCommandPalette.value || showQuickOpen.value || showSettingsModal.value || showHelpCenter.value
      || showOutline.value || showTaskRunner.value || showProjectSearch.value || showBookmarkList.value
      || showClipboardHistory.value || showTerminalHistorySearch.value || showTerminalOutputSearch.value
      || showTerminalPorts.value || showSelfCheck.value || notificationStore.showPanel,
    lockShortcut: () => lockStore.lockShortcut,
    lock: () => void lockStore.lock(),
    // Esc 退出投屏演示模式（P-20261002-45）：演示态最外层，优先于退出最大化态
    exitPresentModeByEsc: () => usePresentMode().exitByEsc(),
    exitMaximizedByEsc,
    // Esc 逐层收起（P-20261004-12）浮出层：底部终端浮动窗（z 基座 3000+，布局
    // 浮出层最上层）→ 智能体悬浮窗（z 900，收起为悬浮球条）。浮动窗依附终端
    // tab（TerminalView 随 bottomTab v-if 挂载），面板隐藏时浮窗随之不可见——
    // 以面板可见为前置，防止消费一次 Esc 收回不可见窗口
    dismissFloatByEsc: () => {
      if (showBottomPanel.value && bottomTab.value === 'terminal') {
        const tv = bottomPanelRef.value?.terminalRef as
          | { dockTopFloatBack?: () => boolean }
          | null
          | undefined
        if (tv?.dockTopFloatBack?.()) return true
      }
      const agent = useAgentTerminal()
      if (agent.visible.value && agent.mode.value === 'float') {
        agent.collapse()
        return true
      }
      return false
    },
    // Esc 逐层收起（P-20261004-12）最内层：底栏面板本身（与头部 × 同链路）
    dismissBottomPanelByEsc,
    toggleSidePanel: () => { showSidePanel.value = !showSidePanel.value },
    railPanelCount: () => railPanelCount(),
    switchRailPanel: (index: number) => { activateRailPanel(index) },
    // Ctrl/Cmd+Alt+数字恢复工作区预设（P-20261004-49）：门控计数与取数同源
    // snapshotApi 预热列表（useWorkspaceSnapshot 内挂载/切项目/落盘/恢复后保鲜），
    // 越界放行由捕获链按计数判定；恢复链收口 restoreSnapshotByIndex
    workspacePresetCount: () => snapshotApi.snapshots.value.length,
    restoreWorkspacePreset: (index: number) => { void snapshotApi.restoreSnapshotByIndex(index) },
    openSettings,
    isLocked: () => lockStore.isLocked,
    toggleTerminalPanel: () => {
      if (showBottomPanel.value && bottomTab.value === 'terminal') {
        showBottomPanel.value = false
      } else {
        bottomTab.value = 'terminal'
        showBottomPanel.value = true
      }
    },
    // Ctrl/Cmd+Shift+` 新建终端直达（P-20261002-38）：先确保底部终端面板可见
    // 再创建——直达语义非 toggle（已开也照建，对标 VS Code 新建终端键位）；
    // 创建/激活复用 TerminalView 既有 createTerminal 链路（新建即激活，与工具栏
    // + 按钮/命令面板 new-terminal 同路）；双 nextTick 等 TerminalView 的
    // v-if 挂载（面板此前收在非 terminal tab 时 ref 尚未就位，同 sendToTerminal）
    createNewTerminal: () => {
      bottomTab.value = 'terminal'
      showBottomPanel.value = true
      void nextTick(() => nextTick(() => {
        const tv = bottomPanelRef.value?.terminalRef as { createTerminal?: () => void } | undefined
        void tv?.createTerminal?.()
      }))
    },
    // Ctrl/Cmd+Shift+V 端口预览面板直达（P-20261002-69）：toggle 语义与终端键一致
    togglePreviewPanel: () => {
      if (showBottomPanel.value && bottomTab.value === 'preview') {
        showBottomPanel.value = false
      } else {
        bottomTab.value = 'preview'
        showBottomPanel.value = true
      }
    },
    isRemoteOrChat: () => showRemoteConsole.value,
    // Ctrl+W 组感知：作用于活跃组（分屏时即最后点击的编辑器组）
    closeActiveTab: () => closeActiveGroupTab(),
    reopenClosedTab: () => { void reopenClosedFile() },
    // Ctrl/Cmd+Alt+←/→ 编辑器导航后退/前进（P-20261002-51，恢复链在 useLayoutViews）
    navBack: () => navBack(),
    navForward: () => navForward(),
    // Alt+PgUp/PgDn 书签间跳转（P-20261004-102，环形序取相邻书签，跳转链在
    // useLayoutViews）；门控计数同源 useEditorBookmarks 单例（无书签 veto 放行）
    bookmarkJumpCount: () => bookmarkJumpCount(),
    bookmarkJump: (delta) => bookmarkJump(delta),
    // Ctrl/Cmd+Alt+N 新建未命名草稿（纯内存 tab，保存时经另存为落盘）
    newUntitledDraft: () => { openUntitled() },
    // Ctrl/Cmd+Alt+S 全部保存（P-20261002-101）：双组全部脏文件串行落盘
    saveAll: () => { void saveAllFiles() },
    openFilesCount: () => allOpenFiles.value.length,
    cycleEditorTab: (delta) => cycleActiveTab(delta),
    // Ctrl+PgUp/PgDn 线性切换上一/下一标签（P-20261002-135）：同走 cycleActiveTab
    // 的活跃组 ±1 环绕（P-13 恒双组模型只动活跃组），与 Ctrl+Tab 循环各自独立
    // 改键——键位语义分离在 keymap 两个动作，实现共用同一条组感知切换链
    switchTab: (delta) => cycleActiveTab(delta),
    // Alt+Shift+←/→ 键盘移动当前标签（P-20261005-201）：与 switchTab 同为组
    // 感知活跃组操作，实现收口 useOpenFiles.moveActiveTab（与拖拽重排共用
    // reorderGroupTabs 一条链，到头静默停）
    moveTab: (delta) => moveActiveTab(delta),
    // Ctrl/Cmd+\ 分屏开关 / Ctrl+Alt+\ 下方分屏（P-20261005-230）/ Ctrl/Cmd+Shift+\
    // 切活跃组（P-20261002-93，键盘分屏闭环，合成在 useOpenFiles：开合走
    // openInSplit/closeSplit 既有链路，切组未分屏 no-op）
    toggleSplit,
    splitDown: () => { void splitDown() },
    focusOtherGroup,
    openCommandPalette: (mode) => openCommandPalette(mode),
    // 统一入口（P-20261004-137）：Ctrl+P 与节目按钮同链——初始模式复位 +
    // 文件清单加载 + 远程层主机别名刷新同一份实现，避免两条开面板路径漂移
    openQuickOpen: () => openQuickOpen(),
    // 经统一入口打开（种子词随之重置，P-20261002-86）
    openProjectSearch: () => openProjectSearch(),
    openOutline: () => { showOutline.value = true },
    // 多剪贴板粘贴（P-20261002-149）：Ctrl+Alt+V 呼出历史选择弹层
    openClipboardHistory: () => { showClipboardHistory.value = true },
    // Markdown 模式循环（P-20261003-18）：仅活跃文件为 md 时消费按键（非 md veto
    // 放行不拦截）；切换经活跃组 Monaco 实例（monacoEditorRef 跟随活跃组，与
    // closeActiveTab / diffNav 同口径），diff 标签/无编辑器为 no-op
    isMdFileActive: () => {
      const f = currentFile.value
      return !!f && !f.isDiff && /\.(md|markdown)$/i.test(f.path)
    },
    cycleActiveMdMode: () => { editorAreaRef.value?.monacoEditorRef?.cycleMdMode() },
    openShortcutsHelp: () => { showShortcutsHelp.value = true },
    diffNav: (down) => {
      const file = currentFile.value
      if (file?.isDiff && editorAreaRef.value?.diffEditorRef) {
        if (down) editorAreaRef.value.diffEditorRef.goToNextChange()
        else editorAreaRef.value.diffEditorRef.goToPrevChange()
      }
    },
  })

  const handleBeforeUnload = createBeforeUnloadHandler()

  // 大纲内容上限：历史实现把当前文件全文作为模板依赖传给大纲组件，
  // 每击键触发 Layout 整树重渲染 + 大纲全量重解析。超大文件截断传递
  //（200k 字符足够覆盖常规代码文件的大纲；超大文件以输入流畅度优先）
  const OUTLINE_CONTENT_MAX = 200_000
  const outlineContent = computed(() => {
    const c = currentFile.value?.content || ''
    return c.length <= OUTLINE_CONTENT_MAX ? c : ''
  })

  // 引导恢复（uiState 布局/实例/项目维度恢复 + 锁定联动 + 通知跳转）抽至 useLayoutBootstrap
  const bootstrapApi = useLayoutBootstrap({
    getInstanceState: () => uiStateStore.getInstanceState(),
    showRemoteConsole,
    sidePanelWidth,
    bottomPanelHeight,
    showSidePanel,
    showBottomPanel,
    sideView,
    bottomTab,
    commitLocation,
    bottomPanelMaximized,
    bottomPanelEditorMaximized,
    // 分屏开合恢复（uiState editor 命名空间，项目维度守卫内恢复）
    splitOpen,
    // 分屏方向恢复（P-20261005-230）：缺省/脏值回落横向（旧布局幂等兼容）
    splitDirection,
    // 分屏组清单恢复（P-20261002-94）：bootstrap 保证主组 opens 落地后才调用
    //（串行约束），降级 toast 在 useOpenFiles.restoreSplitFromPaths 内闭环
    restoreSplitFiles: (paths, activeFile) => restoreSplitFromPaths(paths, activeFile),
    // untitled 草稿启动恢复（P-20261003-97 草稿热退出）：项目恢复落地后重建
    // 草稿 tab + toast，收口在 useOpenFiles.restoreUntitledDrafts
    restoreUntitledDrafts: () => restoreUntitledDrafts(),
    // 草稿库陈旧对账（P-20261003-152）：文件已删的草稿清账 + 汇总提示，
    // 收口在 useOpenFiles.reconcileStaleDrafts（项目不可达整段跳过防误清）
    reconcileStaleDrafts: () => reconcileStaleDrafts(),
    ensureInstancesFresh: () => instanceStore.ensureInstancesFresh(),
    selectInstance: (id: string) => instanceStore.selectInstance(id),
    startInstanceId: () => startInstanceId,
    currentProjectId: () => projectStore.currentProjectId || '',
    hasProject: (id: string) => projectStore.projects.some(p => p.id === id),
    setCurrentProject: (id: string) => projectStore.selectProject(id),
    consumePendingProjectId: () => instanceStore.consumePendingProjectId(),
    consumeExplicitSelectId: () => projectStore.consumeExplicitSelectId(),
    consumePendingSideFilesOpen: () => usePanelLayout().consumePendingSideFilesOpen(),
    consumePendingBottomTab: () => usePanelLayout().consumePendingBottomTab(),
    consumePendingSideView: () => usePanelLayout().consumePendingSideView(),
    // 项目仪表盘默认落点（P-20261005-224）：偏好读 uiState dashboard 命名空间；
    // 落位闭包在此裁决让位条件——其他主区视图已恢复在场（远程/分享/dsh/agent
    // docked）或文件深链挂起（意图是「看文件」，flush 会把主区切回编辑器）时不落
    getDashboardLanding: () => uiStateStore.getDashboardLanding(),
    openDashboardLanding: () => {
      const layout = usePanelLayout()
      if (layout.showRemoteConsole.value || layout.showShareManager.value
        || layout.showDshConsole.value || hasPendingFileDeepLink()) return
      layout.openDashboard()
    },
    fetchProjects: () => projectStore.fetchProjects(),
    fetchAllAheadBehind,
    fetchBuildInfo,
    fetchStatus: (id: string) => changesStore.fetchStatus(id),
    openFileByPath,
    openFilesCount: () => openFiles.value.length,
    setActiveFileIndex: (i: number) => { activeFileIndex.value = i },
    revealExpandedDirs: (dirs: string[]) => {
      for (const dir of dirs) sidePanelRef.value?.fileTreeRef?.expandedDirs.add(dir)
    },
    restoreGitPanel: (collapsed, branch) => {
      const gp = bottomPanelRef.value?.gitPanelRef as any
      if (gp?.collapsedSections) gp.collapsedSections.value = collapsed
      if (gp?.selectedBranch && branch) gp.selectedBranch.value = branch
    },
    restoreTerminalTab: (tabId) => {
      const tv = bottomPanelRef.value?.terminalRef as any
      if (tv?.activeTabId) tv.activeTabId.value = tabId
    },
  })
  bootstrapApi.bindLockWatch(
    computed(() => lockStore.isLocked),
    () => {
      // 锁定时关闭所有可能干扰 LockScreenOverlay 焦点的弹窗
      // Naive UI NModal 的 focus trap 会把键盘焦点困在 modal 内，
      // 导致 LockScreenOverlay.passwordInput.focus() 失效，用户无法输入密码
      showSettingsModal.value = false
      showCommandPalette.value = false
      showQuickOpen.value = false
      showProjectSearch.value = false
      showOutline.value = false
      showTaskRunner.value = false
    },
    () => { projectStore.fetchProjects().then(() => fetchAllAheadBehind()) },
  )

  // 挂载时的起始实例 id（bootstrap 在任何 await 之前读取，避免竞态影响切换判定）
  let startInstanceId = ''

  // 智能操作通道 panel 事件：底层智能体驱动界面布局（打开指定面板）。
  // 白名单来自面板注册表（注册即可被 Agent 驱动，无需改此处）
  function onOpsPanel(e: Event) {
    const name = (e as CustomEvent<{ name?: string }>).detail?.name
    if (name && toggleablePanelIds().has(name)) togglePanel(name as 'files' | 'changes' | 'git' | 'terminal')
  }

  // 远程文件「在编辑器打开」（P-20261003-15）：远程文件面板右键动作 → 切回
  // 编辑器主区（主区互斥最后落位者胜）并按 remote:<hostId>:<path> 伪路径挂签
  //（useOpenFiles 远程分支装载；无项目也可开——远程管理与项目正交）
  function onRemoteOpenInEditor(e: Event) {
    const d = (e as CustomEvent<RemoteOpenInEditorDetail>).detail
    if (!d?.hostId || !d?.path) return
    showRemoteConsole.value = false
    void openFileByPath(buildRemoteEditorPath(d.hostId, d.path))
  }

  // AI 助手代码块「发送到终端」：切到底部终端面板并把文本写入活动会话。
  // 结果三态（P-20261005-191 起 sendText 经高危命令影响面闸门）：
  // 'sent'=已写入（直接放行或确认卡后写入）/ 'cancelled'=确认卡取消 /
  // 'no-terminal'=无活动终端会话（调用方提示）；供子孙组件 inject 使用。
  // opts.createIfMissing（P-20261004-21 编辑器「发送选中到终端」）：无活跃终端
  // 时先走 tab 栏「+」同一条 createTerminal 链新建项目默认终端（无项目由其内部
  // toast 提示，新建即激活）——显式 opt-in，既有调用方（检索落位）缺省语义不变
  const sendToTerminal = async (
    text: string,
    opts?: { createIfMissing?: boolean },
  ): Promise<'sent' | 'cancelled' | 'no-terminal'> => {
    if (!text) return 'no-terminal'
    showBottomPanel.value = true
    bottomTab.value = 'terminal'
    await nextTick()
    await nextTick() // v-if 挂载 TerminalView
    const tv = bottomPanelRef.value?.terminalRef as unknown as
      | { activeTabId?: string; sendText(t: string): Promise<'sent' | 'cancelled' | 'no-pane'>; createTerminal?(): Promise<void> }
      | null
    if (tv && !tv.activeTabId && opts?.createIfMissing && tv.createTerminal) {
      await tv.createTerminal()
      await nextTick()
      await nextTick() // 新 tab 的 TerminalPane 挂载 + paneRefs 登记，与上方同口径
    }
    if (!tv?.activeTabId) return 'no-terminal'
    const outcome = await tv.sendText(text)
    return outcome === 'sent' ? 'sent' : outcome === 'cancelled' ? 'cancelled' : 'no-terminal'
  }
  provide('sendToTerminal', sendToTerminal)

  // 跨项目命令历史检索（P-20261004-2）命中项落位：插入当前终端（不执行，命令
  // 文本留在输入行由人确认回车）；无活跃终端会话时降级为复制并提示——检索
  // 动作本身在首页（无项目）也成立，不能因落位目标缺失而静默失败。
  // 确认卡取消（P-20261005-191）：知情放弃是明确结果，不复制不误报「无终端」
  async function insertTerminalHistoryCommand(command: string) {
    const outcome = await sendToTerminal(command)
    if (outcome === 'sent') {
      message.success(t('terminal.history.inserted'))
    } else if (outcome === 'cancelled') {
      message.info(t('terminal.cmdPreview.insertCancelled'))
    } else {
      await copyText(command)
      message.info(t('terminal.history.noActiveTerminal'))
    }
  }

  // 跨会话输出检索（P-20261003-290）命中项落位：走审批卡「查看发起会话」同一
  // activate-terminal 链路（项目会话切项目+开终端面板+激活 tab；agent 会话归
  // 智能体面板；会话已结束内部 toast 降级）。会话内定位（P-20261005-9）：激活
  // 真正派发后按命中查询词轮询定位（terminalOutputLocate 吸收切项目/挂载/重放
  // 全部时序），滚出缓冲降级 toast——不派发（会话已结束）不轮询，避免对打不开
  // 的会话空等后误报
  function jumpToTerminalSession(sessionId: string, query?: string) {
    void approvalActions.jumpToSession(sessionId, query).then((dispatched) => {
      if (!dispatched || !query) return
      requestTerminalOutputLocate(sessionId, query, {
        onMissing: () => message.warning(t('terminal.history.hitOutOfBuffer')),
      })
    })
  }

  onMounted(async () => {
    // 键盘监听已由 useLayoutKeyboard 自注册；此处注册 beforeunload 保存钩子并跑引导恢复
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener(OPS_PANEL, onOpsPanel)
    window.addEventListener(OPS_REMOTE_OPEN_IN_EDITOR, onRemoteOpenInEditor)
    window.addEventListener(OPS_SHARE_DROP, onShareDrop)
    // Monaco 语言 worker chunk 空闲预取（P-20261002-103）：仅调度，不占引导/交互时间片
    prefetchMonacoLanguageWorkers()
    startInstanceId = instanceStore.currentInstanceId

    const completed = await bootstrapApi.bootstrap()
    // 实例切换 remount 提前结束时跳过收尾（新 Layout 实例会重新执行本流程）
    if (!completed) return

    // boot 基线对齐（P-20261002-8）：必须等恢复链落定——此刻的 collect 才是
    // 本页初始现实，后续关页 diff 只认真实变更（详见 store.alignBaseline 注释）
    alignBaselineAfterRestore()

    // 通知动作 pendingAction watch（P-20261007-15）：绑定时机=引导恢复+基线
    // 对齐之后。watch 是 immediate——绑定时刻的存量动作（首页/大屏点动作条目
    // 经通知 store 路由桥接 push /project，挂载期间积累的 pendingAction）立即
    // 回放分发。此前在 setup 期挂 watch（非 immediate），桥接带来的存量无人
    // 回放、动作彻底丢失；且 setup 期回放会被随后的布局恢复（restoreLayoutOnly
    // 持久化面板/tab 值）翻回——恢复先落地、回放动作后到者胜，本时序是回放
    // 正确性前提（详见 bindPendingActionWatch 注释）
    bootstrapApi.bindPendingActionWatch(
      computed(() => notificationStore.pendingAction),
      () => notificationStore.consumeAction(),
      {
        switchProject: (id: string) => {
          const proj = projectStore.projects.find(p => p.id === id)
          // 经切换族走守卫（未保存草稿确认，P-20261003-105），不再直写
          // currentProjectId；项目不在列表维持原语义：不切不拦，放行后续动作
          return proj ? projectStore.selectProject(id) : true
        },
        openTerminalTab: (sessionId: string) => {
          // 通知跳终端会话统一走「激活会话」原语（同审批卡「查看发起会话」）：
          // agent 会话归智能体面板、项目会话归底部终端——底部面板直切对 agent
          // 会话无落点（审批超时通知 P-20261003-45 的跳转目标多为 agent 发起会话）
          void approvalActions.jumpToSession(sessionId)
        },
        togglePanel: (panel: string) => {
          // panel:deploy（部署任务通知，P-20261001-31）：部署无注册面板
          // （DeployDialog 挂在 设置→远程部署 分区），走「打开设置并定位分区」
          // 既有全局通道直达结果现场；panel:share-manager（分享收到新留言
          // 通知，P-20261006-13）直达分享管理器（留言面板所在的主区视图，
          // 经 activity-bar 注册面板族的同款 toggle 原语）；其余 payload 交
          // 面板注册表驱动
          if (panel === 'deploy') {
            openSettingsTab('deploy')
            return
          }
          if (panel === 'share-manager') {
            toggleShareManager()
            return
          }
          togglePanel(panel as 'files' | 'changes' | 'git' | 'terminal' | 'stream')
        },
        openUrl: (url: string) => window.open(url, '_blank', 'noopener'),
        // 预览端口直达（P-20261002-70）：preview.port 通知动作 → 开预览面板填端口
        openPreviewPort: (port: number) => usePreviewPortStore().openInPanel(port),
        // 文件监听降级兜底手动开关（P-20261003-140）：watch-fallback 通知动作 →
        // 翻转轮询兜底，toast 开关后状态（翻转语义对陈旧历史通知同样成立）
        watchFallbackToggle: () => {
          watchFallbackApi
            .set(undefined, { silent: true })
            .then(({ data }) => {
              if (data.enabled) message.success(t('notify.watchfallback.switchedOn'))
              else message.success(t('notify.watchfallback.switchedOff'))
            })
            .catch(() => message.error(t('notify.watchfallback.switchFailed')))
        },
        // 通知 agent-fix 动作（P-20261003-289 部署失败 + P-20261005-150 哨兵
        // 命中第二动作）：payload 前缀分流两源；发起链（补拉/装箱/敏感确认/
        // 结果提示）全在 useAgentFix.handNotificationAgentFix 收口
        agentFix: (n) => { void handNotificationAgentFix(n) },
        // 联邦派发通知跳该实例（P-20261004-101）：payload=注册实例 id，走
        // switch-instance 命令面板同款实例切换链（幂等守卫对同 id 无副作用）
        switchInstance: (id: string) => { void instanceStore.selectInstance(id) },
        // 失败会话「复盘报告」（P-20261004-60）：payload=会话 id，App 层复盘
        // 弹层经 postmortem store 打开（与右键入口同一 store 收口）
        postmortem: (sessionId: string) => { usePostmortemStore().openSession(sessionId) },
        // 编队完成通知直达值班大屏聚合卡（P-20261005-145）：跳 /monitor 独立路由
        //（非 Layout 子路由），query.fleet 供聚合卡展开+高亮定位
        monitorFleet: (batchId: string) => {
          void router.push({ name: 'monitor', query: { fleet: batchId } })
        },
        // 定时任务发起失败「一键重试」（P-20261006-14）：payload=JSON {cronId,slot}，
        // 试跑端点调用与反馈收口 useCronRetry.retryFromNotification
        cronRetry: (payload: string) => { void retryFromNotification(payload) },
        // 快投递行内动作（P-20261006-51）：payload=quickdrop:<id>，回查收件箱
        // 取内容后双出口分发（forward=broadcast-write 激活会话 /
        // new=createAgent launchArgs 种子）；已过期/无激活会话在链内如实提示
        quickdropForward: (n) => { void forwardToActiveSession(n) },
        quickdropNewSession: (n) => { void handToNewSession(n) },
        // 协作素材行内动作（P-20261024-1）：payload=shdrop:<token>:<id>，
        // 回查收件清单取绝对路径后双出口分发（forward=路径贴进激活会话 /
        // new=createAgent 以路径为种子）；已清素材在链内如实提示
        shdropForward: (n) => { void shareDropForward(n) },
        shdropNewSession: (n) => { void shareDropNew(n) },
        // 直通输入持权卡「收回」（P-20261024-1）：payload=token——revokeDirect
        // 幂等（无持权也成功），徽标随 bump 即时对账
        shdirectRevoke: (n) => {
          const token = String(n.actionPayload ?? '')
          if (!token) return
          void shareApi.revokeDirect(token).then(() => {
            message.success(t('terminal.revokeDirectInputDone'))
            bumpDirectInputShares()
          }).catch(() => { /* 拦截器已 toast */ })
        },
        // autoStash「恢复」（P-20261006-48）：payload=JSON {projectId,branch,
        // message}，重定位与 pop 反馈收口 useStashRecover.recoverFromNotification
        stashRecover: (payload: string) => { void stashRecoverFromNotification(payload) },
        // 敏感文件工作台外写入通知直达（P-20261005-15）：payload=项目相对路径，
        // 走既有「搜索/命令面板打开文件」原语（编辑器打开 + 侧栏定位同一链路）
        openFile: (path: string) => {
          void handleSearchOpenFile(path)
        },

      },
    )

    // 文件深链消费（P-20261002-49）：必须在 bootstrap 之后——uiState 恢复的
    // setCurrentProject 会连带清掉更早打开的深链标签；且排在 dsh 控制台恢复
    // 之后等其落地——深链意图是「看文件」，showEditorMain 会关掉刚恢复的 dsh
    // 控制台（主区互斥最后落位者胜），消费不能被恢复流程再翻回别的视图。
    // 回放深链（P-20261003-154）同款时序接力在其后：先切归属项目再开弹层，
    // 与文件深链互斥携带（同一链接只带 file= 或 session=），先后无耦合
    void restoreDshConsoleOnce()
      .then(() => flushFileDeepLink())
      .then(() => flushSessionReplayDeepLink())

    // dsh 控制台开关恢复（uiState dshConsole 命名空间）：在 bootstrap 的
    // remoteConsole 恢复完成之后执行，主区互斥语义 dsh 后到者赢
    // （文件深链消费经上方 then 链在其后执行）

    // 刷新变更状态供状态栏使用
    if (projectStore.currentProjectId) {
      changesStore.fetchStatus(projectStore.currentProjectId)
    }
  })

  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', handleBeforeUnload)
    window.removeEventListener(OPS_PANEL, onOpsPanel)
    window.removeEventListener(OPS_REMOTE_OPEN_IN_EDITOR, onRemoteOpenInEditor)
    window.removeEventListener(OPS_SHARE_DROP, onShareDrop)
  })

  // 项目切换时刷新变更状态（路径已失效的项目跳过：git status 必失败，
  // 全局拦截器会弹「服务器异常」toast——已知无效状态不该以错误形式呈现）
  watch(() => projectStore.currentProjectId, (id) => {
    if (id && projectStore.currentProject?.valid !== false) changesStore.fetchStatus(id)
  })

  setupAutoSave()

  // 用户 UI 现场上报（P-20261004-52）：agent「看着问」的供给侧——显著变化
  // 去抖 2s + 60s 心跳 POST /api/ui/snapshot，开关关/隐藏页自动静默；数据源
  // 全是本 shell 已装配的 store/composable，这里只负责随 Layout 生命周期启停
  //（onScopeDispose 兜底，实例切换卸载即停）
  startUiSnapshotReporter()

  return {
    // stores / 全局
    projectStore, fontStore, showInstanceDetail,
    // 断连指示条
    wsDisconnectBarVisible,
    // ActivityBar
    showAddModal, openSettings,
    // SidePanel
    sidePanelRef, sideView, showSidePanel, sidePanelWidth, commitLocation,
    openFileFromPanel, openInTerminal, searchInDir, openDiffFromPanel, openCompareWithBaseline,
    // TopBar
    topBarRef, openCommandPalette, paletteInitialMode, showPushModal, showCloneModal, showTaskRunner, showRemoveProjectConfirm,
    // EditorArea（分屏双组：组感知操作按 EditorArea 分组 emit 转调）
    editorAreaRef, openFiles, activeFileIndex, groups, activeGroup, splitOpen, splitDirection, allOpenFiles,
    closeFileInGroup, switchFileInGroup, togglePinTabInGroup, updateContent, saveCurrentFile,
    // 脏点「保存并关闭」（P-20261003-138）：EditorArea saveCloseFile 转调
    saveCloseFileInGroup,
    // tab/编辑器右键「放弃未保存修改」（P-20261005-156）：EditorArea revertFile 转调
    revertFileInGroup,
    // 编码徽标菜单（P-20261002-146）：EditorArea reloadWithEncoding/saveWithEncoding 转调
    reloadFileWithEncoding, saveFileWithEncoding,
    openFileByPath, revealCurrentFileInTree, closeOtherTabsInGroup, closeAllTabsInGroup, closeTabsToRightInGroup,
    closeSavedTabsInGroup, showSettingsModal,
    canReopenClosed, reopenClosedFile,
    openInSplitByPath, closeSplit, reorderGroupTabs,
    // 分屏方向切换（P-20261005-230）：splitDown 键位接线用
    splitDown,
    // 跨组拖签移动（P-20261003-38）：EditorArea tabMove 转调
    moveTabToGroup,
    // 未保存草稿恢复提示条（EditorArea 顶部）
    draftOffer, applyDraftRestore, discardDraftRestore, previewDraftRestore,
    // 远程文件离线横幅重试（P-20261003-15，EditorArea remoteRetry 转调）
    retryRemoteFile,
    // 主区视图
    remoteEverOpened, showRemoteConsole, remoteAutoHost,
    shareEverOpened, showShareManager,
    // BottomPanel
    bottomPanelRef, bottomTab, showBottomPanel, bottomPanelHeight, bottomPanelMaximized,
    bottomPanelEditorMaximized, currentAheadBehind, startBottomResize,
    // StatusBar
    remoteLoading, buildInfo, onSync, copyRemoteUrl,
    // GlobalOverlays
    showCommandPalette, showQuickOpen, showProjectSearch, projectSearchSeed, projectSearchGlobSeed, showOutline,
    showBookmarkList, showTerminalHistorySearch, showTerminalOutputSearch, showTerminalPorts, showSelfCheck,
    paletteFiles, paletteFilesLoading, paletteFilesTruncated, paletteRemoteFiles, paletteCommands, outlineContent, currentFile,
    showInstanceSessions, showInstanceFleet, showFleetNotify, showQrRelay,
    // 舰队批量发起（P-20261003-291）：弹层宿主在 Layout
    showFleetBulkAgent,
    // 导出中心（P-20261003-266）：弹层宿主在 Layout，跳转分发同源
    showExportCenter, handleExportCenterNavigate,
    showShortcutsHelp,
    showHelpCenter,
    // 多剪贴板粘贴（P-20261002-149）：弹层显隐 + 历史选中落位
    showClipboardHistory, pasteClipboardHistory,
    // 跨项目命令历史检索（P-20261004-2）：命中项插入当前终端（无终端降级复制）
    insertTerminalHistoryCommand,
    // 跨会话输出检索（P-20261003-290）：命中项走 activate-terminal 链路跳会话
    jumpToTerminalSession,
    handlePaletteCommand, handlePaletteOpenFile, handlePaletteOpenFileSplit, handleSearchOpenFile, handlePaletteFallbackSearch, fetchAllAheadBehind,
    // 工作现场存档（P-20261002-84）：恢复列表弹层（Layout 宿主挂载 WorkspaceSnapshotModal）
    showSnapshotManager: snapshotApi.showManager,
    snapshotList: snapshotApi.snapshots,
    snapshotListLoading: snapshotApi.listLoading,
    restoreSnapshot: snapshotApi.restoreSnapshot,
    deleteSnapshot: snapshotApi.deleteSnapshot,
    renameSnapshot: snapshotApi.renameSnapshot,
    startNewFileFromEditor,
    openClipboardDiff,
  }
}
