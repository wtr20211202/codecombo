import { ref, computed, onScopeDispose, toValue, type MaybeRefOrGetter } from 'vue'
import { useProjectStore } from '../stores/project'
import { useRemoteHostStore } from '../stores/remoteHost'
import { useBranchStore } from '../stores/branch'
import { useInstanceStore } from '../stores/instance'
import {
  collectProjectFileList, swrTtlMs,
  type PaletteFileItem,
} from './projectFileList'
import { useI18n } from './useI18n'
import { useRemoteRecentFiles } from './useRemoteRecentFiles'
import { buildRemoteEditorPath, isRemoteEditorPath, parseRemoteEditorPath } from '../utils/remoteEditorPath'
import { PROJECT_FILE_CHANGED } from './useWebSocket'
import { OPS_FILES_EXTERNAL_CHANGE } from '../utils/opsEvents'
import type { PaletteCommand, PaletteRemoteFile } from '../components/search/CommandPalette.vue'
import {
  FolderOutline,
  GitBranchOutline,
  TerminalOutline,
  CloudDownloadOutline,
  DownloadOutline,
  ArrowDownCircleOutline,
  CloudUploadOutline,
  SettingsOutline,
  SearchOutline,
  ColorPaletteOutline,
  PulseOutline,
  MedkitOutline,
  ServerOutline,
  StatsChartOutline,
  GitNetworkOutline,
  ShareSocialOutline,
  AddOutline,
  GlobeOutline,
  HelpCircleOutline,
  RocketOutline,
  ChatbubblesOutline,
  GitCompareOutline,
  FlashOutline,
  LockClosedOutline,
  ArrowUndoOutline,
  ArrowBackOutline,
  ArrowForwardOutline,
  NotificationsOutline,
  CodeSlashOutline,
  QrCodeOutline,
  DocumentTextOutline,
  ResizeOutline,
  SwapVerticalOutline,
  SpeedometerOutline,
  TvOutline,
  LinkOutline,
  EaselOutline,
  SaveOutline,
  TimeOutline,
  BookmarkOutline,
  ListOutline,
  LocateOutline,
  ClipboardOutline,
  ContractOutline,
  ExpandOutline,
  Contract,
} from '@vicons/ionicons5'
import {
  SETTINGS_TAB_KEYS, SETTINGS_TAB_LABEL_KEYS, SETTINGS_TAB_ICONS,
  settingsKeywordKey,
} from '../utils/settingsSearch'
import { PROJECT_RULE_FILES } from '../utils/projectRuleTemplates'
import { useEditorNavHistory } from './useEditorNavHistory'
import { useAgentTaskTemplates } from './useAgentTaskTemplates'
import { templatePromptKeywords } from '../utils/agentTaskTemplate'
import { useLayoutLockStore } from '../stores/layoutLock'
import { usePanelLayout } from './usePanelLayout'

/** 快速导航的打开集只读视图条目（useLayoutShell 传 allOpenFiles）：远程层从
 *  已开远程签派生（P-20261004-137）；「分享当前文件」命令还借
 *  content/originalContent 判未保存态（P-20261020-8；缺省空集=单测裸实例化
 *  时不注册该命令）。 */
interface PaletteOpenFile {
  path: string
  name: string
  /** 以下三字段仅「分享当前文件」条件注册消费（shell 传的是完整 OpenFile）；
   *  单测最小条目可缺省——缺省按已保存处理 */
  content?: string
  originalContent?: string
  loading?: boolean
}

/** 快速导航——命令面板、快速打开、项目搜索——从 Layout.vue 提取 */
export function useQuickNav(openFiles?: MaybeRefOrGetter<readonly PaletteOpenFile[]>) {
  const projectStore = useProjectStore()
  // 布局锁定（P-20261003-180）：防误拖 toggle 的命令面板入口读此态出标题
  const layoutLockStore = useLayoutLockStore()
  const remoteHostStore = useRemoteHostStore()
  const branchStore = useBranchStore()
  const instanceStore = useInstanceStore()
  const { t } = useI18n()
  // 活动编辑器文件信标（模块级共享 ref，P-20261002-16）：「定位当前文件到树」
  // 命令按其有无条件注册（无打开文件不显示，VS Code 同款语义）
  const { activeFilePath } = useEditorNavHistory()
  // 「分享当前文件」（P-20261020-8）：注册条件 = 项目内、已保存（非脏缓冲/
  // 非加载中）、非远程伪路径的活跃文件——远程分享是独立数据面，未保存内容
  // 与磁盘版本可能不一致（服务端分享取磁盘）。activeFilePath 已由
  // useEditorNavHistory 过滤 diff 伪键与未命名草稿，这里只需再滤远程态
  const activeOpenFile = computed(() => {
    const path = activeFilePath.value
    if (!path || !openFiles) return null
    return toValue(openFiles).find(f => f.path === path) ?? null
  })
  const canShareActiveFile = computed(() => {
    const f = activeOpenFile.value
    if (!f || !projectStore.currentProjectId) return false
    if (f.loading || isRemoteEditorPath(f.path)) return false
    return f.content === f.originalContent
  })
  // 任务模板清单（模块级单例，P-20261002-16）：「按模板新建会话」动态命令组
  // （P-20261005-10）的注册源，打开面板时刷新（openCommandPalette 内）
  const taskTemplates = useAgentTaskTemplates()

  const showCommandPalette = ref(false)
  const showQuickOpen = ref(false)
  // 面板初始模式：'commands' 时打开即预置 '>' 进入命令模式（Ctrl+Shift+P 直达）
  const paletteInitialMode = ref<'files' | 'commands'>('files')
  const showProjectSearch = ref(false)
  const showOutline = ref(false)
  const showTaskRunner = ref(false)
  // 书签列表弹层（P-20261002-131，命令面板「书签列表」入口）
  const showBookmarkList = ref(false)
  // 跨项目命令历史检索浮层（P-20261004-2，命令面板「搜索命令历史」入口）
  const showTerminalHistorySearch = ref(false)
  // 跨会话终端输出检索浮层（P-20261003-290，命令面板「搜索终端输出」入口）
  const showTerminalOutputSearch = ref(false)
  // 端口占用一览浮层（P-20261003-293，命令面板「端口占用一览」入口）
  const showTerminalPorts = ref(false)
  // 本机环境体检浮层（P-20261003-317，命令面板「环境体检」入口）
  const showSelfCheck = ref(false)

  // 命令面板：文件列表
  const paletteFiles = ref<PaletteFileItem[]>([])
  const paletteFilesLoading = ref(false)
  const paletteFilesCacheKey = ref('')
  // 源列表是否触达索引上限（截断）——面板尾部据此显示弱提示行
  const paletteFilesTruncated = ref(false)

  // 远程文件层（P-20261004-137）：候选 = 已开远程签（当前现场）+ 最近远程
  // （localStorage 环形 ≤8，关签后仍可直达）。**独立于 paletteFiles 的派生
  // computed**——这是修正注记①的换新点：SWR 后台重拉会整体替换 paletteFiles，
  // 若把远程条目 merge 进该 ref，换新一次远程分组即消失；派生层只依赖
  // openFiles 与最近远程单例，项目清单换新/清空（首页）都动不到它。
  // 主机别名同源 remoteHostStore（openQuickOpen/openCommandPalette 打开时点
  // 幂等刷新），未命中回落裸 hostId（展示层降级不影响寻址）。
  const { remoteRecentFiles } = useRemoteRecentFiles()
  const paletteRemoteFiles = computed<PaletteRemoteFile[]>(() => {
    const out: PaletteRemoteFile[] = []
    const seen = new Set<string>()
    const push = (hostId: string, rpath: string, name?: string) => {
      const key = `${hostId}:${rpath}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({
        path: buildRemoteEditorPath(hostId, rpath),
        name: name || rpath.split('/').pop() || rpath,
        hostId,
        rpath,
        hostName: remoteHostStore.hosts.find(h => h.id === hostId)?.name || hostId,
      })
    }
    // 已开签优先（打开中的是当前工作现场），最近远程补足已关闭的
    for (const f of openFiles ? toValue(openFiles) : []) {
      const parsed = parseRemoteEditorPath(f.path)
      if (parsed) push(parsed.hostId, parsed.rpath, f.name || parsed.name)
    }
    for (const e of remoteRecentFiles.value) push(e.hostId, e.rpath, e.name)
    return out
  })
  // SWR 新鲜度戳（P-20261003-299）：上次成功拉取时刻，0 = 未拉取/已失效
  let paletteFilesFetchedAt = 0
  // 失效代次：事件失效命中时递增——拉取期间发生的失效使在途响应过期，
  // 换新前比对代次防止「拉取开始于文件变更前」的旧数据被当成新数据换入
  let paletteCacheEpoch = 0

  function openCommandPalette(mode: 'files' | 'commands' = 'files') {
    paletteInitialMode.value = mode
    showCommandPalette.value = true
    loadPaletteFiles()
    // 远程主机命令需要最新主机列表（fetch 幂等，列表接口轻量）
    void remoteHostStore.fetch().catch(() => {})
    // 分支命令组同理需要最新分支清单（WS branch.changed 之外的打开时点兜底，
    // fetch 幂等轻量）；无当前项目（首页）跳过
    const pid = projectStore.currentProjectId
    if (pid) void branchStore.fetchBranches(pid).catch(() => {})
    // 实例命令组同理需要最新实例清单（P-20261002-111）：ensureInstancesFresh
    // 空列表全量拉取、非空按 TTL 探测，与实例菜单打开同一取数策略（内部自吞错）
    void instanceStore.ensureInstancesFresh()
    // 模板命令组同理需要最新模板清单（P-20261005-10）：uiState 单键读取幂等
    // 轻量（内部自吞错），与分支/实例刷新同款「打开时点兜底」策略
    void taskTemplates.load()
  }

  function openQuickOpen() {
    paletteInitialMode.value = 'files'
    showQuickOpen.value = true
    loadPaletteFiles()
    // 远程层主机别名需要最新主机列表（P-20261004-137，命令面板同款打开时点
    // 兜底刷新：fetch 幂等、列表接口轻量，失败静默回落裸 hostId）
    void remoteHostStore.fetch().catch(() => {})
  }

  // 项目搜索种子查询词（P-20261002-86）：Quick Open 空结果降级跳转时携带，
  // 搜索面板打开时填入并自动搜索。所有入口统一经 openProjectSearch 打开——
  // 普通入口无参调用即重置种子，保证它只影响紧随其后的一次打开
  const projectSearchSeed = ref('')
  // 目录搜索 glob 种子（P-20261003-118）：文件树目录右键「在此目录搜索」携带，
  // 与查询词种子同款一次性语义（普通入口无参调用即重置）；空串 = 本次打开无
  // glob 种子，面板不动 glob 输入的既有粘滞（用户手输的过滤跨打开保留）
  const projectSearchGlobSeed = ref('')
  function openProjectSearch(seedQuery = '', seedGlob = '') {
    projectSearchSeed.value = seedQuery
    projectSearchGlobSeed.value = seedGlob
    showProjectSearch.value = true
  }

  // 文件清单取数原语 collectProjectFileList 在 ./projectFileList（P-20261003-107
  // 提取共享：与编辑器字符串内路径补全同源同口径），本处只承担面板侧缓存读写

  /** 统一换新出口（P-20261003-299）：响应回来时项目已切换（cacheKey 不再匹配
   *  当前项目）或拉取期间发生过失效（代次推进，在途响应已过期）则丢弃——
   *  陈旧数据绝不冒充新鲜数据换入；命中才落状态并记 fetchedAt */
  function applyPaletteFiles(cacheKey: string, epoch: number, files: PaletteFileItem[], truncated: boolean) {
    if (`${projectStore.currentProjectId}` !== cacheKey) return
    if (epoch !== paletteCacheEpoch) return
    paletteFiles.value = files
    paletteFilesTruncated.value = truncated
    paletteFilesCacheKey.value = cacheKey
    paletteFilesFetchedAt = Date.now()
  }

  /** 拉取 Quick Open 文件清单（SWR 缓存读侧，P-20261003-299）：新鲜命中直接
   *  返回；陈旧（超过 TTL）先渲染旧清单立即可搜、后台静默重拉换新（不清空
   *  现列表、无 loading 遮罩）；键不匹配（首次/切项目/事件失效后）走既有
   *  全量加载（loading 态）。 */
  async function loadPaletteFiles() {
    if (!projectStore.currentProjectId) {
      paletteFiles.value = []
      paletteFilesTruncated.value = false
      return
    }
    const cacheKey = `${projectStore.currentProjectId}`
    if (cacheKey === paletteFilesCacheKey.value && paletteFiles.value.length > 0) {
      if (Date.now() - paletteFilesFetchedAt < swrTtlMs()) return
      void revalidatePaletteFiles(cacheKey)
      return
    }
    paletteFilesLoading.value = true
    const epoch = paletteCacheEpoch
    try {
      const { files, truncated } = await collectProjectFileList(projectStore.currentProjectId)
      applyPaletteFiles(cacheKey, epoch, files, truncated)
    } catch {
      // 失败清空仅限项目未切走时（竞态下不误伤新项目的列表）
      if (`${projectStore.currentProjectId}` === cacheKey) {
        paletteFiles.value = []
        paletteFilesTruncated.value = false
      }
    } finally {
      paletteFilesLoading.value = false
    }
  }

  /** SWR 后台重拉（P-20261003-299）：不动现列表、不置 loading（旧清单面板
   *  立即可搜，响应回来静默换新）；失败静默保留旧表（陈旧好过空白），下次
   *  打开再试；同键在途去重防连环打开叠发请求。 */
  let paletteRevalidating = false
  async function revalidatePaletteFiles(cacheKey: string) {
    if (paletteRevalidating) return
    paletteRevalidating = true
    const epoch = paletteCacheEpoch
    try {
      const { files, truncated } = await collectProjectFileList(cacheKey)
      applyPaletteFiles(cacheKey, epoch, files, truncated)
    } catch {
      // 旧表兜底：重拉失败保持现状，下次打开再试
    } finally {
      paletteRevalidating = false
    }
  }

  /** Quick Open 文件清单的事件失效链（P-20261003-73）：清单此前仅按项目缓存、
   *  会话内零失效——agent 新建的文件要等切项目才能被搜到。两路失效源：
   *  - PROJECT_FILE_CHANGED：项目 WS file.changed 的窗口广播（服务端 fs 监听，
   *    新建/删除/重命名都会发；useWebSocket 已做 300ms 合并）
   *  - OPS_FILES_EXTERNAL_CHANGE：页面内批量写盘动作（全工程替换/冲突落盘/
   *    cherry-pick 等）的既有广播
   *  失效动作=只清 cacheKey，惰性重拉：下次打开面板 loadPaletteFiles 走既有
   *  loading 态重新取数，事件当下不预取（面板未开时零网络开销）；1s 尾沿去抖
   *  合并 agent 批量产文件的连环事件。WS 按当前项目连接、OPS 广播均发生在
   *  当前项目上下文，而缓存键就是当前项目 id，故无需路径级比对
   *  协同（P-20261003-299）：失效同时重置 fetchedAt 并推进失效代次——重置让
   *  「键匹配⟹fetchedAt 有效」不变式成立，代次使在途重拉的响应过期作废 */
  let paletteInvalidateTimer: ReturnType<typeof setTimeout> | null = null
  function invalidatePaletteFilesCache() {
    if (paletteInvalidateTimer) clearTimeout(paletteInvalidateTimer)
    paletteInvalidateTimer = setTimeout(() => {
      paletteInvalidateTimer = null
      paletteFilesCacheKey.value = ''
      paletteFilesFetchedAt = 0
      paletteCacheEpoch++
    }, 1000)
  }
  window.addEventListener(PROJECT_FILE_CHANGED, invalidatePaletteFilesCache)
  window.addEventListener(OPS_FILES_EXTERNAL_CHANGE, invalidatePaletteFilesCache)
  // failSilently：生产始终在组件 setup 作用域内随卸载注销；单测裸实例化无
  // effect scope，缺省会逐次告警，故静默跳过注销登记
  onScopeDispose(() => {
    window.removeEventListener(PROJECT_FILE_CHANGED, invalidatePaletteFilesCache)
    window.removeEventListener(OPS_FILES_EXTERNAL_CHANGE, invalidatePaletteFilesCache)
    if (paletteInvalidateTimer) clearTimeout(paletteInvalidateTimer)
  }, true)

  /** 命令面板：命令列表（基础命令 + 按已配置主机动态生成的远程运维命令） */
  const paletteCommands = computed<PaletteCommand[]>(() => [
    { id: 'toggle-files', title: t('layout.files'), category: t('layout.view'), icon: FolderOutline, keywords: 'files tree sidebar', shortcut: ['Ctrl', '1'] },
    { id: 'toggle-git', title: t('layout.git'), category: t('layout.view'), icon: GitBranchOutline, keywords: 'git panel changes', shortcut: ['Ctrl', '3'] },
    { id: 'toggle-terminal', title: t('layout.terminal'), category: t('layout.view'), icon: TerminalOutline, keywords: 'terminal console shell', shortcut: ['Ctrl', '`'] },
    { id: 'new-terminal', title: t('terminal.newTerminal'), category: t('layout.view'), icon: AddOutline, keywords: 'new terminal create shell 新建 终端' },
    // 编辑器组临时最大化（P-20261004-64）：双组对照工作流临时全宽看一侧
    // （tab 条双击同款动作的键盘/扫读可达入口）；标题随态切换（toggle-layout-lock
    // 先例），未分屏时执行为 no-op；宿主分发见 useLayoutViews.handlePaletteCommand
    {
      id: 'toggle-group-maximize',
      title: t(usePanelLayout().editorGroupMaximized.value === null ? 'layout.maximizeGroup' : 'layout.restoreGroup'),
      category: t('layout.view'),
      icon: ResizeOutline,
      keywords: 'maximize editor group focus split compare 全宽 最大化 组 编辑器 分屏 对照',
    },
    // 分屏方向切换（P-20261005-230 正交拆分）：左右/上下翻转（splitDown 键位
    // 同族动作）；未分屏 no-op（守卫在 shell 闭包），分发见 useLayoutViews
    {
      id: 'toggle-split-direction',
      title: t('layout.splitDirectionToggle'),
      category: t('layout.view'),
      icon: SwapVerticalOutline,
      keywords: 'split direction vertical horizontal orthogonal 上下 左右 分屏 方向 纵向 横向 对照',
    },
    { id: 'toggle-dsh', title: t('dshConsole.title'), category: t('layout.view'), icon: GlobeOutline, keywords: 'dsh deepseek harness console 控制台' },
    { id: 'instance-sessions', title: t('instanceSessions.title'), category: t('layout.view'), icon: ServerOutline, keywords: 'instance sessions overview 多实例 会话 总览' },
    // 实例族总览（P-20261003-56）：同机多实例 fleet 一览（claim 聚合 + 探活）
    { id: 'instance-fleet', title: t('fleet.title'), category: t('layout.view'), icon: GitNetworkOutline, keywords: 'instance fleet overview 实例 族 多实例 存活 端口' },
    // 跨实例通知聚合（P-20261003-125）：fleet 值守面——所有实例的异常一屏速览
    { id: 'fleet-notify', title: t('fleetNotify.title'), category: t('layout.view'), icon: NotificationsOutline, keywords: 'fleet notify aggregate 跨实例 通知 聚合 值班 异常' },
    // 值班大屏（P-20261002-80）：/monitor 是面板之外的独立路由，此处为统一键盘入口
    // （首页入口按钮的等价物）；宿主分发见 useLayoutViews.handlePaletteCommand。
    // 图标随目的地 nav 注册表（P-20261022-2）：monitor=TvOutline，Speedometer 归还仪表盘
    { id: 'monitor', title: t('commandPalette.cmdOpenMonitor'), category: t('layout.view'), icon: TvOutline, keywords: '值班 大屏 monitor dashboard 监控' },
    // 项目仪表盘（P-20261005-224）：当前项目 git/会话/问题/近期活动四卡一屏，
    // 主区视图直达（活动栏按钮同链）；分发见 useLayoutViews.handlePaletteCommand
    { id: 'dashboard', title: t('dashboard.title'), category: t('layout.view'), icon: SpeedometerOutline, keywords: 'dashboard status overview project 仪表盘 状态 总览 项目 巡检' },
    // 跨项目实时变更流（P-20261003-232）：file.changed 跨项目聚合时间线，
    // 打开活动栏独立面板；分发见 useLayoutViews.handlePaletteCommand
    { id: 'change-stream', title: t('changeStream.panelTitle'), category: t('layout.view'), icon: PulseOutline, keywords: 'change stream file changed 变更 流 跨项目 实时 刚刚 发生了什么 值班' },
    // 项目环境画像（P-20261007-14）：dev 端口观测 × 哨兵 × 部署目标一页简历，
    // 打开活动栏独立面板；分发见 useLayoutViews.handlePaletteCommand
    { id: 'env-profile', title: t('envProfile.title'), category: t('layout.view'), icon: ServerOutline, keywords: 'env profile environment port dev server sentinel deploy 环境 画像 端口 服务 部署 哨兵 简历 需要 什么' },
    // 多实例同步中心（P-20261023-1）：项目+上下文跨实例拉取/推送，打开活动栏
    // 独立面板；分发见 useLayoutViews.handlePaletteCommand
    { id: 'sync-center', title: t('sync.title'), category: t('layout.view'), icon: CloudUploadOutline, keywords: 'sync instance project context push pull fleet 同步 实例 项目 拉取 推送 迁移 上下文 多机' },
    // 「Fetch 全部项目」= 批量链路 POST /fetch-all（P-20261003-309 修正标签/行为
    // 错位：此前标题承诺全量、实际接线单仓 fetch；实现与首页工具栏同源
    // useFetchAll），分发见 useLayoutViews.handlePaletteCommand
    { id: 'fetch', title: t('commandPalette.cmdFetchAll'), category: t('layout.git'), icon: CloudDownloadOutline, keywords: 'fetch all projects 全部 拉取 远程 remote morning' },
    // 单仓 fetch（P-20261003-309 另立入口）：与 pull/push 当前分支同族，只拉
    // 当前项目；分发见 useLayoutViews.handlePaletteCommand（走既有 handleFetch）
    { id: 'fetch-current', title: t('commandPalette.cmdFetchCurrent'), category: t('layout.git'), icon: CloudDownloadOutline, keywords: 'fetch current 当前 拉取 单仓 remote' },
    { id: 'pull', title: t('commandPalette.cmdPullCurrent'), category: t('layout.git'), icon: ArrowDownCircleOutline },
    { id: 'push', title: t('commandPalette.cmdPushCurrent'), category: t('layout.git'), icon: CloudUploadOutline },
    { id: 'settings', title: t('commandPalette.cmdOpenSettings'), category: t('layout.settings'), icon: SettingsOutline, shortcut: ['Ctrl', ','] },
    // 设置分区直达（P-20261001-9，settings:<key> 锚点）：关键词表与 SettingsModal
    // 左栏搜索共用同一份（settingsSearch.keywords），面板输「scrollback」等核心词即可直达对应分区
    ...SETTINGS_TAB_KEYS.map(key => ({
      id: `settings:${key}`,
      title: t('commandPalette.cmdOpenSettingsTab', { tab: t(SETTINGS_TAB_LABEL_KEYS[key]) }),
      category: t('layout.settings'),
      icon: SETTINGS_TAB_ICONS[key],
      keywords: `settings 打开设置 ${t(SETTINGS_TAB_LABEL_KEYS[key])} ${t(settingsKeywordKey(key))}`,
    })),
    // 项目规则管理（P-20261006-43）：设置·通用·智能体分区 ProjectRulesManager 区块
    // 一击直达——openSettingsTab 携区块锚点（detail {tab, anchor}），弹窗切通用分区
    // 后滚动定位 + 闪烁（useSettingsSearch.revealAnchor）；分发见
    // useLayoutViews.handlePaletteCommand
    {
      id: 'project-rules',
      title: t('commandPalette.cmdOpenProjectRules'),
      category: t('layout.settings'),
      icon: SettingsOutline,
      keywords: `project rules ${PROJECT_RULE_FILES.join(' ')} 项目 规则 管理 模板 智能体 行为 创建 编辑 ${t('settings.projectRules.title')}`,
    },
    // 编辑规则文件（P-20261006-43）：CLAUDE.md/AGENTS.md/.cursorrules 文件级命令
    // 按清单展开（projectRuleTemplates 单一事实源，新规则格式加一行全链生效）；
    // 存在即深链进编辑器、缺失确认后模板创建（useRuleFileLaunch）。无当前项目
    // 不注册（路径相对项目根，深链无处落）——locate-in-tree 条件注册同款
    ...(projectStore.currentProjectId
      ? PROJECT_RULE_FILES.map(f => ({
          id: `edit-rule:${f}`,
          title: t('commandPalette.cmdEditRuleFile', { name: f }),
          category: t('commandPalette.categoryProject'),
          icon: DocumentTextOutline,
          keywords: `rule edit ${f} 编辑 规则 文件 智能体 claude agents cursor`,
        }))
      : []),
    // 快捷键帮助图标随目的地 nav 注册表（P-20261022-2）：shortcuts=FlashOutline
    // （原 KeyOutline 是 docs §3.6 的「已知例外」，目的地注册后多入口同图消解该例外）
    { id: 'shortcuts-help', title: t('commandPalette.cmdShortcutsHelp'), category: t('layout.settings'), icon: FlashOutline, keywords: 'shortcuts keys keyboard 快捷键 键位 帮助', shortcut: ['?'] },
    { id: 'help-center', title: t('help.title'), category: t('layout.settings'), icon: HelpCircleOutline, keywords: 'help faq 帮助 常见问题 使用 排障 mouse scroll 鼠标 上翻' },
    // 远程控制台图标随目的地 nav 注册表（P-20261022-2）：remote-console=GlobeOutline（与 rail/首页同图；原 Server 与环境画像面板撞语义）
    { id: 'remote-console', title: t('commandPalette.cmdRemoteConsole'), category: t('commandPalette.categoryRemoteOps'), icon: GlobeOutline, keywords: 'remote console ssh terminal 远程 控制台' },
    // 图标随目的地 nav 注册表（P-20261022-2）：share-manager=LinkOutline（与活动栏 rail 同图）
    { id: 'share-manager', title: t('commandPalette.cmdShareManager'), category: t('layout.view'), icon: LinkOutline, keywords: 'share link file 分享 短链 文件' },
    // 分享当前文件（P-20261020-8）：把分享从「去树里找文件再右键」降到当前
    // 编辑器上下文一步；按活动文件信标条件注册（同 locate-in-tree 族），
    // 仅项目内已保存文件——远程/未保存/非项目形态不注册。分发见
    // useLayoutViews.handlePaletteCommand（复用 useShareDialog.createShare）
    ...(canShareActiveFile.value
      ? [{
          id: 'share-current-file',
          title: t('commandPalette.cmdShareCurrentFile'),
          category: t('layout.view'),
          icon: ShareSocialOutline,
          keywords: 'share link current file editor 分享 短链 当前 文件 编辑器 链接',
        }]
      : []),
    // 文本片段分享（P-20261002-71）：排障贴短链，预填活跃编辑器选区
    { id: 'share-snippet', title: t('share.snippet.paletteCmd'), category: t('layout.view'), icon: DocumentTextOutline, keywords: 'share snippet paste text 分享 片段 文本 排障 粘贴' },
    // 导出中心（P-20261003-266）：各域导出入口聚合（会话/部署/审计/变更/分享归档）
    // + 最近导出记录；分发见 useLayoutViews.handlePaletteCommand（弹层宿主在 Layout）
    { id: 'export-center', title: t('exportCenter.title'), category: t('layout.view'), icon: DownloadOutline, keywords: 'export center 导出 中心 下载 归档 备份 patch 补丁 csv zip md jsonl 会话 部署 审计 知识 出域' },
    // 二维码接力（P-20261002-59）：手机扫码打开当前页，与顶栏按钮双入口
    { id: 'qr-relay', title: t('qr.relay.title'), category: t('layout.view'), icon: QrCodeOutline, keywords: 'qr code phone mobile scan 手机 二维码 扫码 接力' },
    // 跨设备剪贴板中继（P-20261002-32）：本机剪贴板一键发给同服务其他已解锁
    // 设备（对端 toast 点击即取走）；分发见 useLayoutViews.handlePaletteCommand。
    // 终端右键入口缩范围未做（一派曾致终端域 e2e 回归，留后续独立提案）
    { id: 'clip-send', title: t('clip.sendCmd'), category: t('layout.view'), icon: ClipboardOutline, keywords: 'clipboard send device cross relay 剪贴板 发送 其他设备 跨设备 中继 平板 手机 复制' },
    { id: 'search-project', title: t('commandPalette.cmdSearchInProject'), category: t('layout.view'), icon: SearchOutline, shortcut: ['Ctrl', 'Shift', 'F'] },
    // 跨项目命令历史检索（P-20261004-2）：「那条命令上次在哪个项目跑的」全局面；
    // 分发见 useLayoutViews.handlePaletteCommand（浮层宿主在 GlobalOverlays）
    { id: 'search-terminal-history', title: t('terminal.history.globalCmd'), category: t('layout.view'), icon: TerminalOutline, keywords: 'terminal history command search 命令 历史 检索 全项目 docker 排障' },
    // 跨会话输出检索（P-20261003-290）：「那个报错/端口号是哪个终端打的」；
    // 分发见 useLayoutViews.handlePaletteCommand（浮层宿主在 GlobalOverlays）
    { id: 'search-terminal-output', title: t('terminal.history.outputCmd'), category: t('layout.view'), icon: SearchOutline, keywords: 'terminal output search session scrollback 终端 输出 搜索 会话 报错 端口 排障' },
    // 端口占用一览（P-20261003-293）：「谁在用哪个端口」登记面只读浮层 +
    // agent 选自由端口原语；分发见 useLayoutViews.handlePaletteCommand
    { id: 'terminal-ports', title: t('terminal.portRegistry.listCmd'), category: t('layout.view'), icon: PulseOutline, keywords: 'port occupied conflict eaddrinuse free dev server 端口 占用 冲突 被占 自由 空闲 服务' },
    // 本机环境体检（P-20261003-317）：新人配置检查/issue 附环境一键化；
    // 分发见 useLayoutViews.handlePaletteCommand（浮层宿主在 GlobalOverlays）
    { id: 'self-check', title: t('selfcheck.cmdTitle'), category: t('layout.view'), icon: MedkitOutline, keywords: 'selfcheck environment doctor diagnose git lfs tmux runtime disk 体检 环境 自检 配置检查 排障 issue 报告' },
    // 编辑器「插入片段」（P-20261002-44）：列表选择后在当前文件光标处插入，
    // 宿主处理见 useLayoutViews.handlePaletteCommand（走活跃编辑器暴露的方法）
    { id: 'insert-snippet', title: t('snippet.code.insert'), category: t('layout.view'), icon: CodeSlashOutline, keywords: 'snippet insert code editor 片段 插入 代码 编辑器' },
    // 全部保存（P-20261002-101）：提交/切分支前的批量收尾一键化（多 tab/分屏双组），
    // 分发见 useLayoutViews.handlePaletteCommand；Ctrl+Alt+S 实际经 keymap 派发可改绑
    { id: 'save-all', title: t('layout.saveAll.command'), category: t('layout.view'), icon: SaveOutline, keywords: 'save all 保存 全部 落盘 批量 dirty 脏', shortcut: ['Ctrl', 'Alt', 'S'] },
    // 编辑器书签列表（P-20261002-131）：长文件/评审场景的跳级锚点，跨文件往返
    // 一键跳回；分发见 useLayoutViews.handlePaletteCommand（弹层宿主在 GlobalOverlays）
    { id: 'bookmark-list', title: t('editor.bookmark.listCmd'), category: t('layout.view'), icon: BookmarkOutline, keywords: 'bookmark list anchor jump 书签 列表 锚点 跳转 标记' },
    // 运行书（P-20261003-24）：多步运维序列逐步发送；分发见
    // useLayoutViews.handlePaletteCommand（确保终端分区可见后打开面板）
    { id: 'runbook', title: t('runbook.title'), category: t('layout.view'), icon: ListOutline, keywords: 'runbook steps sequence deploy checklist 运行 书 步骤 部署 清单 巡检 发版 逐步' },
    { id: 'toggle-theme', title: t('commandPalette.cmdToggleTheme'), category: t('layout.settings'), icon: ColorPaletteOutline },
    { id: 'task-runner', title: t('commandPalette.cmdTaskRunner'), category: t('layout.view'), icon: RocketOutline, keywords: 'task runner npm go script 任务 运行器 脚本' },
    { id: 'agent-terminal', title: t('agentTerminal.title'), category: t('layout.view'), icon: ChatbubblesOutline, keywords: 'claude codex agent terminal sessions 会话 终端 管理' },
    // 舰队批量发起（P-20261003-291）：多项目一次发起 agent 会话编队；分发见
    // useLayoutViews.handlePaletteCommand（弹层宿主在 Layout，与会话总览同族）
    { id: 'fleet-bulk-agent', title: t('agentTerminal.fleet.paletteCmd'), category: t('layout.view'), icon: FlashOutline, keywords: 'fleet bulk agent batch 批量 舰队 编队 多项目 依赖审计 lint 全部项目' },
    // 对比实验（P-20261003-46）：双 agent 同题竞写与逐文件对比；分发见
    // useLayoutViews.handlePaletteCommand（面板为全局单例，双入口直开）
    { id: 'compare-experiment', title: t('experiment.title'), category: t('layout.view'), icon: GitCompareOutline, keywords: 'compare experiment a/b 对比 实验 竞写 双开 两个 agent' },
    // 会话接续链（P-20261004-38）：事件触发的 agent 串行接力；分发见
    // useLayoutViews.handlePaletteCommand（面板为全局单例，双入口直开）
    { id: 'agent-chains', title: t('agentchain.panelTitle'), category: t('layout.view'), icon: GitNetworkOutline, keywords: 'agent chain relay 接续 链 接力 串行 自动化 完成后 触发 session chain' },
    // 通知中心（顶栏铃铛的键盘等价入口）
    { id: 'notifications', title: t('notification.title'), category: t('layout.view'), icon: NotificationsOutline, keywords: '通知 notifications 消息 中心 铃铛 bell' },
    { id: 'lock-system', title: t('commandPalette.cmdLockSystem'), category: t('layout.settings'), icon: LockClosedOutline, keywords: 'lock system 锁定 安全 password' },
    // 布局锁定（P-20261003-180）：防误拖 toggle（顶栏小锁同源双入口）；分发见
    // useLayoutViews.handlePaletteCommand。标题随状态翻转（锁定中显「解锁布局」）
    { id: 'toggle-layout-lock', title: t(layoutLockStore.locked ? 'layout.layoutLockOff' : 'layout.layoutLockOn'), category: t('layout.view'), icon: LockClosedOutline, keywords: 'lock layout drag resize 防误拖 锁定 布局 分隔条 拖拽 触屏 演示' },
    // 重新打开已关闭标签（Ctrl+Shift+T 被 Chrome 保留为重开浏览器标签页无法拦截，退避 Alt+Shift+T）
    { id: 'reopen-closed-tab', title: t('commandPalette.cmdReopenClosedTab'), category: t('layout.view'), icon: ArrowUndoOutline, keywords: 'reopen closed tab undo 重新 打开 关闭 标签 撤销 误关 找回', shortcut: ['Alt', 'Shift', 'T'] },
    // 编辑器导航后退/前进（P-20261002-51）：跳转链（Quick Open/搜索跳转/深链）回溯，快捷键 Ctrl+Alt+←/→
    { id: 'navigate-back', title: t('editor.nav.back'), category: t('layout.view'), icon: ArrowBackOutline, keywords: 'navigate back editor history 后退 导航 上一个 位置 光标 历史 返回', shortcut: ['Ctrl', 'Alt', '←'] },
    { id: 'navigate-forward', title: t('editor.nav.forward'), category: t('layout.view'), icon: ArrowForwardOutline, keywords: 'navigate forward editor history 前进 导航 下一个 位置 光标 历史', shortcut: ['Ctrl', 'Alt', '→'] },
    // 定位当前文件到树（P-20261003-294）：活动 tab 在文件树中逐层展开定位（深路径
    // 「我在哪」一键化）；活动文件信标为空（无打开文件）不注册（分支组同款条件
    // 注册），分发见 useLayoutViews.handlePaletteCommand（OPS_LOCATE_IN_TREE 事件）
    ...(activeFilePath.value
      ? [{
          id: 'locate-in-tree',
          title: t('commandPalette.cmdLocateInTree'),
          category: t('layout.view'),
          icon: LocateOutline,
          keywords: 'reveal locate file tree sidebar position 定位 文件树 侧栏 位置 展开 显示 哪里',
        }]
      : []),
    // 折叠控制（P-20261006-20）：Monaco 内建折叠 action（editor.foldAll/unfoldAll/
    // foldLevel1）的命令面板暴露——零新折叠逻辑，长文件「只看结构」从折叠箭头
    // 逐块点变一键。作用域=编辑器激活态：活动文件信标为空（无打开文件）不注册
    // （locate-in-tree 同款条件注册）；diff 标签/元信息卡下活跃组无 Monaco 实例，
    // 执行链就地提示（useLayoutViews 折叠 case）。chord 键位（Ctrl+K 0/J）为二期
    ...(activeFilePath.value
      ? [
          {
            id: 'fold-all',
            title: t('commandPalette.cmdFoldAll'),
            category: t('layout.view'),
            icon: ContractOutline,
            keywords: 'fold all collapse structure outline 折叠 全部 收起 结构 速览 提纲',
          },
          {
            id: 'unfold-all',
            title: t('commandPalette.cmdUnfoldAll'),
            category: t('layout.view'),
            icon: ExpandOutline,
            keywords: 'unfold all expand restore 展开 全部 还原 展平',
          },
          {
            id: 'fold-level-1',
            title: t('commandPalette.cmdFoldLevel1'),
            category: t('layout.view'),
            icon: Contract,
            keywords: 'fold level 1 outline 折叠 一级 层级 大纲 结构',
          },
        ]
      : []),
    // 一键重置当前项目布局（P-20261002-74）：面板/宽度/树展开调乱后的自救出口
    { id: 'reset-layout', title: t('layout.reset.command'), category: t('layout.view'), icon: ResizeOutline, keywords: 'reset layout view locations 重置 布局 复位 还原 面板 宽度' },
    // 投屏演示模式（P-20261002-45）：大字 + 收起面板，快进快出；toggle 语义——
    // 再次执行退出（Esc 同效），分发见 useLayoutViews.handlePaletteCommand
    { id: 'present-mode', title: t('present.mode.command'), category: t('layout.view'), icon: EaselOutline, keywords: 'present presentation demo screen share 投屏 演示 演示模式 屏幕共享 大字 讲解 结对' },
    // 工作现场存档点（P-20261002-84）：大改前存个档，改坏或切走后一键回
    { id: 'snapshot-save', title: t('snapshot.cmdSave'), category: t('layout.view'), icon: SaveOutline, keywords: 'snapshot save workspace 存档 现场 保存 快照 备份 档' },
    { id: 'snapshot-restore', title: t('snapshot.cmdRestore'), category: t('layout.view'), icon: TimeOutline, keywords: 'snapshot restore workspace 恢复 现场 回档 快照 存档' },
    // 项目快速切换：列出除当前项目外的全部项目（Ctrl+K 直达，免回顶栏下拉）
    ...projectStore.projects
      .filter(p => p.id !== projectStore.currentProjectId)
      .map(p => ({
        id: `switch-project:${p.id}`,
        title: t('commandPalette.cmdSwitchProject', { name: p.name }),
        category: t('commandPalette.categoryProject'),
        icon: FolderOutline,
        keywords: `project switch 切换 项目 ${p.name}`,
      })),
    // 分支快速切换（P-20261002-102）：与项目快速切换对称。清单来自 branch store
    // 的本地分支（打开面板时刷新 + WS branch.changed 增量），当前分支置顶标注、
    // 其余按名升序；清单为空或加载中不显示该组。分发在
    // useLayoutViews.handlePaletteCommand——走 GitBranchesSection 同款脏区预警链路
    ...(branchStore.loading || branchStore.localBranches.length === 0
      ? []
      : branchStore.localBranches.slice()
          .sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0) || a.name.localeCompare(b.name))
          .map(b => ({
            id: `checkout:${b.name}`,
            title: t('commandPalette.cmdCheckoutBranch', { name: b.name }),
            subtitle: b.isCurrent ? t('commandPalette.branchCurrent') : undefined,
            category: t('commandPalette.categoryBranch'),
            icon: GitBranchOutline,
            keywords: `branch checkout switch 切换 分支 ${b.name}`,
          }))),
    // 实例快速切换（P-20261002-111）：与项目/分支快速切换对称（统一入口第三块）。
    // 清单来自 instance store（打开面板时 ensureInstancesFresh 刷新），复用
    // orderedInstances 展示序（本机置顶、远程按名），当前实例副标题标注；
    // 关键词含实例名与主机地址（输地址/IP 也能直达）。清单为空或仅本机单实例
    // 不显示该组。分发在 useLayoutViews.handlePaletteCommand——走
    // store.selectInstance 既有切换链路（总览同款）
    ...(instanceStore.instances.length <= 1
      ? []
      : instanceStore.orderedInstances.map(inst => ({
          id: `switch-instance:${inst.id}`,
          title: t('commandPalette.cmdSwitchInstance', { name: inst.isLocal ? t('instance.local') : inst.name }),
          subtitle: inst.id === instanceStore.currentInstanceId ? t('commandPalette.instanceCurrent') : undefined,
          category: t('commandPalette.categoryInstance'),
          icon: ServerOutline,
          keywords: `instance switch 切换 实例 ${inst.isLocal ? t('instance.local') : inst.name} ${inst.url}`,
        }))),
    // 按模板新建会话（P-20261005-10）：P-16 任务模板的全局直达动态组——每模板
    // 一条命令（switch-project 族形态），执行链直达建会话（模板即已定配置），
    // paletteUsage 频率加权让高频模板自学习置顶；keywords 携模板正文前几词
    // （内容可搜）；清单未加载/为空不出该组。分发见
    // useLayoutViews.handlePaletteCommand（useAgentTemplateLaunch）
    ...taskTemplates.templates.value.map(x => ({
      id: `template:${x.id}`,
      title: t('commandPalette.cmdNewFromTemplate', { name: x.name }),
      category: t('commandPalette.categoryTemplate'),
      icon: ChatbubblesOutline,
      keywords: `template new session 模板 新建 会话 ${templatePromptKeywords(x.prompt)}`,
    })),
    // 多主机巡检对比（P-20261004-58）：机队级命令不按主机展开（勾选在弹窗内做）
    {
      id: 'diag-compare-batch',
      title: t('commandPalette.cmdDiagCompare'),
      category: t('commandPalette.categoryRemoteOps'),
      icon: StatsChartOutline,
      keywords: 'diagnose batch fleet compare inspect 巡检 批量 对比 主机',
    },
    ...remoteHostStore.hosts.map(h => [
      // 连接主机（P-20261005-218）：动态命令族第三形态——「连接：<主机名>」
      // 跨页一步直连（编辑器/git 页免切远程视图找卡片三步）。执行跳远程视图
      // + 复用主机卡片点击语义（已有终端聚焦最近、无则新开，RemoteConsoleView
      // tryAutoOpen→focusHost）；标题前缀「连接：」与诊断/执行两形态区分。
      // 图标随 ACTION_ICONS 'terminal'（连接=开 SSH 终端，与 new-terminal 同族）
      {
        id: `connect-host:${h.id}`,
        title: t('commandPalette.cmdConnectHost', { name: h.name }),
        category: t('commandPalette.categoryRemoteOps'),
        icon: TerminalOutline,
        keywords: 'connect ssh terminal 连接 远程 主机',
      },
      {
        id: `diag-host:${h.id}`,
        title: t('commandPalette.cmdDiagnoseHost', { name: h.name }),
        category: t('commandPalette.categoryRemoteOps'),
        icon: PulseOutline,
        keywords: 'diagnose remote host ssh 诊断',
      },
      {
        id: `exec-host:${h.id}`,
        title: t('commandPalette.cmdExecHost', { name: h.name }),
        category: t('commandPalette.categoryRemoteOps'),
        icon: ServerOutline,
        keywords: 'remote exec ssh run command 执行',
      },
    ]).flat(),
  ])

  /** 判断当前应显示命令面板还是 Quick Open */
  const isPaletteOpen = computed(() => showCommandPalette.value || showQuickOpen.value)

  function closePalettes() {
    showCommandPalette.value = false
    showQuickOpen.value = false
  }

  return {
    showCommandPalette,
    showQuickOpen,
    paletteInitialMode,
    showProjectSearch,
    projectSearchSeed,
    projectSearchGlobSeed,
    showOutline,
    showTaskRunner,
    showBookmarkList,
    showTerminalHistorySearch,
    showTerminalOutputSearch,
    showTerminalPorts,
    showSelfCheck,
    paletteFiles,
    paletteFilesLoading,
    paletteFilesTruncated,
    paletteRemoteFiles,
    paletteFilesCacheKey,
    paletteCommands,
    isPaletteOpen,
    openCommandPalette,
    openQuickOpen,
    openProjectSearch,
    loadPaletteFiles,
    closePalettes,
  }
}
