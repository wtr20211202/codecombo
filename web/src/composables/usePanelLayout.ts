import { ref, watch } from 'vue'
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
// 文件分享管理视图（替换主内容区，与远程控制台同层级互斥）
const showShareManager = ref(false)
// dsh 控制台视图（P6：iframe 嵌入本机 dsh Web UI，经回环反代通道；与远程/分享互斥）
const showDshConsole = ref(false)
// dsh 控制台最大化（fixed 全屏覆盖，类似底部终端最大化；关闭控制台即还原）
const dshMaximized = ref(false)
// 笔记独立视图（P-20261108-2：笔记脱离侧栏窄条成 notepad 式大区域）：项目页占
// 主区编辑器位（第六主区占用者，与远程/分享/dsh/仪表盘同层级互斥），首页以近
// 全屏 overlay 呈现——同一份开态，NotesView 宿主按路由各挂一份。显隐不落
// uiState（showDashboard 同款定案：纯查看面，刷新回工作形态）
const showNotesView = ref(false)

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

// ============== dsh 控制台开关持久化（刷新后原样恢复） ==============
// watch 统一持久化而非散在各开关里：写入路径不止 toggle/close 两处（浮层头部
// 关闭钮直写 showDshConsole、主区互斥的隐式关闭等），漏一处刷新后就会复活。
// 即时写模式（remoteConsole.open 同款）——auto-save 只挂在项目页 Layout，
// 首页浮层的开合不经它
function persistDshConsoleOpen() {
  try {
    void useUIStateStore().saveDshConsoleOpen(showDshConsole.value)
  } catch { /* pinia 未激活等环境问题静默 */ }
}
watch(showDshConsole, persistDshConsoleOpen)

let dshRestoreConsumed = false
/** 页面加载后恢复上次的 dsh 控制台开关（首页/项目页各自挂载时调用一次；
 *  路由间切换不刷新页面，内存状态本来就在，once 防重复请求）。
 *  dsh 打开时按主区互斥清掉远程/分享视图的恢复（dsh 是最后一次用户操作） */
export async function restoreDshConsoleOnce(): Promise<void> {
  if (dshRestoreConsumed) return
  dshRestoreConsumed = true
  let open = false
  try {
    open = await useUIStateStore().getDshConsoleOpen()
  } catch { /* silent */ }
  if (!open) return
  showDshConsole.value = true
  showRemoteConsole.value = false
  showShareManager.value = false
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
  dshRestoreConsumed = false
  pendingSideFilesOpen.value = false
  pendingBottomTab.value = null
  pendingSideView.value = null
}
