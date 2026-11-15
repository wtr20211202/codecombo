import { ref, watch } from 'vue'
// router 直引（非 inject）：场景 swap 钩子是模块级一次性安装（installNavLayoutMemory
// 同款先例），且 restore 链的落地守卫要在任意调用点读到当前路由——业务单测的全局
// setup 把 vue-router 整体 mock（../router 求值为 undefined），本模块所有 router
// 触点都必须带守卫
import router from '../router'
import { useUIStateStore } from '../stores/uiState'

// 侧栏视图枚举单一真源：类型由清单派生，归一白名单天然穷尽。'notes' 已随
// P-20261108-2 退役——笔记成主区/首页独立视图（见 showNotesView），不再走侧栏
export const SIDE_VIEW_IDS = ['files', 'changes', 'todos', 'stream', 'env', 'sync'] as const
export type SideView = typeof SIDE_VIEW_IDS[number]
export type BottomTab = 'git' | 'terminal' | 'commit' | 'console' | 'preview' | 'problems'
export type CommitLocation = 'sidebar' | 'bottom'

/** 持久化 sideView 归一（P-20261108-2）：旧存档的已退役值（'notes'）或任何未知
 *  值回落 'files'——不归一则 SidePanel 分发链落到末位 v-else（提交面板），渲染与
 *  活动栏高亮错位的死分支（bottomTab 'commit'→'git' 归一同款先例） */
export function normalizeSideView(raw: unknown): SideView {
  return (SIDE_VIEW_IDS as readonly unknown[]).includes(raw) ? raw as SideView : 'files'
}

/** 出厂默认布局快照（P-20261002-74）：一键重置与测试态复位共用同一份真源——
 *  面板开合/双栏宽度/底栏高度/最大化态的「初始值」只在此定义一次 */
export const LAYOUT_DEFAULTS: {
  sideView: SideView
  showSidePanel: boolean
  showBottomPanel: boolean
  bottomTab: BottomTab
  commitLocation: CommitLocation
  sidePanelWidth: number
  bottomPanelHeight: number
  bottomPanelMaximized: boolean
  bottomPanelEditorMaximized: boolean
  terminalMaximized: boolean
} = {
  sideView: 'files',
  showSidePanel: true,
  showBottomPanel: false,
  bottomTab: 'terminal',
  commitLocation: 'sidebar',
  sidePanelWidth: 280,
  bottomPanelHeight: 260,
  bottomPanelMaximized: false,
  bottomPanelEditorMaximized: false,
  terminalMaximized: false,
}

// 模块级共享状态 — 所有调用者共享同一套响应式变量
const sideView = ref<SideView>('files')
const showSidePanel = ref(true)
const showBottomPanel = ref(false)
const bottomTab = ref<BottomTab>('terminal')
const commitLocation = ref<CommitLocation>('sidebar')
const sidePanelWidth = ref(280)
const bottomPanelHeight = ref(260)
// 底部面板全屏最大化（覆盖整个视窗，含左侧活动栏）
const bottomPanelMaximized = ref(false)
// 底部面板编辑器区域最大化（仅覆盖编辑器区域，保留左侧活动栏/顶部工具栏/底部状态栏）
// 与 bottomPanelMaximized 互斥：开启一个时自动关闭另一个
const bottomPanelEditorMaximized = ref(false)
// 终端组件自身最大化（脱离底部面板，全屏覆盖整个视窗）
// 与 bottomPanelMaximized/bottomPanelEditorMaximized 互斥
const terminalMaximized = ref(false)
// 编辑器组临时最大化（P-20261004-64）：当前暂占编辑器区全宽的组号（0 主组 /
// 1 分屏组），null = 无。对照工作流（双组对照两文件）临时全宽看一侧——兄弟组
// v-show 隐藏（Monaco 实例与视图快照保活，还原零重建），组结构/tab 全保留。
// 临时聚焦态：不持久化（uiState 无键），还原路径 = 再双击 / Esc / 关分屏
const editorGroupMaximized = ref<number | null>(null)
// 终端 pane 临时最大化（P-20261004-64，与编辑器组同款语义）：当前暂占终端
// 内容区全幅的 pane 定位（tabId 归属 tab，paneId = tab.id 主 pane 或
// panes[1] 副 pane），null = 无。仅 split 双 pane 可进入；兄弟 pane v-show
// 隐藏（xterm 实例与 WS 会话不断），还原后 fit 自愈链重触发（TerminalView
// 的布局态 watch 统一 refit）。同样不持久化
const terminalPaneMaximized = ref<{ tabId: string; paneId: string } | null>(null)
// 远程控制台视图（替换主内容区，左侧工具栏/顶栏保留；会话管理与 XShell 对齐）
const showRemoteConsole = ref(false)
// 项目仪表盘视图（P-20261005-224：git/会话/问题/近期活动四卡一屏，替换主内容区，
// 与远程/分享/dsh 同层级互斥）。显隐不落 uiState（纯查看面，刷新回到上次工作
// 形态而非查看态；入口 = 活动栏按钮 / ?view=dashboard / 默认落点设置）
const showDashboard = ref(false)
// 文件分享管理视图（替换主内容区，与远程控制台同层级互斥）。显隐落 uiState
// shareManager.open（P-20261112-6-S3：远程/dsh/笔记开态均持久化唯它不落的族内
// 缺口补齐——文件分享管理控制台同样是工作面而非纯查看面，刷新后原样恢复；
// dshConsole.open 同族口径）
const showShareManager = ref(false)
// dsh 控制台视图（P6：iframe 嵌入本机 dsh Web UI，经回环反代通道；与远程/分享互斥）
const showDshConsole = ref(false)
// dsh 控制台最大化（fixed 全屏覆盖，类似底部终端最大化；关闭控制台即还原）。
// 临时聚焦态：不持久化（uiState 无键），刷新后从常态开始——与编辑器组/终端
// pane 最大化（P-20261004-64）同口径，还原路径 = 再点最大化钮 / 关闭控制台
const dshMaximized = ref(false)
// 笔记独立视图（P-20261108-2：笔记脱离侧栏窄条成 notepad 式大区域）：项目页占
// 主区编辑器位（第六主区占用者，与远程/分享/dsh/仪表盘同层级互斥），首页以近
// 全屏 overlay 呈现——NotesView 宿主按路由各挂一份。显隐落 uiState notesView
// 分场景槽（P-20261112-6-S1 写作现场非纯查看面刷新原样恢复——推翻 P-20261108-2
// 「不落 uiState」定案；P-20261114-4-S2 分场景槽：project 场景落 open、home 场景
// 落 homeOpen，工作面归属打开它的场景，dsh 控制台开态同族口径）
const showNotesView = ref(false)

// ============== per-scene 运行态快照（P-20261114-4-S1） ==============
// 「工作面归属打开它的场景」（用户两次澄清定案，推翻 P-20261114-1「工作面跟随
// 路由」的首页 overlay 呈现）：home/project 两张内存快照表，路由切换离开场景前
// 采集主区视图族运行态、进入场景恢复该场景快照——内存读写零网络。①项目开笔记→
// 回首页不显示→回项目恢复；②首页显式打开→首页显示→去项目不跟随；双向对称。
// 覆盖五 ref（notes/dsh/remote/share/dashboard）：dsh/notes 的首页浮层由同一组
// 共享 ref 驱动，remote 首页 overlay 自本提案起收敛绑共享 ref（HomeView 本地 ref
// 死于卸载且其内嵌 RemoteConsoleView persistState 绑共享 ref 会把首页使用回声成
// open=false 腐化槽位），share/dashboard 无首页形态。快照恢复经 router.afterEach
// 先于宿主挂载（离开侧无宿主钩子可靠捕获；everOpened immediate 首帧如实呈现免
// 闪现）。agent docked 不入快照：回首页 hideDocked（P-20261107-3 导航语义）+
// 项目间 capture/restoreProjectDocked（useAgentTerminal 既有机制）照旧
export type UiScene = 'home' | 'project'

interface SceneUiSnapshot {
  notes: boolean
  dsh: boolean
  remote: boolean
  share: boolean
  dashboard: boolean
}

// 无快照场景的首进回落态（全关）：跨场景不继承上一场景运行态（②的对称面——
// 首页开态不跟随去项目，反之亦然）。boot 首导航同径：refs 出厂值本就全关，落
// defaults 是无操作，boot 槽恢复链在其后照旧落值（P-20261114-4-S2 分场景槽：
// 恢复链读所在场景槽位——home 读 homeOpen 子字段、project 读既有 open 子字段）
const SCENE_UI_DEFAULTS: SceneUiSnapshot = { notes: false, dsh: false, remote: false, share: false, dashboard: false }

const sceneSnapshots: Record<UiScene, SceneUiSnapshot | null> = { home: null, project: null }

// swap 抑制深度（suppress 门禁，评审修订点①）：恢复写入期间持久化 watch
// （persistNotesViewOpen/persistDshConsoleOpen/persistShareManagerOpen +
// RemoteConsoleView.persistState）静默——否则每次路由往返发 3+ spurious PATCH，
// 且进入场景的恢复值经 persist 回声错写持久化槽（P-20261114-4-S2 起写面已按
// 场景分槽，回声写本场景槽同值无害，但抑制仍免除往返噪声 PATCH；分槽前该回声
// 是跨槽腐化路径）。
// 计数器形态防快速连续导航的抑制窗重叠；watch 必须 flush:'sync' 才能被门禁看见
// ——异步 flush 的回调晚于 finally 解除，门禁形同虚设
let uiSwapSuppressDepth = 0

/** swap 恢复写入是否在途：一切对五 ref 的即时持久化写方（本模块三条 watch +
 *  RemoteConsoleView.persistState）先对账本门禁再落盘 */
export function isUiSceneSwapInFlight(): boolean {
  return uiSwapSuppressDepth > 0
}

function sceneOfRouteName(name: unknown): UiScene | null {
  return name === 'home' ? 'home' : name === 'project' ? 'project' : null
}

/** 当前场景：由路由名派生（afterEach 触发时 currentRoute 已切至目标——「切场景
 *  指针」即路由器自身的指针切换，不另设第二真源防漂移）。router 不可用的环境
 *  （业务单测 mock / Node 装载语境）恒 null：restore 守卫不设防、快照读写跳过，
 *  既有单测语义零变化。导出供模块外的场景写面门禁消费（RemoteConsoleView
 *  persistState 的 home 场景 open 子键静默，P-20261114-4-S2 remote 槽随件评估） */
export function currentUiScene(): UiScene | null {
  const route = router?.currentRoute
  if (!route || typeof route.value === 'undefined' || !route.value) return null
  return sceneOfRouteName(route.value.name)
}

function captureSceneUi(scene: UiScene): void {
  sceneSnapshots[scene] = {
    notes: showNotesView.value,
    dsh: showDshConsole.value,
    remote: showRemoteConsole.value,
    share: showShareManager.value,
    dashboard: showDashboard.value,
  }
}

function restoreSceneUi(scene: UiScene): void {
  const snap = sceneSnapshots[scene] ?? SCENE_UI_DEFAULTS
  showNotesView.value = snap.notes
  showDshConsole.value = snap.dsh
  showRemoteConsole.value = snap.remote
  showShareManager.value = snap.share
  showDashboard.value = snap.dashboard
}

/** 场景 swap 四步序（顺序钉死，useAgentTerminal.ts:445「先采集后收起顺序不可换」
 *  同款纪律）：①离开场景先采集——此刻 refs 仍是离开场景的值，先切后采会把离开
 *  场景的值采进进入场景桶（跨桶腐化）→ ②切场景指针（路由器已在 afterEach 前切
 *  毕）→ ③恢复 refs（suppress 全程在位）→ ④解除。
 *  monitor 等非 home/project 路由是中性区：离开已知场景照常采集、进入不恢复
 *  （refs 维持原值，中性页不渲染视图族），中性区→已知场景正常恢复 */
export function handleUiSceneSwap(toName: unknown, fromName: unknown): void {
  const fromScene = sceneOfRouteName(fromName)
  const toScene = sceneOfRouteName(toName)
  if (fromScene === toScene) return // 同场景导航（query 变更/实例切换 remount）零交换
  uiSwapSuppressDepth++
  try {
    if (fromScene) captureSceneUi(fromScene) // ① 离开场景先采集
    // ② 场景指针 = 路由（见 currentUiScene 注），此处无独立指针可切
    if (toScene) restoreSceneUi(toScene) // ③ 恢复 refs（suppress 中）
  } finally {
    uiSwapSuppressDepth-- // ④ 解除
  }
}

let sceneSwapHookInstalled = false
function installSceneSwapHook(): void {
  // useAgentTerminal.installNavLayoutMemory 同款守卫：全局 setup 把 vue-router
  // 整体 mock（业务单测不触路由惯例）——router 为 undefined 的环境跳过安装；
  // boot 首导航早于本钩子安装点（首调用在宿主 setup 期）不触发 swap：refs 出厂
  // 全关、表空落 defaults 为无操作，boot 槽恢复链照旧
  if (sceneSwapHookInstalled) return
  if (!router || typeof router.afterEach !== 'function') return
  sceneSwapHookInstalled = true
  router.afterEach((to, from) => {
    handleUiSceneSwap(to?.name, from?.name)
  })
}

// 显式开关写当前场景快照（write-through）：toggle/close/互斥隐式关闭/深链/?view=
// 携参等一切 ref 写路径统一经本 watch 落当前场景快照表（离开侧 captureSceneUi
// 兜底对账）。swap 恢复写入期间跳过（表内容即恢复源，镜像写无意义）；异步 flush
// 下回调晚于解除，此时恢复已毕、路由已切，读当前 refs 写当前场景语义仍正确，
// 且本 watch 只写快照表不写 refs，无递归风险
watch(
  [showNotesView, showDshConsole, showRemoteConsole, showShareManager, showDashboard],
  () => {
    const scene = currentUiScene()
    if (!scene || uiSwapSuppressDepth > 0) return
    captureSceneUi(scene)
  },
)

// 下次进入项目时若侧栏未打开则兜底打开文件面板：终端会话管理「打开项目」跳转
// 语义——布局恢复（上次 UI 状态）由 Layout bootstrap 完成，本标志只负责
// 「上次什么都没开 / 从未进入过」时的兜底；bootstrap 在布局恢复后消费
const pendingSideFilesOpen = ref(false)
function consumePendingSideFilesOpen(): boolean {
  const v = pendingSideFilesOpen.value
  pendingSideFilesOpen.value = false
  return v
}

// 下次布局恢复时 bottomTab 以跳转意图为准（不被 uiState 覆盖）：
// 审批/提问卡「查看发起会话」类跳转先设 bottomTab='terminal' 再路由进项目页，
// 挂载期 ui-state 恢复（上次会话保存的 tab）异步落地晚于该设置，会把终端 tab
// 翻回旧值——TerminalView 随 tab 卸载、待激活事件落空、跳转目标不渲染。
// 跳转方在设 bottomTab 的同时打标，bootstrap 布局恢复时消费一次（与
// pendingSideFilesOpen 同款消费语义）；无跳转的普通挂载恢复行为不变
const pendingBottomTab = ref<BottomTab | null>(null)
function consumePendingBottomTab(): BottomTab | null {
  const v = pendingBottomTab.value
  pendingBottomTab.value = null
  return v
}

// 侧栏视图跳转意图（P-20261005-223）：pendingBottomTab 的侧栏孪生——navigate
// {view:'changes'} 从他页/冷启动进入项目页时，跳转方先行打标（彼时 ui-state
// 恢复尚未落地，直接设 sideView 会被 restoreLayoutOnly 用上次保存值覆盖），
// bootstrap 布局恢复时消费一次并保证侧栏可见；消费语义与 pendingBottomTab 同款
const pendingSideView = ref<SideView | null>(null)
function consumePendingSideView(): SideView | null {
  const v = pendingSideView.value
  pendingSideView.value = null
  return v
}

// 拖拽调整面板宽高的实现分别在宿主组件内（SidePanel 的侧栏 / Layout 的底部面板），
// 本模块只持有布局状态

function toggleBottomPanel() {
  showBottomPanel.value = !showBottomPanel.value
}

function toggleSidePanel() {
  showSidePanel.value = !showSidePanel.value
}

/** 切换远程控制台主区视图（编辑器 ↔ 远程控制台；侧栏/顶栏/状态栏常驻） */
function toggleRemoteConsole() {
  // 主区视图被任一最大化态覆盖：先还原再切换（点啥显示啥）
  restoreFromMaximized()
  showRemoteConsole.value = !showRemoteConsole.value
  // 主区多视图互斥：进远程控制台时关闭分享管理/dsh 控制台/项目仪表盘/笔记视图
  if (showRemoteConsole.value) {
    showShareManager.value = false
    closeDshConsole()
    closeDashboard()
    closeNotesView()
  }
}

/** 打开远程控制台主区视图（幂等；palette connect-host 直达用——「连主机」
 *  是目标态动作非 toggle，重复执行不得收起视图）。与 toggleRemoteConsole
 *  共用互斥与最大化还原前置（openDashboard 同款多入口共用惯例） */
function openRemoteConsole() {
  restoreFromMaximized()
  showRemoteConsole.value = true
  showShareManager.value = false
  closeDshConsole()
  closeDashboard()
  closeNotesView()
}

/** 打开项目仪表盘主区视图（幂等；与远程/分享/dsh/笔记同层级互斥）。
 *  toggle/深链 query/默认落点三入口共用同一互斥与最大化还原前置 */
function openDashboard() {
  restoreFromMaximized()
  showDashboard.value = true
  showRemoteConsole.value = false
  showShareManager.value = false
  closeDshConsole()
  closeNotesView()
}

/** 切换项目仪表盘主区视图（活动栏按钮语义：开↔关） */
function toggleDashboard() {
  if (showDashboard.value) {
    showDashboard.value = false
    return
  }
  openDashboard()
}

/** 关闭项目仪表盘（打开文件等编辑器意图接管主区时调用） */
function closeDashboard() {
  showDashboard.value = false
}

/** 打开笔记独立视图（幂等；rail/命令面板/沉淀助力/首页入口共用）：与远程/分享/
 *  dsh/仪表盘互斥 + 最大化还原前置（openDashboard 同款）；agent docked 的互斥在
 *  调用方与 AgentTerminal 反向 watch（本模块不能反向引用 useAgentTerminal） */
function openNotesView() {
  restoreFromMaximized()
  showNotesView.value = true
  showRemoteConsole.value = false
  showShareManager.value = false
  closeDshConsole()
  closeDashboard()
}

/** 切换笔记独立视图（活动栏按钮/命令面板 toggle-notes 语义：开↔关） */
function toggleNotesView() {
  if (showNotesView.value) closeNotesView()
  else openNotesView()
}

/** 关闭笔记独立视图（头部关闭钮/首页 Esc/其他主区视图或编辑器意图接管时调用） */
function closeNotesView() {
  showNotesView.value = false
}

/** 切换分享管理主区视图（与远程控制台同层级互斥） */
function toggleShareManager() {
  restoreFromMaximized()
  showShareManager.value = !showShareManager.value
  if (showShareManager.value) {
    showRemoteConsole.value = false
    closeDshConsole()
    closeDashboard()
    closeNotesView()
  }
}

/** 切换 dsh 控制台主区视图（与远程控制台/分享管理同层级互斥；
 *  agent docked 管理页由 AgentTerminal 的反向兜底 watch 处理） */
function toggleDshConsole() {
  restoreFromMaximized()
  showDshConsole.value = !showDshConsole.value
  if (showDshConsole.value) {
    showRemoteConsole.value = false
    showShareManager.value = false
    closeDashboard()
    closeNotesView()
  } else {
    dshMaximized.value = false // 关闭控制台即还原最大化，下次打开从常态开始
  }
}

/** 关闭 dsh 控制台并还原其最大化覆盖层（其它主区视图/编辑器接管主区时调用；
 *  与 toggleDshConsole 关闭分支同一语义：下次打开从常态开始） */
function closeDshConsole() {
  if (!showDshConsole.value) return
  showDshConsole.value = false
  dshMaximized.value = false
}

// ============== dsh 控制台开关持久化（刷新后按所在场景槽原样恢复） ==============
// watch 统一持久化而非散在各开关里：写入路径不止 toggle/close 两处（浮层头部
// 关闭钮直写 showDshConsole、主区互斥的隐式关闭等），漏一处刷新后就会复活。
// 即时写模式（remoteConsole.open 同款）——auto-save 只挂在项目页 Layout，
// 首页浮层的开合不经它。flush:'sync' + suppress 门禁：场景 swap 的恢复写入必须
// 被门禁同步看见（异步 flush 回调晚于解除），见 uiSwapSuppressDepth 注。
// 分场景槽（P-20261114-4-S2）：写当前场景槽位——home 场景落 dshConsole.homeOpen、
// project/null 落 dshConsole.open，两槽互不覆写（scene=null 单测环境按 project
// 槽，既有单测语义零变化）
function persistDshConsoleOpen() {
  if (isUiSceneSwapInFlight()) return // 场景 swap 恢复写入不落盘
  try {
    void useUIStateStore().saveDshConsoleOpen(showDshConsole.value, currentUiScene())
  } catch { /* pinia 未激活等环境问题静默 */ }
}
watch(showDshConsole, persistDshConsoleOpen, { flush: 'sync' })

// once memo 分场景分桶（P-20261114-4-S1，评审修订点②）：键 = 发起时刻场景。
// boot 恢复链在 boot 场景发起；在途 GET 期间切场景则落地守卫丢弃并清该场景桶
// （丢弃后下次进入该场景宿主重挂自然再武装），防 boot 场景槽值写进新场景（越界
// 复发路径）。P-20261114-4-S2 起桶内恢复读发起场景槽位（home=homeOpen 子字段 /
// project=open 子字段），「每场景每 load 首进读槽」由本分桶 + 场景宿主重挂的
// once 调用承载（boot=首进特例；boot@home 后首进 project 时 project 桶为空，
// 宿主挂载链自然再武装读 project 槽）。scene=null（单测/无路由环境）桶照用、
// 守卫不设防——既有单测语义零变化。resetPanelLayout 清桶
const dshRestoreBuckets = new Map<UiScene | null, Promise<void>>()
const notesRestoreBuckets = new Map<UiScene | null, Promise<void>>()
const shareRestoreBuckets = new Map<UiScene | null, Promise<void>>()

/** 页面加载后恢复上次的 dsh 控制台开关（首页/项目页各自挂载时调用一次；
 *  路由间切换不刷新页面，内存状态本来就在，once 防重复请求）。
 *  守卫为 memoized promise（P-20261112-6-S1）并按发起场景分桶（每场景每 load
 *  首进读该场景槽一次，P-20261114-4-S2——boot@home 后首进 project 由宿主重挂
 *  的 once 调用再武装读 project 槽）：并发调用方共享同一在途恢复，既有 .then
 *  接力（文件深链等其落地）语义不变；执行前先等 notes 开态恢复落地
 *  （restoreNotesViewOnce）——「notes 先、dsh 后」显式定序收口在此，不依赖
 *  宿主挂载次序涌现。dsh 打开时按主区互斥清掉远程/分享/笔记视图的恢复（dsh
 *  是最后一次用户操作，异常双真存档 dsh 后到者胜出） */
export function restoreDshConsoleOnce(): Promise<void> {
  const scene = currentUiScene()
  let p = dshRestoreBuckets.get(scene)
  if (!p) {
    p = restoreNotesViewOnce().then(() => doRestoreDshConsole(scene))
    dshRestoreBuckets.set(scene, p)
  }
  return p
}

async function doRestoreDshConsole(initiatedScene: UiScene | null): Promise<void> {
  let open = false
  try {
    // 分场景槽读取（P-20261114-4-S2「每场景每 load 首进读该场景槽」）：按发起
    // 场景取槽位——home 读 dshConsole.homeOpen、project/null 读 dshConsole.open
    // （旧单槽值原位即 project 槽，读取零丢失）；在途 GET 期间切场景由下方守卫
    // 丢弃，槽值不会写进错误场景
    open = await useUIStateStore().getDshConsoleOpen(initiatedScene)
  } catch { /* silent */ }
  // boot 恢复场景守卫：在途 GET 期间已切场景则丢弃——boot 场景槽值写进新场景是
  // 越界复发路径（notes/dsh/share 三链同款）。丢弃同时清发起场景桶：下次进入该
  // 场景时宿主重挂的 once 调用自然再武装（重新拉取、正确场景落地）
  if (initiatedScene !== null && currentUiScene() !== initiatedScene) {
    dshRestoreBuckets.delete(initiatedScene)
    return
  }
  if (!open) return
  showDshConsole.value = true
  showRemoteConsole.value = false
  showShareManager.value = false
  closeDashboard()
  closeNotesView()
}

// ============== 笔记视图开关持久化（刷新后按所在场景槽原样恢复，P-20261112-6-S1） ==============
// watch 统一持久化而非散在各开关里（persistDshConsoleOpen 同款论证）：写入路径
// 不止 toggle/close 两处——主区互斥的隐式关闭（开远程/分享/dsh/仪表盘）、首页
// Esc、agent docked 反向 watch 等直写/间接改写 showNotesView，漏一处刷新后就会
// 复活。即时写模式（remoteConsole.open 同款）——auto-save 只挂在项目页 Layout，
// 首页 overlay 的开合不经它。分场景槽（P-20261114-4-S2）：home 场景落
// notesView.homeOpen、project/null 落 notesView.open，两槽互不覆写
function persistNotesViewOpen() {
  if (isUiSceneSwapInFlight()) return // 场景 swap 恢复写入不落盘（persistDshConsoleOpen 同款门禁）
  try {
    void useUIStateStore().saveNotesViewOpen(showNotesView.value, currentUiScene())
  } catch { /* pinia 未激活等环境问题静默 */ }
}
watch(showNotesView, persistNotesViewOpen, { flush: 'sync' })

/** 页面加载后恢复上次的笔记视图开关（NotesView 双宿主 onMounted 各调一次，
 *  once 防重复；路由间切换不刷新页面，内存状态本来就在——once memo 按发起场景
 *  分桶，每场景每 load 首进读该场景槽一次（P-20261114-4-S2），见 dshRestoreBuckets
 *  注）。仅仍为关态时置开——异步落地窗口内用户已手动操作的窄窗竞态不回卷（dsh
 *  同构可接受）；开启时按 openNotesView 语义清互斥视图（restoreFromMaximized
 *  除外：最大化态不持久化，boot 恢复期必然为出厂 null）。dsh 恢复
 *  （restoreDshConsoleOnce）在本恢复之后执行——恢复顺序显式固定「notes 先、
 *  dsh 后」，不依赖宿主挂载次序涌现：异常双真存档（UI 不可达仅防御）dsh 后到
 *  者胜出，对齐主区互斥「最后操作者优先」；dsh 链不反向依赖本函数结果值（单向
 *  await，防 promise 互相采纳死锁） */
export function restoreNotesViewOnce(): Promise<void> {
  const scene = currentUiScene()
  let p = notesRestoreBuckets.get(scene)
  if (!p) {
    p = doRestoreNotesView(scene)
    notesRestoreBuckets.set(scene, p)
  }
  return p
}

async function doRestoreNotesView(initiatedScene: UiScene | null): Promise<void> {
  let open = false
  try {
    // 分场景槽读取（doRestoreDshConsole 同款）：按发起场景取槽位——home 读
    // notesView.homeOpen、project/null 读 notesView.open（旧单槽值原位即
    // project 槽，读取零丢失）
    open = await useUIStateStore().getNotesViewOpen(initiatedScene)
  } catch { /* silent */ }
  // boot 恢复场景守卫（doRestoreDshConsole 同款）：在途 GET 期间已切场景则丢弃
  // 并清发起场景桶（下次进入自然再武装）
  if (initiatedScene !== null && currentUiScene() !== initiatedScene) {
    notesRestoreBuckets.delete(initiatedScene)
    return
  }
  if (!open || showNotesView.value) return
  showNotesView.value = true
  showRemoteConsole.value = false
  showShareManager.value = false
  closeDshConsole()
  closeDashboard()
}

// ============== 分享管理视图开关持久化（刷新后原样恢复，P-20261112-6-S3） ==============
// watch 统一持久化而非散在各开关里（persistNotesViewOpen/persistDshConsoleOpen
// 同款论证）：写入路径不止 toggle 一处——主区互斥的隐式关闭（开远程/dsh/仪表盘/
// 笔记）、?view=shares 深链、通知 panel:share-manager 直达等都在改写
// showShareManager，漏一处刷新后就会复活。即时写模式（remoteConsole.open 同款）
function persistShareManagerOpen() {
  if (isUiSceneSwapInFlight()) return // 场景 swap 恢复写入不落盘（persistDshConsoleOpen 同款门禁）
  try {
    void useUIStateStore().saveShareManagerOpen(showShareManager.value)
  } catch { /* pinia 未激活等环境问题静默 */ }
}
watch(showShareManager, persistShareManagerOpen, { flush: 'sync' })

/** 页面加载后恢复上次的分享管理视图开关（项目页主区视图，无首页形态——宿主为
 *  useLayoutShell boot 链，once 防重复；once memo 按发起场景分桶，见
 *  dshRestoreBuckets 注）。执行前先等 dsh 恢复落地（内部链
 *  restoreDshConsoleOnce → restoreNotesViewOnce），恢复顺序显式固定
 *  「notes 先、dsh 次、share 后」：异常双真存档（UI 不可达仅防御）share 后到者
 *  胜出，与主区互斥「最后落位者优先」同构；深链消费（flushFileDeepLink）再排
 *  其后——文件意图是「看编辑器」，showEditorMain 收掉刚恢复的分享管理视图。
 *  开启时按 toggleShareManager 开分支语义清互斥视图（restoreFromMaximized 除外：
 *  最大化态不持久化，boot 恢复期必然为出厂 null）；仅仍为关态时置开——落地窗口
 *  内用户已手动操作的窄窗竞态不回卷（notes/dsh 同构可接受） */
export function restoreShareManagerOnce(): Promise<void> {
  const scene = currentUiScene()
  let p = shareRestoreBuckets.get(scene)
  if (!p) {
    p = restoreDshConsoleOnce().then(() => doRestoreShareManager(scene))
    shareRestoreBuckets.set(scene, p)
  }
  return p
}

async function doRestoreShareManager(initiatedScene: UiScene | null): Promise<void> {
  let open = false
  try {
    open = await useUIStateStore().getShareManagerOpen()
  } catch { /* silent */ }
  // boot 恢复场景守卫（doRestoreDshConsole 同款）：在途 GET 期间已切场景则丢弃
  // 并清发起场景桶（下次进入自然再武装）
  if (initiatedScene !== null && currentUiScene() !== initiatedScene) {
    shareRestoreBuckets.delete(initiatedScene)
    return
  }
  if (!open || showShareManager.value) return
  showShareManager.value = true
  showRemoteConsole.value = false
  closeDshConsole()
  closeDashboard()
  closeNotesView()
}

function togglePanel(panel: 'files' | 'changes' | 'todos' | 'stream' | 'env' | 'sync' | 'git' | 'terminal') {
  // 「点啥显示啥」通用规则（用户实测：终端最大化后点活动栏其他功能无反应观感）：
  // 目标视图被最大化面板覆盖时，先还原最大化再执行切换——
  //   侧栏（files/changes/todos/stream/env/sync）：仅被 终端最大化/底部全屏 覆盖（编辑器区最大化保留侧栏可见）
  //   底部 tab（git/terminal）：面板自身即被最大化的对象，还原为停靠态并落在该 tab
  if (panel === 'files' || panel === 'changes' || panel === 'todos' || panel === 'stream' || panel === 'env' || panel === 'sync') {
    if (bottomPanelMaximized.value || terminalMaximized.value) restoreFromMaximized()
    // 侧边栏视图：已激活则关闭，否则切换并打开
    if (showSidePanel.value && sideView.value === panel) {
      showSidePanel.value = false
    } else {
      sideView.value = panel
      showSidePanel.value = true
    }
  } else if (panel === 'git' || panel === 'terminal') {
    if (bottomPanelMaximized.value || terminalMaximized.value) {
      restoreFromMaximized()
      bottomTab.value = panel
      showBottomPanel.value = true
      return
    }
    // 底部面板视图：已激活则关闭，否则切换 tab 并打开
    if (showBottomPanel.value && bottomTab.value === panel) {
      showBottomPanel.value = false
    } else {
      bottomTab.value = panel
      showBottomPanel.value = true
    }
  }
}

// 在侧边栏显示提交面板（活动栏 changes 按钮专用）
function showCommitInSidebar() {
  if (bottomPanelMaximized.value || terminalMaximized.value) restoreFromMaximized()
  if (commitLocation.value === 'bottom') {
    commitLocation.value = 'sidebar'
    showBottomPanel.value = false
    sideView.value = 'changes'
    showSidePanel.value = true
  } else if (showSidePanel.value && sideView.value === 'changes') {
    showSidePanel.value = false
  } else {
    sideView.value = 'changes'
    showSidePanel.value = true
  }
}

// 切换提交面板位置（toggleCommitLocation）已随底部"变更" tab 一并退役：
// 提交面板只保留活动栏左侧形态（showCommitInSidebar），commitLocation 恒为
// 'sidebar'（类型与 bootstrap 归一保留，历史 uistate 不再产生 bottom 值）

/** 面板聚焦（navigate {view:'changes'} 等注意力引导专用，P-20261005-223）：
 *  确保目标面板可见——与 togglePanel 开关语义的差别在「已可见时保持打开」
 *  （引导意图没有「收起」半程）；被最大化面板覆盖时先还原（togglePanel 同款
 *  「点啥显示啥」规则）。已在项目页时的 navigate 即时落位路径（他页进入走
 *  pendingSideView 打标由 bootstrap 恢复消费） */
function focusPanel(panel: SideView | 'git' | 'terminal') {
  if (bottomPanelMaximized.value || terminalMaximized.value) restoreFromMaximized()
  if (panel === 'git' || panel === 'terminal') {
    bottomTab.value = panel
    showBottomPanel.value = true
    return
  }
  sideView.value = panel
  showSidePanel.value = true
}

function maximizeBottomPanel() {
  bottomPanelMaximized.value = !bottomPanelMaximized.value
  // 互斥：开启全屏时关闭其他两种最大化
  if (bottomPanelMaximized.value) {
    bottomPanelEditorMaximized.value = false
    terminalMaximized.value = false
  }
}

// 编辑器区域最大化：仅覆盖 .ide-body 范围，保留活动栏/工具栏/状态栏
function maximizeBottomPanelEditor() {
  bottomPanelEditorMaximized.value = !bottomPanelEditorMaximized.value
  // 互斥：开启编辑器最大化时关闭其他两种
  if (bottomPanelEditorMaximized.value) {
    bottomPanelMaximized.value = false
    terminalMaximized.value = false
  }
}

// 终端组件自身最大化：脱离底部面板全屏
function maximizeTerminal() {
  terminalMaximized.value = !terminalMaximized.value
  if (terminalMaximized.value) {
    bottomPanelMaximized.value = false
    bottomPanelEditorMaximized.value = false
  }
}

// 编辑器组临时最大化 toggle（P-20261004-64）：同组再点/Esc 还原。与面板级三态
// 不互斥——组最大化是编辑器区内的内层布局态（面板最大化覆盖其上时自然不可见，
// 退栈时 Esc 先退外层面板再退内层组），互清反而破坏「结构保留」的对照工作流
function toggleEditorGroupMaximized(gi: number) {
  editorGroupMaximized.value = editorGroupMaximized.value === gi ? null : gi
}

// 终端 pane 临时最大化 toggle（P-20261004-64）：同 pane 再点/Esc 还原。
// 同 tab 内一次只一个 pane 最大化；换 pane 直接换目标（调用方保证 paneId 属
// 该 tab 的双 pane 之一）
function toggleTerminalPaneMaximized(tabId: string, paneId: string) {
  const cur = terminalPaneMaximized.value
  terminalPaneMaximized.value = cur && cur.tabId === tabId && cur.paneId === paneId ? null : { tabId, paneId }
}

// ESC 还原：按优先级退出最大化状态（终端最大化 > 编辑器区域 > 全屏）
// 返回 true 表示已处理，调用方据此决定是否 preventDefault
//
// 逐层退栈口径（P-20261004-64）：按「覆盖面从大到小」先退外层——面板级三态
// 覆盖编辑器区/全视窗（组/pane 最大化被覆盖时不可见），组与 pane 最大化是
// 编辑器区/终端内容区内的内层态，垫底退出。同屏组与 pane 同时最大化（对照
// 实验双开场景）无覆盖关系，序固定为组先 pane 后（确定即可预期）
function exitMaximizedByEsc(): boolean {
  if (terminalMaximized.value) {
    terminalMaximized.value = false
    return true
  }
  if (bottomPanelEditorMaximized.value) {
    bottomPanelEditorMaximized.value = false
    return true
  }
  if (bottomPanelMaximized.value) {
    bottomPanelMaximized.value = false
    return true
  }
  if (editorGroupMaximized.value !== null) {
    editorGroupMaximized.value = null
    return true
  }
  if (terminalPaneMaximized.value) {
    terminalPaneMaximized.value = null
    return true
  }
  return false
}

// Esc 逐层收起（P-20261004-12）：最大化之下最后一层是底栏面板本身——收起即退层
// （与头部 × 同一条 showBottomPanel=false 链路，面板隐藏 watch 随之清最大化态）。
// 终端聚焦时已被 useLayoutKeyboard 的 INPUT/TEXTAREA veto 让位 PTY，不会误关
function dismissBottomPanelByEsc(): boolean {
  if (!showBottomPanel.value) return false
  showBottomPanel.value = false
  return true
}

// 无条件退出全部最大化态（三种互斥、至多一种生效，全清做安全兜底；组/pane
// 两级内层最大化一并清——「重置回常态」语义的安全兜底面要盖住全部覆盖态）。
// 通用「点啥显示啥」前置：活动栏/命令面板等导航把视图切到被最大化面板覆盖的
// 区域时，先还原布局再显示目标（返回是否有最大化态被退出）
function restoreFromMaximized(): boolean {
  const was = terminalMaximized.value || bottomPanelMaximized.value || bottomPanelEditorMaximized.value
    || editorGroupMaximized.value !== null || terminalPaneMaximized.value !== null
  terminalMaximized.value = false
  bottomPanelMaximized.value = false
  bottomPanelEditorMaximized.value = false
  editorGroupMaximized.value = null
  terminalPaneMaximized.value = null
  return was
}

// 面板隐藏时同步退出最大化态：maximized 只是面板的一种视觉形态，宿主 v-show
// 隐藏面板后形态必须随之清除，否则残留状态让下次打开意外全屏。pane 临时最大化
// （P-20261004-64）同理随面板隐藏清除——不可见的最大化若残留，会隔空消费 Esc
// 退栈（按下无观感），与「形态随宿主显隐」既有纪律一致
watch(showBottomPanel, (v) => {
  if (!v) {
    terminalMaximized.value = false
    bottomPanelMaximized.value = false
    bottomPanelEditorMaximized.value = false
    terminalPaneMaximized.value = null
  }
})

export function usePanelLayout() {
  // 场景 swap 钩子模块级一次性安装（installSceneSwapHook 幂等；router mock 环境
  // 自动跳过）——与 useAgentTerminal.installNavLayoutMemory 同款安装惯例
  installSceneSwapHook()
  return {
    sideView, showSidePanel, showBottomPanel, bottomTab, commitLocation,
    sidePanelWidth, bottomPanelHeight, bottomPanelMaximized, bottomPanelEditorMaximized, terminalMaximized,
    editorGroupMaximized, terminalPaneMaximized,
    showRemoteConsole, showShareManager, showDshConsole, toggleDshConsole, closeDshConsole, dshMaximized,
    showDashboard, openDashboard, toggleDashboard, closeDashboard,
    showNotesView, openNotesView, toggleNotesView, closeNotesView,
    toggleBottomPanel, toggleSidePanel, togglePanel, toggleRemoteConsole, openRemoteConsole, toggleShareManager,
    maximizeBottomPanel, maximizeBottomPanelEditor, maximizeTerminal,
    toggleEditorGroupMaximized, toggleTerminalPaneMaximized,
    exitMaximizedByEsc, dismissBottomPanelByEsc, restoreFromMaximized,
    showCommitInSidebar, focusPanel,
    pendingSideFilesOpen, consumePendingSideFilesOpen,
    pendingBottomTab, consumePendingBottomTab,
    pendingSideView, consumePendingSideView,
  }
}

// 仅供测试使用：重置模块级状态
export function resetPanelLayout() {
  sideView.value = LAYOUT_DEFAULTS.sideView
  showSidePanel.value = LAYOUT_DEFAULTS.showSidePanel
  showBottomPanel.value = LAYOUT_DEFAULTS.showBottomPanel
  bottomTab.value = LAYOUT_DEFAULTS.bottomTab
  commitLocation.value = LAYOUT_DEFAULTS.commitLocation
  sidePanelWidth.value = LAYOUT_DEFAULTS.sidePanelWidth
  bottomPanelHeight.value = LAYOUT_DEFAULTS.bottomPanelHeight
  bottomPanelMaximized.value = LAYOUT_DEFAULTS.bottomPanelMaximized
  bottomPanelEditorMaximized.value = LAYOUT_DEFAULTS.bottomPanelEditorMaximized
  terminalMaximized.value = LAYOUT_DEFAULTS.terminalMaximized
  // 组/pane 两级临时最大化（P-20261004-64）不在 LAYOUT_DEFAULTS（非持久化态，
  // 无出厂快照键），测试态复位在此显式归零
  editorGroupMaximized.value = null
  terminalPaneMaximized.value = null
  showRemoteConsole.value = false
  showDashboard.value = false
  showNotesView.value = false
  showShareManager.value = false
  showDshConsole.value = false
  dshMaximized.value = false
  // per-scene 快照态复位（P-20261114-4-S1）：两张快照表 + 分场景 once 桶 +
  // 抑制计数；钩子安装位保留（幂等安装，模块存续期内无需重装）
  sceneSnapshots.home = null
  sceneSnapshots.project = null
  uiSwapSuppressDepth = 0
  dshRestoreBuckets.clear()
  notesRestoreBuckets.clear()
  shareRestoreBuckets.clear()
  pendingSideFilesOpen.value = false
  pendingBottomTab.value = null
  pendingSideView.value = null
}
