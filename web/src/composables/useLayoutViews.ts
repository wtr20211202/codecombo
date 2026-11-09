import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import type { Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import { useRemoteOpsStore } from '../stores/remoteOps'
import { useLockStore } from '../stores/lock'
import { useNotificationStore } from '../stores/notification'
import { useRemoteHostStore } from '../stores/remoteHost'
import { useBranchStore } from '../stores/branch'
import { useInstanceStore } from '../stores/instance'
import { useLayoutLockStore } from '../stores/layoutLock'
import { OPEN_SETTINGS_EVENT, openSettingsTab } from '../utils/openSettings'
import { OPEN_HELP_EVENT } from '../utils/openHelp'
import { OPS_LOCATE_IN_TREE, OPS_OPEN_FILE_AT, type LocateInTreeDetail } from '../utils/opsEvents'
import { parseFileDeepLinkQuery, type FileDeepLinkTarget } from '../utils/presentAtoms'
import { useAgentTerminal } from './useAgentTerminal'
import { usePanelLayout } from './usePanelLayout'
import { useCompareBaseline } from './useCompareBaseline'
import { useLayoutReset } from './useLayoutReset'
import { useEditorNavHistory, type NavLocation } from './useEditorNavHistory'
import { useEditorBookmarks, isBookmarkablePath, neighborBookmark } from './useEditorBookmarks'
import { useEditorTreeLocate } from './useEditorTreeLocate'
import type { OpenFileOptions } from './useOpenFiles'
import { openCompareExperiment } from './useCompareExperiment'
import { openAgentChains } from './useAgentChain'
import { isRemoteEditorPath } from '../utils/remoteEditorPath'
import { isUntitledPath } from './useOpenFiles'
import { useSnippetShare } from './useSnippetShare'
import { useShareDialog } from './useShareDialog'
import { useClipRelay } from './useClipRelay'
import { usePresentMode } from './usePresentMode'
import { useBranchCheckout } from './useBranchCheckout'
import { useAgentTemplateLaunch } from './useAgentTemplateLaunch'
import { useRuleFileLaunch } from './useRuleFileLaunch'
import { buildDirGlob } from '../utils/dirGlob'

// 折叠命令面板 id → Monaco 内建折叠 action（folding.js 注册，编辑器侧
// runFoldCommand 经 getAction 直触——纯暴露零新折叠逻辑，P-20261006-20）
const FOLD_COMMAND_ACTIONS: Record<string, string> = {
  'fold-all': 'editor.foldAll',
  'unfold-all': 'editor.unfoldAll',
  'fold-level-1': 'editor.foldLevel1',
}

/**
 * Layout 主区三视图互斥/保活、入口携参、命令面板与搜索跳转、
 * 终端联动、标签拖拽重排（自 Layout.vue 抽出的装配胶水）。
 */
export function useLayoutViews(options: {
  showRemoteConsole: Ref<boolean>
  showShareManager: Ref<boolean>
  toggleShareManager: () => void
  showPushModal: Ref<boolean>
  showSettingsModal: Ref<boolean>
  /** 经统一入口打开项目搜索（useQuickNav.openProjectSearch：种子查询词随
   *  之重置，P-20261002-86；seedGlob 为目录搜索 glob 种子，P-20261003-118） */
  openProjectSearch: (seedQuery?: string, seedGlob?: string) => void
  showBottomPanel: Ref<boolean>
  showSidePanel: Ref<boolean>
  bottomTab: Ref<string>
  sideView: Ref<string>
  /** 活跃编辑器文件（useOpenFiles.currentFile 原样透传）：path 供导航/定位，
   *  可选字段供「分享当前文件」判已保存态（P-20261020-8；shell 传完整 OpenFile） */
  currentFile: () => {
    path: string
    name?: string
    content?: string
    originalContent?: string
    loading?: boolean
    isDiff?: boolean
  } | null | undefined
  openFile: (f: { path: string; name: string }, opts?: OpenFileOptions) => void
  openFileByPath: (path: string, opts?: OpenFileOptions) => Promise<void>
  /** 右侧分屏打开（useOpenFiles.openInSplitByPath，P-13）：Quick Open Ctrl/Cmd+Enter 消费（P-20261002-106） */
  openInSplitByPath: (path: string) => Promise<void>
  openDiffView: (p: any) => void
  /** 两文件互比（P-20261002-75）：读两侧内容开 diff，成功返回 true */
  openTwoFilesDiff: (p: { basePath: string; baseName: string; targetPath: string; targetName: string }) => Promise<boolean>
  /** 重新打开最近关闭的编辑器标签（useOpenFiles.reopenClosedFile） */
  reopenClosedTab: () => void
  /** 全部保存（P-20261002-101，useOpenFiles.saveAllFiles：双组脏文件串行落盘
   *  + toast 汇总在函数内闭环） */
  saveAll: () => void
  /** 工作现场存档点（P-20261002-84）：保存当前现场（命名落盘）/ 打开存档列表
   *  （流程编排在 useWorkspaceSnapshot，shell 装配时注入） */
  snapshotSave: () => void
  snapshotOpenManager: () => void
  togglePanel: (p: 'files' | 'changes' | 'todos' | 'stream' | 'env' | 'sync' | 'git' | 'terminal') => void
  toggleRemoteConsole: () => void
  /** 编辑器组临时最大化 toggle（P-20261004-64，命令面板入口）：shell 闭包合成
   *  ——splitOpen 守卫 + activeGroup 取号 + usePanelLayout.toggle 转调 */
  toggleGroupMaximize: () => void
  /** 分屏方向切换（P-20261005-230，命令面板入口）：shell 闭包合成——splitOpen
   *  守卫 + 方向枚举翻转（未分屏 no-op） */
  toggleSplitDirection: () => void
  openShortcutsHelp: () => void
  openHelpCenter: () => void
  openTaskRunner: () => void
  /** 书签列表弹层（P-20261002-131，命令面板「书签列表」入口；弹层宿主在 GlobalOverlays） */
  openBookmarkList: () => void
  /** 跨项目命令历史检索浮层（P-20261004-2，命令面板「搜索命令历史」入口） */
  openTerminalHistorySearch: () => void
  /** 跨会话输出检索浮层（P-20261003-290，命令面板「搜索终端输出」入口） */
  openTerminalOutputSearch: () => void
  /** 端口占用一览浮层（P-20261003-293，命令面板「端口占用一览」入口） */
  openTerminalPorts: () => void
  /** 本机环境体检浮层（P-20261003-317，命令面板「环境体检」入口） */
  openSelfCheck: () => void
  handleFetch: () => Promise<void>
  /** 批量拉取全部项目（useFetchAll 共享封装，P-20261003-309）：面板「Fetch 全部
   *  项目」命令的执行链——通知/摘要/toast 在 composable 内闭环 */
  fetchAllProjects: () => Promise<void>
  handlePull: () => Promise<void>
  cycleTheme: () => void
  currentProjectId: () => string
  hasProject: (id: string) => boolean
  selectProject: (id: string) => boolean | Promise<boolean>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editorAreaRef: () => any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sidePanelRef: () => any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bottomPanelRef: () => any
}) {
  const {
    showRemoteConsole, showShareManager, toggleShareManager,
    showPushModal, showSettingsModal,
    showBottomPanel, showSidePanel, bottomTab, sideView,
    currentFile, openFile, openFileByPath, openDiffView, openTwoFilesDiff,
    openInSplitByPath,
    togglePanel, toggleRemoteConsole, handleFetch, fetchAllProjects, handlePull, cycleTheme, saveAll,
    toggleGroupMaximize, toggleSplitDirection,
    snapshotSave, snapshotOpenManager,
    sidePanelRef, bottomPanelRef,
  } = options
  const remoteOps = useRemoteOpsStore()
  const remoteHostStore = useRemoteHostStore()
  const { t } = useI18n()
  const message = useMessage()
  // 分支检出统一链路（P-20261002-102）：命令面板 checkout:<name> 与
  // GitBranchesSection 右键「切换到」共用（脏区预警 confirm 同链路生效）
  const { checkoutBranch } = useBranchCheckout()
  // 按模板新建会话执行链（P-20261005-10）：命令面板 template:<tid> 直达建会话，
  // 未解析占位符降级对话框预填（setup 期实例化——内部组合式须 setup 上下文）
  const { runTemplateCommand } = useAgentTemplateLaunch(message)
  // 编辑规则文件执行链（P-20261006-43）：命令面板 edit-rule:<name> 存在深链
  // 进编辑器、缺失确认后模板创建（同上：setup 期实例化，useRouter 须上下文）
  const { runRuleFileCommand } = useRuleFileLaunch(message)
  const { toggleDshConsole, closeDshConsole, closeDashboard, openDashboard, openRemoteConsole, closeNotesView, toggleNotesView } = usePanelLayout()
  // 一键重置当前项目布局（P-20261002-74）：confirm 后写回出厂默认并就地重应用
  const { resetLayoutWithConfirm } = useLayoutReset()
  // 多实例会话总览弹层（命令面板入口；组件由 Layout 宿主渲染）
  const showInstanceSessions = ref(false)
  // 实例族总览弹层（P-20261003-56，命令面板 + 实例菜单入口；与会话总览同宿主）
  const showInstanceFleet = ref(false)
  // 跨实例通知聚合弹层（P-20261003-125，命令面板 + 实例菜单 + 族总览联动入口；
  // 与会话总览同宿主姊妹弹层）
  const showFleetNotify = ref(false)
  // 舰队批量发起弹层（P-20261003-291，命令面板「批量 agent 任务」入口；
  // 宿主在 Layout，与会话总览同族）
  const showFleetBulkAgent = ref(false)
  // 导出中心弹层（P-20261003-266，命令面板「导出中心」入口；宿主在 Layout）：
  // 各域导出入口聚合 + 最近导出记录（复用审计动作），跳转分发见 handleExportCenterNavigate
  const showExportCenter = ref(false)
  // 二维码接力弹层（命令面板 + 顶栏双入口；组件由 Layout 宿主渲染）
  const showQrRelay = ref(false)
  const route = useRoute()
  const router = useRouter()

  // 远程控制台/分享管理/智能体管理页/编辑器是主区多种视图（侧栏/顶栏/状态栏常驻，
  // 切换互不销毁）：打开文件/差异视图 = 要编辑代码，自动把主区切回编辑器
  function showEditorMain() {
    showRemoteConsole.value = false
    showShareManager.value = false
    // dsh 控制台不关则 EditorArea 的 v-show 仍为 false，文件会在「看不见的编辑器」
    // 里打开（标签存在、Monaco 高度 0），表现为点了文件没反应
    closeDshConsole()
    // 项目仪表盘（P-20261005-224）同上：开着仪表盘时 EditorArea v-show 为 false，
    // 打开文件意图必须同时收回仪表盘（「看状态」让位「动手」）
    closeDashboard()
    // 笔记独立视图（P-20261108-2，第六主区占用者）同理：开文件意图收回笔记视图
    closeNotesView()
    // 只关 docked 管理页；悬浮窗/悬浮条是全局悬浮层，与编辑器共存
    useAgentTerminal().hideDocked()
  }
  function openFileFromPanel(f: { path: string; name: string }) {
    showEditorMain()
    openFile(f)
  }
  function openDiffFromPanel(p: any) {
    showEditorMain()
    openDiffView(p)
  }

  /** 文件树「与基准对比」（P-20261002-75）：基准态在 useCompareBaseline 模块
   *  单例，跨项目残留按不匹配忽略；一次性语义——diff 成功开出才清基准（被
   *  filePolicy/读取拦下时保留，用户可换一个文件再试或点状态栏取消） */
  function openCompareWithBaseline(target: { path: string; name: string }) {
    const { baseline, clearCompareBaseline } = useCompareBaseline()
    const b = baseline.value
    if (!b || b.projectId !== options.currentProjectId()) return
    showEditorMain()
    void openTwoFilesDiff({
      basePath: b.path,
      baseName: b.name,
      targetPath: target.path,
      targetName: target.name,
    }).then((ok) => { if (ok) clearCompareBaseline() })
  }

  // 远程控制台视图懒挂载 + 保活：首次打开才挂载，之后 v-show 切换（WS 会话不断）
  const remoteEverOpened = ref(false)
  watch(showRemoteConsole, (v) => { if (v) remoteEverOpened.value = true }, { immediate: true })

  // 分享管理视图懒挂载 + 保活（同远程控制台范式）
  const shareEverOpened = ref(false)
  watch(showShareManager, (v) => { if (v) shareEverOpened.value = true }, { immediate: true })

  // 入口携参：?view=remote 打开远程控制台（可选 &host=<id> 自动开终端）——
  // 首页图标 / 设置卡片「终端」按钮经此进入，不再使用独立 /remote 路由；
  // ?view=shares 打开分享管理；?view=dashboard 打开项目仪表盘（P-20261005-224，
  // 通知/agent navigate 的可携参直达入口，与活动栏按钮同链）
  const remoteAutoHost = ref('')
  function consumeViewQuery() {
    const view = route.query.view
    // 主区深链 = 显式要看该视图，docked 管理页须让位（P-20261108-1）：跨路由进入
    // （首页结果卡「管理全部」/设置出域总览卡/ops navigate）时本函数在 Layout
    // setup 期即消费，早于 AgentTerminal 主区互斥反向 watch 的安装（且非
    // immediate）——首页 overlay 带入或按项目记忆恢复的 docked 页不会收起，与目标
    // 视图叠成双视图。只收 docked，悬浮窗/悬浮条不动（showEditorMain 同款）；
    // 项目内深链反向 watch 本也会收，幂等零语义变化
    if (view === 'remote' || view === 'shares' || view === 'dashboard') useAgentTerminal().hideDocked()
    if (view === 'remote') {
      showRemoteConsole.value = true
      remoteAutoHost.value = (route.query.host as string) || ''
      // 深链直写不经 toggle 的互斥分支：仪表盘/笔记视图在场时一并收回（防双视图叠加）
      closeDashboard()
      closeNotesView()
      router.replace({ path: '/project' })
    } else if (view === 'shares') {
      toggleShareManager()
      router.replace({ path: '/project' })
    } else if (view === 'dashboard') {
      openDashboard()
      router.replace({ path: '/project' })
    }
  }
  watch(() => route.query.view, consumeViewQuery, { immediate: true })

  // 文件深链（P-20261002-49）：/project?file=<相对路径>[&project=<id>][&line=N][&col=M]
  // 直达编辑器（line/col 带行定位为 P-20261003-302 扩展，agent 经 navigate 事件/通知
  // 携带 file?line=N 深链即行级直达；diff=1 为 P-20261005-223 扩展——navigate
  // {view:'diff'} 落成此形态，开 vs HEAD 工作区 diff，行定位语义不适用故忽略 line/col），
  // 与 ?view= 同款 query 消费模式（编辑器 tab 右键「复制文件链接」产出的链接经此回环）。
  // 但消费时点必须晚于 bootstrap：uiState 恢复（restoreLayoutState）会 setCurrentProject
  // 并恢复旧项目的标签，而 useOpenFiles 按项目隔离标签——深链若先行打开，会随后续
  // 项目切换的「清空打开文件」watcher 一起被清掉。挂载早期只捕获挂起，bootstrap 完成
  // 后由 shell 调 flushFileDeepLink 消费；此后 SPA 内再入（query 变化）即时消费。
  // query 解析收口 utils/presentAtoms.parseFileDeepLinkQuery（P-20261022-3：与
  // 服务端原子能力注册表深链表镜像对账 + 路由别名产出同参，双向锁死）
  const pendingFileQuery = ref<FileDeepLinkTarget | null>(null)
  let fileQueryReady = false

  async function openDeepLinkedFile(p: FileDeepLinkTarget) {
    // 深链意图是「看文件/diff」：远程控制台等视图激活时文件会开进不可见编辑器，先切回主区
    showEditorMain()
    // 先行切项目（跨设备链接完整语义）；目标项目已不在列表（被移除/异实例）则整条
    // 放弃——路径相对项目根，落错项目会静默打开同名异实文件（同 handleTerminalOpenFile 口径）
    if (p.project && p.project !== options.currentProjectId() && options.hasProject(p.project)) {
      // 切换守卫取消（未保存草稿确认选「取消」）→ 整条放弃：路径相对项目根，
      // 留在原项目打开会命中同名异实文件（同 handleTerminalOpenFile 口径）
      if ((await options.selectProject(p.project)) === false) return
      // 等项目切换的「清空打开文件」watcher 先落：否则紧随其后打开的标签
      // 会被该 watcher 一起清掉（handleTerminalOpenFile 同款时序）
      await nextTick()
    }
    // diff 直达（P-20261005-223 navigate {view:'diff'} / ?diff=1）：与审批卡 target
    // 预览同参开「vs HEAD 工作区差异」（右版即工作区）；diff 是对比视图无行定位
    // 语义，line/col 忽略
    if (p.diff) {
      openDiffFromPanel({ path: p.file, name: p.file.split('/').pop() || p.file, oldRef: 'HEAD' })
      return
    }
    // 预览类来源（P-20261002-50）：深链意图是「看文件」，走预览位复用
    await openFileByPath(p.file, { preview: true })
    // 带行深链（P-20261003-302）：与 handleSearchOpenFile 共用行定位轮询
    //（Monaco 异步就绪竞态已在其内处理）
    if (p.line) revealEditorLine(p.line, p.col)
  }

  function consumeFileQuery() {
    // 解析收口 presentAtoms.parseFileDeepLinkQuery：file 缺失 = 非深链早退
    //（query 不清，等待真深链再入）；形态防呆（line/col 越界/非数值忽略等）
    // 与深链参数全集的对账都在该纯函数内
    const parsed = parseFileDeepLinkQuery(route.query as Record<string, unknown>)
    if (!parsed) return
    // bootstrap 未完成或锁定态（消费必败）：只捕获不清 query——实例切换 remount
    // 后新 Layout 仍能从 URL 重新捕获；清 query 延迟到消费时（防刷新重复打开）
    pendingFileQuery.value = parsed
    if (!fileQueryReady || useLockStore().isLocked) return
    // 已就绪（SPA 内再入：agent navigate / 通知深链 router.push 而来）：捕获后
    // 即时消费。顺带修复（P-20261003-302）：原实现此分支直接消费旧 pending——
    // 挂起早已被消费置空，SPA 再入的新 query 从未入队，注释承诺的「即时消费」
    // 实为 no-op；本提案 agent 深链带行（navigate 事件）恰好依赖该路径
    void consumePendingFileQuery()
  }
  watch(() => route.query.file, consumeFileQuery, { immediate: true })

  /** 消费挂起深链（清 query → 切项目 → 打开）；无挂起时为空操作 */
  function consumePendingFileQuery() {
    const p = pendingFileQuery.value
    if (!p) return Promise.resolve()
    pendingFileQuery.value = null
    if (route.query.file !== undefined) router.replace({ path: '/project' })
    return openDeepLinkedFile(p)
  }

  /** bootstrap 完成（uiState 项目/标签恢复落定）后由 useLayoutShell 调用：消费挂起深链 */
  async function flushFileDeepLink() {
    fileQueryReady = true
    // 锁定态消费必败（API 全被 423 拒，readFile 失败即丢链接）：保持挂起与
    // query 原样，等解锁 watcher 接力（分享对象实例在锁定的场景）
    if (useLockStore().isLocked) return
    await consumePendingFileQuery()
  }

  /** 是否有挂起未消费的文件深链（P-20261005-224 仪表盘默认落点裁决用：
   *  深链意图是「看文件」，落点让位——避免先开仪表盘又被 flush 收回的闪动） */
  function hasPendingFileDeepLink(): boolean {
    return pendingFileQuery.value !== null
  }

  // 解锁接力：锁定期间到达的深链在解锁后消费（query 未清，URL 仍是完整深链）
  watch(() => useLockStore().isLocked, (locked) => {
    if (locked || !fileQueryReady) return
    void consumePendingFileQuery()
  })

  /** 命令面板主机命令 id → 主机名（找不到回退 id） */
  function hostNameOf(id: string): string {
    return remoteHostStore.hosts.find(h => h.id === id)?.name || id
  }

  // 深层组件（AI 结果面板等）经 window 事件请求打开设置：置 show 后由 GlobalOverlays 渲染，
  // 分区定位由 SettingsModal 监听同一事件自行切 tab
  function onOpenSettingsRequest() {
    showSettingsModal.value = true
  }
  onMounted(() => window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsRequest))
  onBeforeUnmount(() => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsRequest))

  // 深层组件（新建会话对话框安装指引等）经 window 事件请求打开帮助中心：
  // 宿主只管置 show，锚点条目由 HelpCenter 监听同一事件自行展开定位（openHelp 同款分工）
  function onOpenHelpRequest() {
    options.openHelpCenter()
  }
  onMounted(() => window.addEventListener(OPEN_HELP_EVENT, onOpenHelpRequest))
  onBeforeUnmount(() => window.removeEventListener(OPEN_HELP_EVENT, onOpenHelpRequest))

  // 终端文件链接 → 编辑器打开（OPS_OPEN_FILE_AT 由 useTerminalFileLinks 点击派发）
  onMounted(() => window.addEventListener(OPS_OPEN_FILE_AT, onTerminalOpenFileEvent))
  onBeforeUnmount(() => window.removeEventListener(OPS_OPEN_FILE_AT, onTerminalOpenFileEvent))

  // 文件树定位事件兜底适配层（P-20261022-3）：OPS_LOCATE_IN_TREE 的接收方
  // FileTreeView 随侧栏 v-if 挂载——侧栏不在 files 视图（或整体收起）时事件
  // 无人监听会静默丢失。内部派发方（useEditorTreeLocate/useTerminalTreeLocate）
  // 已自做「先切视图」预处理，但 agent 上报链（ops-notify locate-in-tree 直通
  // 分发）与「侧栏整体收起」形态此前无兜底：本适配层只在「树未挂载」时介入
  // （切回 files 视图 + 展开侧栏，等重挂注册好监听再重派发同一契约事件）；
  // 树挂载中（files 视图且侧栏可见）让位给 FileTreeView 既有接收链，事件只
  // 消费一次。重派发对适配层自身收敛：介入后 files+可见成立，二次到达直接返回
  async function onLocateInTreeFallback(e: Event) {
    const detail = (e as CustomEvent<LocateInTreeDetail>).detail
    if (!detail) return
    // 项目不符契约同 FileTreeView 接收链（忽略）：适配层也不为异项目事件切换视图
    if (detail.projectId !== options.currentProjectId()) return
    const layout = usePanelLayout()
    if (layout.sideView.value === 'files' && layout.showSidePanel.value) return
    layout.sideView.value = 'files'
    layout.showSidePanel.value = true
    await nextTick()
    window.dispatchEvent(new CustomEvent<LocateInTreeDetail>(OPS_LOCATE_IN_TREE, { detail }))
  }
  onMounted(() => window.addEventListener(OPS_LOCATE_IN_TREE, onLocateInTreeFallback))
  onBeforeUnmount(() => window.removeEventListener(OPS_LOCATE_IN_TREE, onLocateInTreeFallback))

  // 同步操作：先拉取，再弹出推送对话框（原 handlePush 逻辑已移至 PushDialog 组件）
  async function onSync() {
    await handlePull()
    showPushModal.value = true
  }

  // 导出中心「前往」跳转分发（P-20261003-266）：域 id 与 utils/exportCenter
  // 注册表锚点一致。统一「跳」语义（ensure-open，非 toggle——重复点不收起）：
  // 会话→agent 管理页（会话中心批量 zip/回放导出所在）、部署/审计→设置对应
  // 分区、变更→侧栏变更视图（导出补丁下拉所在）。未落地域（占位行）不产出
  // 导航，未知 id 静默忽略（渐进接线的防御面）
  function handleExportCenterNavigate(id: string) {
    switch (id) {
      case 'session': void useAgentTerminal().open('docked'); break
      case 'deploy': openSettingsTab('deploy'); break
      case 'audit': openSettingsTab('security'); break
      case 'changes': {
        // 侧栏变更视图 ensure-open（「点啥显示啥」同规矩：先还原被最大化面板）
        usePanelLayout().restoreFromMaximized()
        options.sideView.value = 'changes'
        options.showSidePanel.value = true
        break
      }
    }
  }

  function handlePaletteCommand(id: string) {
    // 项目快速切换（命令面板 switch-project:<id>）
    if (id.startsWith('switch-project:')) {
      const pid = id.slice('switch-project:'.length)
      if (pid !== options.currentProjectId() && options.hasProject(pid)) {
        options.selectProject(pid)
      }
      return
    }
    // 分支快速切换（命令面板 checkout:<name>，P-20261002-102）：与 GitBranchesSection
    // 右键检出同一链路（脏区预警自然生效）；已在目标分支时空操作。成功后刷新
    // branch store 清单（面板下次打开即反映新当前分支；WS branch.changed 兜底）
    if (id.startsWith('checkout:')) {
      const name = id.slice('checkout:'.length)
      const branchStore = useBranchStore()
      if (branchStore.localBranches.some(b => b.isCurrent && b.name === name)) return
      const pid = options.currentProjectId()
      checkoutBranch(pid, name, () => { void branchStore.fetchBranches(pid) })
      return
    }
    // 实例快速切换（命令面板 switch-instance:<id>，P-20261002-111）：与多实例
    // 总览 InstanceSessionOverview.switchTo 同链路——store.selectInstance 自带
    // 幂等守卫（目标不存在/已是当前实例 no-op）、切换前未保存确认
    // （registerBeforeSwitchHook）与切换遮罩；离线实例不在此二次确认（总览同口径，
    // 仅菜单入口 InstanceSwitcher 做离线确认）
    if (id.startsWith('switch-instance:')) {
      void useInstanceStore().selectInstance(id.slice('switch-instance:'.length))
      return
    }
    // 按模板新建会话（命令面板 template:<tid>，P-20261005-10）：占位符全解析
    // 直达建会话并激活（跳过对话框——模板即已定配置）；上下文缺失降级对话框
    // 预填该模板（P-16「原样保留+提示」，链路在 useAgentTemplateLaunch）
    if (id.startsWith('template:')) {
      void runTemplateCommand(id.slice('template:'.length))
      return
    }
    // 编辑规则文件（命令面板 edit-rule:<name>，P-20261006-43）：存在即文件深链
    // 进编辑器、缺失确认后从模板创建并打开（链路在 useRuleFileLaunch）
    if (id.startsWith('edit-rule:')) {
      void runRuleFileCommand(id.slice('edit-rule:'.length))
      return
    }
    // 连接主机（命令面板 connect-host:<id>，P-20261005-218）：跨页一步直连——
    // 跳远程视图（ensure-open 语义，openRemoteConsole）+ 经 remoteAutoHost 既有
    // 深链桥选中该主机（RemoteConsoleView.tryAutoOpen→focusHost 复用卡片点击
    // 语义：已有终端聚焦最近、无则新开）。palette 关闭走面板自身常规链
    if (id.startsWith('connect-host:')) {
      openRemoteConsole()
      remoteAutoHost.value = id.slice('connect-host:'.length)
      return
    }
    // 远程主机运维命令（useQuickNav 按主机列表动态生成）
    if (id.startsWith('diag-host:')) {
      remoteOps.openDiagnose(id.slice('diag-host:'.length), hostNameOf(id.slice('diag-host:'.length)))
      return
    }
    if (id.startsWith('exec-host:')) {
      remoteOps.openExec(id.slice('exec-host:'.length), hostNameOf(id.slice('exec-host:'.length)))
      return
    }
    // 多主机巡检对比（P-20261004-58）：机队级命令，主机勾选在弹窗内完成
    if (id === 'diag-compare-batch') {
      remoteOps.openDiagCompare()
      return
    }
    // 设置分区直达（useQuickNav 生成的 settings:<key> 锚点）：走 window 事件通道——
    // 宿主置 show、SettingsModal 定位分区，与深层组件「去设置」同一链路
    if (id.startsWith('settings:')) {
      openSettingsTab(id.slice('settings:'.length))
      return
    }
    switch (id) {
      case 'toggle-files': togglePanel('files'); break
      // 笔记独立视图直达（P-20261107-2 → P-20261108-2 侧栏 notes 视图退役）：主区
      // 视图 toggle，与活动栏 rail 同链（docked 管理页由 AgentTerminal 反向 watch 收）
      case 'toggle-notes': toggleNotesView(); break
      // 跨项目实时变更流（P-20261003-232）：打开活动栏独立面板（值班大屏卡
      // 之外的 IDE 内入口；面板自管轮询）
      case 'change-stream': togglePanel('stream'); break
      // 项目环境画像（P-20261007-14）：打开活动栏独立面板（端口观测/哨兵/
      // 部署目标一页简历；面板自管加载）
      case 'env-profile': togglePanel('env'); break
      // 多实例同步中心（P-20261023-1）：打开活动栏独立面板
      case 'sync-center': togglePanel('sync'); break
      case 'toggle-git': togglePanel('git'); break
      case 'toggle-terminal': togglePanel('terminal'); break
      case 'new-terminal': {
        // 打开底部终端 tab 后创建：TerminalView.createTerminal 负责激活新 tab
        options.togglePanel('terminal')
        const tv = options.bottomPanelRef()?.terminalRef as { createTerminal?: () => void } | undefined
        void tv?.createTerminal?.()
        break
      }
      case 'toggle-dsh': toggleDshConsole(); break
      // 编辑器组临时最大化（P-20261004-64）：命令面板入口（tab 条双击同款动作）；
      // 未分屏 no-op（守卫在 shell 闭包）
      case 'toggle-group-maximize': toggleGroupMaximize(); break
      // 分屏方向切换（P-20261005-230）：命令面板入口（splitDown 键位同族动作）；
      // 未分屏 no-op（守卫在 shell 闭包）
      case 'toggle-split-direction': toggleSplitDirection(); break
      case 'instance-sessions': showInstanceSessions.value = true; break
      // 对比实验（P-20261003-46）：全局单例面板直开（agent 管理页头部同源）
      case 'compare-experiment': openCompareExperiment(); break
      // 会话接续链（P-20261004-38）：全局单例面板直开（agent 管理页头部同源）
      case 'agent-chains': openAgentChains(); break
      case 'instance-fleet': showInstanceFleet.value = true; break
      // 布局锁定（P-20261003-180）：防误拖 toggle（顶栏小锁同源双入口）
      case 'toggle-layout-lock': useLayoutLockStore().toggle(); break
      // 跨实例通知聚合（P-20261003-125）：fleet 值守面，所有实例通知一屏聚合
      case 'fleet-notify': showFleetNotify.value = true; break
      // 舰队批量发起（P-20261003-291）：多选项目 + 一段指令逐项目起 agent 会话
      //（发起流程与逐条回告在弹层内闭环）
      case 'fleet-bulk-agent': showFleetBulkAgent.value = true; break
      // 导出中心（P-20261003-266）：各域导出入口聚合弹层（宿主在 Layout）
      case 'export-center': showExportCenter.value = true; break
      case 'monitor':
        // 值班大屏（P-20261002-80）：独立于 Layout 的全屏路由，跳转即离开 IDE 主布局
        router.push({ name: 'monitor' })
        break
      // 「Fetch 全部项目」走批量链路（P-20261003-309 修正标签/行为错位：标题
      // 承诺全量就打 /fetch-all，逐仓明细通知在 useFetchAll 内闭环）；
      // 单仓 fetch 另立 fetch-current（与 pull/push 当前分支同族）
      case 'fetch': void fetchAllProjects(); break
      case 'fetch-current': handleFetch(); break
      case 'pull': handlePull(); break
      case 'push': showPushModal.value = true; break
      case 'settings': showSettingsModal.value = true; break
      // 项目规则管理（P-20261006-43）：设置弹窗直达通用分区 ProjectRulesManager
      // 区块——openSettingsTab 携区块锚点（useSettingsSearch.revealAnchor 滚动定位+闪烁）
      case 'project-rules': openSettingsTab('general', 'settings-project-rules'); break
      case 'shortcuts-help': options.openShortcutsHelp(); break
      case 'help-center': options.openHelpCenter(); break
      case 'remote-console': toggleRemoteConsole(); break
      case 'share-manager': toggleShareManager(); break
      // 分享当前文件（P-20261020-8）：活动编辑器 tab 的项目内已保存文件 →
      // useShareDialog.createShare 打开既有创建弹层（敏感扫描/口令/结果卡全链
      // 复用，零新请求路径）。命令按信标条件注册，此处再防一次远程/草稿/脏态
      // 与空项目（createShare 自身也有 projectId 空守卫，双保险）
      case 'share-current-file': {
        const f = options.currentFile()
        if (!f) break
        // diff 标签无磁盘目标（活动信标不随 diff 更新，命令可能仍处于注册态）：
        // 误点给提示而非静默无反应（fold 族无编辑器提示同口径）
        if (f.isDiff) {
          message.warning(t('share.currentFile.unavailable'))
          break
        }
        if (isRemoteEditorPath(f.path) || isUntitledPath(f.path)) {
          message.warning(t('share.currentFile.unavailable'))
          break
        }
        if (f.loading || f.content !== f.originalContent) {
          message.warning(t('share.currentFile.saveFirst'))
          break
        }
        const pid = options.currentProjectId()
        if (!pid) {
          message.warning(t('share.newShare.noProject'))
          break
        }
        useShareDialog().createShare(pid, f.path, f.name)
        break
      }
      // 项目仪表盘（P-20261005-224）：主区视图直达；深链 query 同链（openDashboard
      // 幂等开 + 主区互斥），开文件意图经 showEditorMain 收回（closeDashboard）
      case 'dashboard': openDashboard(); break
      // 跨设备剪贴板中继（P-20261002-32）：读本机剪贴板发往服务端单槽，其他
      // 已解锁设备 toast 点击取走（发送/取走动作与 toast 点击共用 useClipRelay）
      case 'clip-send': void useClipRelay(message).sendLocalClipboard(); break
      case 'share-snippet': {
        // 文本片段分享（P-20261002-71）：预填活跃编辑器选区（无选区/未开
        // 文件 = 空内容开弹窗，用户就地粘贴任意文本）
        const sel = (options.editorAreaRef()?.monacoEditorRef as
          | { getSelectedText?: () => string }
          | null
          | undefined)?.getSelectedText?.() || ''
        useSnippetShare().openShareSnippet(sel)
        break
      }
      case 'qr-relay': showQrRelay.value = true; break
      case 'search-project': options.openProjectSearch(); break
      case 'insert-snippet': {
        // 编辑器「插入片段」（P-20261002-44）：走活跃编辑器暴露的方法开选择器
        // （选片段/插入都在 MonacoEditor 内闭环）；无活跃编辑器 = 未打开文件，
        // 就地提示而非静默失败
        const monaco = options.editorAreaRef()?.monacoEditorRef as
          | { openSnippetInsertPicker?: () => boolean }
          | null
          | undefined
        if (!monaco?.openSnippetInsertPicker?.()) {
          message.warning(t('snippet.code.noFile'))
        }
        break
      }
      case 'toggle-theme': cycleTheme(); break
      case 'task-runner': options.openTaskRunner(); break
      // 运行书面板（P-20261003-24）：确保底部终端分区可见后打开面板。
      // TerminalView 随 bottomTab v-if 挂载，ref 未就绪时短轮询重试
      //（handleSearchOpenFile 的 Monaco 就绪同范式）
      case 'runbook': {
        bottomTab.value = 'terminal'
        showBottomPanel.value = true
        const deadline = Date.now() + 2000
        const tick = () => {
          const tv = options.bottomPanelRef()?.terminalRef as
            | { openRunbookPanel?: () => void }
            | null
            | undefined
          if (tv?.openRunbookPanel) {
            tv.openRunbookPanel()
            return
          }
          if (Date.now() < deadline) setTimeout(tick, 50)
        }
        setTimeout(tick, 50)
        break
      }
      // 书签列表弹层（P-20261002-131）：跳转由弹层 navigate 事件走
      // handleSearchOpenFile 既有链（Layout 接线）
      case 'bookmark-list': options.openBookmarkList(); break
      // 跨项目命令历史检索浮层（P-20261004-2）：点选插入由浮层 insert 事件走
      // 宿主 insertTerminalHistoryCommand 链（useLayoutShell 接线）
      case 'search-terminal-history': options.openTerminalHistorySearch(); break
      // 跨会话输出检索浮层（P-20261003-290）：点选跳转由浮层 jump 事件走
      // 宿主 jumpToTerminalSession（useApprovalActions.jumpToSession 链路）
      case 'search-terminal-output': options.openTerminalOutputSearch(); break
      // 端口占用一览浮层（P-20261003-293）：点选条目同走 jumpToTerminalSession
      // 既有链路直达占用方终端
      case 'terminal-ports': options.openTerminalPorts(); break
      // 本机环境体检浮层（P-20261003-317）：打开即体检（只读，无副作用）
      case 'self-check': options.openSelfCheck(); break
      case 'agent-terminal': useAgentTerminal().toggleDocked(); break
      case 'notifications': useNotificationStore().open(); break
      case 'lock-system': useLockStore().lock(); break
      case 'reopen-closed-tab':
        // 重开前把主区切回编辑器：远程控制台等视图激活时文件会开进不可见编辑器
        showEditorMain()
        options.reopenClosedTab()
        break
      // 全部保存（P-20261002-101）：保存作用于已打开文件对象，与主区当前可见
      // 视图无关，无需像 reopen 那样先切回编辑器主区
      case 'save-all':
        saveAll()
        break
      // 编辑器导航后退/前进（P-20261002-51）：navRestore 内含 showEditorMain
      case 'navigate-back':
        navBack()
        break
      case 'navigate-forward':
        navForward()
        break
      // 定位当前文件到树（P-20261003-294）：无活动文件 no-op（命令按活动文件
      // 信标条件注册，此处纯防御）
      case 'locate-in-tree': {
        const f = currentFile()
        if (f) void locateInTree(f.path)
        break
      }
      // 折叠控制（P-20261006-20）：活跃编辑器内建折叠 action 直触（MonacoEditor
      // runFoldCommand 暴露转调）。活跃组无 Monaco 实例（diff 标签/元信息卡/
      // loading 窗口）返回 false → 就地提示而非静默失败（insert-snippet 同款防御）
      case 'fold-all':
      case 'unfold-all':
      case 'fold-level-1': {
        // 映射键与 case 标签一一对应；?? '' 仅 noUncheckedIndexedAccess 的查表兜底
        const actionId = FOLD_COMMAND_ACTIONS[id] ?? ''
        const ed = options.editorAreaRef()?.monacoEditorRef as
          | { runFoldCommand?: (actionId: string) => boolean }
          | null
          | undefined
        if (!actionId || !ed?.runFoldCommand?.(actionId)) {
          message.warning(t('commandPalette.foldNoEditor'))
        }
        break
      }
      case 'reset-layout':
        // 一键重置当前项目布局（P-20261002-74）：confirm 在 useLayoutReset 内闭环
        void resetLayoutWithConfirm()
        break
      case 'present-mode': {
        // 投屏演示模式（P-20261002-45）：toggle 语义——再次执行退出还原；
        // toast 明示退出通道（字号/面板变化肉眼可见，如何退出不可见）
        const present = usePresentMode()
        present.toggle()
        message.success(t(present.active.value ? 'present.mode.entered' : 'present.mode.exited'))
        break
      }
      // 工作现场存档点（P-20261002-84）：保存/恢复流程在 useWorkspaceSnapshot 闭环
      case 'snapshot-save':
        snapshotSave()
        break
      case 'snapshot-restore':
        void snapshotOpenManager()
        break
    }
  }

  function handlePaletteOpenFile(path: string, line?: number, col?: number) {
    // 文件名:行号直达（P-20261003-302）：带 :N 的选中走 handleSearchOpenFile
    // 既有链（预览位 + 行定位轮询现成，showEditorMain 内含）；无行号维持原语义
    if (line) {
      void handleSearchOpenFile(path, line, col)
      return
    }
    const name = path.split('/').pop() || path
    showEditorMain()
    // 预览类来源（P-20261002-50）：Quick Open/命令面板选文件是浏览动作，
    // 未编辑预览位复用替换，不再每次堆积一个永久 tab
    openFile({ path, name }, { preview: true })
  }

  /** Quick Open 文件模式 Ctrl/Cmd+Enter（P-20261002-106）：选中文件进右侧分屏组
   *  （「搜到即对照」一步到位，P-13 openInSplitByPath 既有链路）。同打开链路先
   *  切回编辑器主区——远程控制台/dsh 下呼出 Quick Open 时文件不能开进「看不见
   *  的编辑器」 */
  function handlePaletteOpenFileSplit(path: string) {
    showEditorMain()
    void openInSplitByPath(path)
  }

  // 搜索结果：打开文件并跳转到指定行（列可选：终端文件链接带 :LINE:COL 时精确定位）
  async function handleSearchOpenFile(path: string, line?: number, col?: number) {
    showEditorMain()
    // 预览类来源（P-20261002-50）：搜索跳转/终端文件链接同为浏览动作，走预览位
    await openFileByPath(path, { preview: true })
    if (!line) return
    revealEditorLine(line, col)
  }

  /** 行定位（handleSearchOpenFile / 深链 &line= 共用，P-20261003-302 抽取）：
   *  等 Monaco 内容就绪后再执行——首次打开时内容经异步读取 → Vue 渲染 →
   *  Monaco model 更新，固定延时与之竞态（症状：打开后停在文件顶部）。改为轮询
   *  模型行数 ≥ 目标行才 reveal（上限 ~2s；目标行超出文件行数则不定位，停在顶部，
   *  深链越界行号复用同一兜底） */
  function revealEditorLine(line: number, col?: number) {
    const deadline = Date.now() + 2000
    const tick = () => {
      const ed = (options.editorAreaRef()?.monacoEditorRef as any)?.getEditor?.() as
        | { getModel?: () => { getLineCount?: () => number } | null; revealLineInCenter?: (l: number) => void; setPosition?: (p: { lineNumber: number; column: number }) => void; focus?: () => void }
        | undefined
      // MonacoEditor 为异步组件（safeAsync 懒加载），getEditor 在实例就绪前为空——
      // 一并纳入轮询等待，而非立即放弃
      if (!ed) {
        if (Date.now() < deadline) setTimeout(tick, 50)
        return
      }
      const lineCount = ed.getModel?.()?.getLineCount?.() ?? 0
      if (lineCount < line) {
        if (Date.now() < deadline) setTimeout(tick, 50)
        return
      }
      ed.revealLineInCenter?.(line)
      ed.setPosition?.({ lineNumber: line, column: col || 1 })
      ed.focus?.()
    }
    setTimeout(tick, 60)
  }

  // ── 编辑器导航历史（P-20261002-51；P-20261002-148 增量：恢复带列号）：栈在
  // useEditorNavHistory 模块单例（MonacoEditor 光标上报、快捷键、命令面板三处
  // 消费），本文件承担接线：活跃 tab 变化上报锚点、项目切换整体作废（路径相对
  // 项目根）、后退/前进恢复复用 handleSearchOpenFile 既有链（必要时切回编辑器
  // 主区 + 开文件 + 行定位轮询——导航目标已关闭即由此重开；col 经同形参落到
  // setPosition，占位锚点无列时其 || 1 缺省）
  const navHistory = useEditorNavHistory()
  const bookmarks = useEditorBookmarks()
  watch(() => options.currentProjectId(), (pid) => { navHistory.beginSession(pid || '') }, { immediate: true })
  watch(() => options.currentFile()?.path || '', (p) => { navHistory.notifyActiveFile(p) })

  function navRestore(loc: NavLocation) {
    void handleSearchOpenFile(loc.path, loc.line, loc.column)
  }
  function navBack() {
    navHistory.navigateBack(navRestore)
  }
  function navForward() {
    navHistory.navigateForward(navRestore)
  }

  // ── 书签间跳转（P-20261004-102，Alt+PgUp/PgDn）：环形序上/下一个书签。序取
  // listBookmarksOf 的全局排序（路径字典序 × 行升序），相邻判定在
  // neighborBookmark 纯函数（useEditorBookmarks，锚点=活跃文件+光标行）；跨文件
  // 复用书签列表弹层同款 handleSearchOpenFile「开文件+行定位轮询」链——目标
  // 未打开即由此打开（preview 位，浏览动作语义）。书签状态是懒加载的模块单例
  //（boot 后 MonacoEditor 首个编辑器已 ensureLoaded 预热，此处再调幂等），
  // ensureLoaded 就绪后再取表：首次会话未装载完成时按键不误跳空表
  function bookmarkJump(delta: number) {
    const pid = options.currentProjectId()
    if (!pid) return
    void bookmarks.ensureLoaded().then(() => {
      const file = currentFile()
      const path = file && isBookmarkablePath(file.path) ? file.path : ''
      const loc = navHistory.activeLocation.value
      const anchor = path
        ? { path, line: loc && loc.path === path ? loc.line : 0 }
        : null
      const target = neighborBookmark(bookmarks.listBookmarksOf(pid), anchor, delta === -1 ? -1 : 1)
      if (!target) return
      void handleSearchOpenFile(target.path, target.line)
    })
  }
  /** 门控计数（useLayoutKeyboard veto 用）：无书签时按键放行浏览器（越界放行惯例）。
   *  读内存单例零 IO——热路径上仅按键时刻一次 O(条目数) 遍历 */
  function bookmarkJumpCount(): number {
    return bookmarks.listBookmarksOf(options.currentProjectId()).length
  }

  // 终端文件链接激活（useTerminalFileLinks 点击派发）：必要时先切到链接归属项目
  // （终端在项目 A 报错、用户正浏览项目 B 的场景），再走「打开 + 行定位」既有链路
  async function handleTerminalOpenFile(e: Event) {
    const d = (e as CustomEvent).detail as { path?: string; projectId?: string; line?: number; col?: number; diffVsHead?: boolean } | undefined
    if (!d?.path) return
    if (d.projectId) {
      if (!options.hasProject(d.projectId)) return // 项目已被移除：路径无处落，忽略
      if (d.projectId !== options.currentProjectId()) {
        // 切换守卫取消（未保存草稿确认选「取消」）→ 放弃打开（同深链口径）
        if ((await options.selectProject(d.projectId)) === false) return
        // 等项目切换的「清空打开文件」watcher 先落（useOpenFiles 按项目隔离
        // 标签）：否则紧随其后打开的标签会被该 watcher 一起清掉
        await nextTick()
      }
    }
    // 审批卡 target 预览（P-20261003-47）：diffVsHead = 派发方已探测到未提交
    // 差异，直开 vs HEAD 差异视图（showEditorMain 先切回编辑器主区，同面板
    // 打开链口径——远程控制台等视图激活时不能开进「看不见的编辑器」）
    if (d.diffVsHead) {
      openDiffFromPanel({ path: d.path, name: d.path.split('/').pop() || d.path, oldRef: 'HEAD' })
      return
    }
    await handleSearchOpenFile(d.path, d.line, d.col)
  }
  function onTerminalOpenFileEvent(e: Event) { void handleTerminalOpenFile(e) }

  // 面包屑：在文件树中显示当前文件
  function revealCurrentFileInTree() {
    if (!currentFile()) return
    // 切到文件视图并展开树
    sideView.value = 'files'
    showSidePanel.value = true
    nextTick(() => {
      sidePanelRef()?.fileTreeRef?.revealFile(currentFile()!.path)
    })
  }

  // 在文件树中定位（P-20261003-294）：命令面板「定位当前文件到树」执行链——
  // 活动 tab 项目相对路径派发 OPS_LOCATE_IN_TREE（tab 右键菜单同一事件契约；
  // 接收方保证侧栏可见 + 退最大化 + 清树搜索 + 逐层展开 + 滚动定位）
  const { locateInTree } = useEditorTreeLocate()

  // 文件树目录右键「在此目录打开终端」（P-20261005-192）：目录级终端直达——
  // 调创建链（POST /terminals dir 参数）在该目录起真实会话并激活，替代旧
  // 「向活动会话注入 cd 文本」形态：旧形态依赖已有会话（无会话时静默无效）、
  // 占用一条命令历史且每次重复；新会话首 prompt 即在目标目录，服务端守卫存在
  // 性与项目根内（越界 400 稳定原文）。双 nextTick 与 sendToTerminal 同口径
  // （v-if 挂载 TerminalView 后 ref 才就绪）
  function openInTerminal(dirPath: string) {
    bottomTab.value = 'terminal'
    showBottomPanel.value = true
    nextTick(() => {
      nextTick(() => {
        const tv = options.bottomPanelRef()?.terminalRef as { createTerminal?: (dir?: string) => Promise<void> } | undefined
        void tv?.createTerminal?.(dirPath)
      })
    })
  }

  // 文件树目录右键「在此目录搜索」（P-20261003-118）：查询词留空、glob 预填
  // dir/**（合成与元字符转义收口 utils/dirGlob 单一事实源），经 useQuickNav
  // 统一入口打开（种子一次性语义随之重置）
  function searchInDir(relDir: string) {
    options.openProjectSearch('', buildDirGlob(relDir))
  }

  return {
    showEditorMain, openFileFromPanel, openDiffFromPanel, openCompareWithBaseline,
    remoteEverOpened, remoteAutoHost, shareEverOpened,
    showInstanceSessions, showInstanceFleet, showFleetNotify, showQrRelay, showFleetBulkAgent,
    showExportCenter, handleExportCenterNavigate,
    handlePaletteCommand, handlePaletteOpenFile, handlePaletteOpenFileSplit, handleSearchOpenFile,
    navBack, navForward, bookmarkJump, bookmarkJumpCount,
    revealCurrentFileInTree, openInTerminal, searchInDir, onSync,
    flushFileDeepLink,
    hasPendingFileDeepLink,
  }
}
