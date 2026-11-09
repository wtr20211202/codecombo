import { computed, effectScope, ref, watch } from 'vue'
import type { Router } from 'vue-router'
import router from '../router'
import { useAssistantTaskStore } from '../stores/assistantTask'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useTerminalStore } from '../stores/terminal'
import { useInstanceStore } from '../stores/instance'
import { useProjectStore } from '../stores/project'
import { usePanelLayout } from './usePanelLayout'
import { OPS_ACTIVATE_TERMINAL } from '../utils/opsEvents'
import { safeStorage } from '../utils/storage'

/**
 * 终端会话管理的 UI 状态层（形态/可见性/活动会话）——会话数据已下沉
 * useTerminalSessionsStore 统一数据源（P1）：本模块只保留 docked/float/mini
 * 形态编排与活动会话选择，数据操作（列表/新建/重命名/结束）全部委托 store，
 * 与底部终端面板共享同一份会话事实。
 *
 * - 会话形态：POST /terminals { kind: 'agent', runtime? }——后端免项目绑定创建
 *   tmux/PTY 会话，统一注入 CC_BASE_URL/CC_LOCK_TOKEN，并按请求或设置默认拉起
 *   底层运行时（claude/codex/dsh）
 * - 三形态：docked 管理页（左会话列表 + 右终端区）/ float 悬浮窗 / mini
 *   悬浮球条；visible 控制整体可见性，非 mini 的展开形态持久化，
 *   mini 单击回到上次展开形态
 * - 生命周期：运行中 / 销毁（二次确认由调用方承担）；隐藏 ≠ 销毁
 */

export type AgentTerminalMode = 'docked' | 'float' | 'mini'

/** 系统会话的 UI 视图形状（store 数据 + 兼容字段） */
export interface AgentTermSession {
  id: string
  name: string
  runtime: string
  /** 创建时预检顺取的运行时版本 --version 首行（P-20261003-134）；旧会话/
   *  豁免链无值 undefined（tooltip 空显不虚构） */
  runtimeVersion?: string
  launched: boolean
  /** 会话工作目录（worktree 归属标签/产出视图用） */
  path?: string
  /** OSC 7 实时追踪的当前目录（P-20261004-59）：归属标签跟随会话真实位置，
   *  无帧回落创建 dir（sessionWorkingDir 收口） */
  currentDir?: string
  /** 人工策展的敏感标记（P-20261003-155）：行角标展示源（store 快照同源） */
  sensitive?: boolean
  /** 创建时注入的初始指令原文（P-20261003-146）：会话行「重新发起」预填
   *  新建对话框用；无 prompt 创建/旧会话缺省（缺 key = 无记录） */
  initialPrompt?: string
  /** 会话来源（P-20261005-189）：'external' = 外部接管（关闭=解除接管），
   *  缺省 = 自建 */
  origin?: string
  /** 创建时间 ISO（P-20261023-3）：侧栏行内创建时间与「新」徽标的数据面
   *  （store 快照同源；创建响应先行兜底异步落库窗口） */
  createdAt?: string
  /** 会话名系统派生（P-20261023-3）：创建时未显式命名——命名来源身份记录，
   *  缺省 false（旧会话/显式命名） */
  derived?: boolean
  /** 恢复旗标创建（P-20261023-3）：--resume 等旗标形态 launchArgs——侧栏
   *  「接续」徽标判据，缺省 false */
  resumed?: boolean
}

// 模块级单例状态（跨组件共享：活动栏按钮、首页按钮、管理页/悬浮组件同一份）
const activeId = ref('')
const mode = ref<AgentTerminalMode>('docked')
const visible = ref(false)
const busy = ref(false)

const running = computed(() => useAssistantTaskStore().active)

// 上次展开形态（非 mini）：mini 单击展开 / open() 兜底时回到该形态
const EXPANDED_KEY = 'sc.agentTerminal.expandedMode'
const expandedMode = ref<AgentTerminalMode>('docked')
function loadExpanded(): AgentTerminalMode {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    if (raw === 'docked' || raw === 'float') return raw
  } catch { /* 环境无 localStorage 时走默认 */ }
  return 'docked'
}
function persistExpanded() {
  safeStorage.setItem(EXPANDED_KEY, expandedMode.value)
}

// ============== 打开状态持久化（刷新原样恢复） ==============
// visible/mode 是模块内存状态，刷新即丢——用户在管理页/悬浮窗刷新后everything
// 归零。持久化 {visible, mode}，启动时经 consumePendingOpenState() 由首个挂载的
// AgentTerminal 宿主消费恢复（home/project 路由各自挂一份，谁挂上谁消费）
const OPEN_STATE_KEY = 'sc.agentTerminal.openState'
let pendingOpenState: AgentTerminalMode | null = null

function persistOpenState() {
  safeStorage.setItem(OPEN_STATE_KEY, JSON.stringify({ visible: visible.value, mode: mode.value }))
}

function loadPendingOpenState() {
  try {
    const raw = localStorage.getItem(OPEN_STATE_KEY)
    if (!raw) return
    const s = JSON.parse(raw) as { visible?: boolean; mode?: AgentTerminalMode }
    if (s.visible === true && (s.mode === 'docked' || s.mode === 'float' || s.mode === 'mini')) {
      pendingOpenState = s.mode
    }
  } catch { /* 损坏即不恢复 */ }
}

/** 消费启动恢复意图（首次调用返回上次刷新前的形态，之后为 null） */
function consumePendingOpenState(): AgentTerminalMode | null {
  const v = pendingOpenState
  pendingOpenState = null
  return v
}

/** 拉取服务端会话列表（store 统一数据源），修正活动会话（含服务重启恢复） */
async function refresh(): Promise<boolean> {
  const store = useTerminalSessionsStore()
  const ok = await store.refresh()
  if (ok && !store.systemSessions.some(s => s.id === activeId.value)) {
    activeId.value = store.systemSessions[0]?.id || ''
  }
  return ok
}

/** 新建系统终端会话（runtime 空 = 设置默认/按可用性）。
 *  opts：dir（工作目录，worktree/恢复/编辑器询问场景）、name（显式会话名）、
 *  launchArgs（追加在运行时启动命令后的参数，如 --resume <id> / prompt 预填，
 *  服务端上限 500 字符）、shell（会话级 shell 覆盖 P-20261004-57，仅纯终端
 *  runtime=shell 生效，服务端对显式值做存在性校验）。name 空 = 服务端命名
 *（槽位继承用户最近的命名 / 双语序号名）——前端不再拼默认名，native 重启后
 *  重建会话时改名才能经服务端继承还原 */
async function create(
  runtime?: string,
  opts?: { dir?: string; name?: string; launchArgs?: string; shell?: string },
): Promise<AgentTermSession | null> {
  const store = useTerminalSessionsStore()
  busy.value = true
  try {
    const info = await store.createAgent(opts?.name, runtime, undefined, {
      dir: opts?.dir,
      // 条件展开：不带 launchArgs 时保持既有请求形状（未显式命名的用例断言
      // 依赖精确形状，显式 undefined 字段会改变序列化语义）
      ...(opts?.launchArgs ? { launchArgs: opts.launchArgs } : {}),
      ...(opts?.shell ? { shell: opts.shell } : {}),
    })
    if (!info) return null
    activeId.value = info.id
    return { id: info.id, name: info.name, runtime: info.runtime ?? '', runtimeVersion: info.runtimeVersion, launched: !!info.runtime, createdAt: info.createdAt, derived: info.derived, resumed: info.resumed }
  } finally {
    busy.value = false
  }
}

/** 接管外部 tmux 会话（P-20261005-189）：选择即接管（服务器遗留 tmux 会话
 *  进本管理页渲染）。attached > 0 由调用方提示多端同屏 */
async function attachExternal(tmuxName: string, name?: string): Promise<AgentTermSession | null> {
  const store = useTerminalSessionsStore()
  busy.value = true
  try {
    const info = await store.attachExternal(tmuxName, name)
    if (!info) return null
    activeId.value = info.id
    return { id: info.id, name: info.name, runtime: '', launched: true, path: info.path, origin: info.origin }
  } finally {
    busy.value = false
  }
}

/** 显式终结外部接管会话（kill-session，二次确认由调用方承担） */
async function killExternal(id: string): Promise<void> {
  await useTerminalSessionsStore().killExternal(id)
  if (activeId.value === id) {
    activeId.value = useTerminalSessionsStore().systemSessions[0]?.id || ''
  }
}

async function rename(id: string, name: string): Promise<void> {
  await useTerminalSessionsStore().rename(id, name)
}

/** 结束会话（tmux kill-session / PTY 终止，智能体进程随之结束）并从列表移除 */
async function destroy(id: string): Promise<void> {
  await useTerminalSessionsStore().destroy(id)
  if (activeId.value === id) {
    activeId.value = useTerminalSessionsStore().systemSessions[0]?.id || ''
  }
}

/** 底层会话退出（shell 死亡）后的本地清理：服务端已不存在，无需调 API */
function removeLocal(id: string): void {
  useTerminalSessionsStore().markExited(id)
  if (activeId.value === id) {
    activeId.value = useTerminalSessionsStore().systemSessions[0]?.id || ''
  }
}

/** 确保会话列表最新（保留兼容入口）：float/mini 不再自动建会话——悬浮形态
 *  缺会话时由 View 空态引导「新建会话」，避免静默多出一个未分组会话 */
async function ensureOne(): Promise<boolean> {
  const store = useTerminalSessionsStore()
  if (store.systemSessions.length > 0) return true
  return refresh()
}

/** 打开（无参 = 保持当前形态，mini 时回到上次展开形态；首次默认 docked） */
async function open(next?: AgentTerminalMode) {
  if (next) {
    mode.value = next
  } else if (mode.value === 'mini') {
    mode.value = loadExpanded()
  }
  visible.value = true
  // 主区互斥：docked 管理页打开时关闭远程控制台/分享管理/dsh 控制台视图
  if (mode.value === 'docked') closeMainViews()
  // 后台刷新一次列表对账：清理服务端已消亡的会话（native shell 退出不经 API，
  // 旧实现仅 docked/空列表时刷新，悬浮形态会长期显示幽灵会话）
  void refresh()
}

/** 隐藏（会话保活，可随时再次打开） */
function hide() {
  visible.value = false
}

/** 仅隐藏 docked 管理页（主区视图切换用）——悬浮窗/悬浮条是全局悬浮层，不受影响 */
function hideDocked() {
  if (mode.value === 'docked') visible.value = false
}

/** 收起为悬浮球/条（记录当前展开形态供恢复）；
 *  同步归还项目接管 pane（被接管会话的渲染权归还底部面板） */
function collapse() {
  if (mode.value !== 'mini') {
    expandedMode.value = mode.value
    persistExpanded()
  }
  useTerminalSessionsStore().returnAllToPanel()
  mode.value = 'mini'
  visible.value = true
}

/** 切换形态（float/docked 记为展开形态） */
async function setMode(next: AgentTerminalMode) {
  if (next !== 'mini') {
    expandedMode.value = next
    persistExpanded()
  }
  mode.value = next
  visible.value = true
  if (next === 'docked') closeMainViews()
}

/** 主区互斥：docked 管理页打开时关闭远程控制台/分享管理/dsh 控制台/项目仪表盘/
 *  笔记独立视图（P-20261108-2；首页 overlay 同为本链收起——笔记开态与首页宿主
 *  共用 usePanelLayout 单例）。usePanelLayout 无法反向引用本模块——方向在其侧经
 *  AgentTerminal 组件的 watch 兜底 */
function closeMainViews() {
  const layout = usePanelLayout()
  layout.showRemoteConsole.value = false
  layout.showShareManager.value = false
  layout.closeDshConsole()
  layout.closeDashboard()
  layout.closeNotesView()
}

/** 活动栏语义：docked 打开中再点 = 收起；否则以 docked 打开 */
function toggleDocked() {
  // 最大化态（终端最大化/底部全屏/编辑器区最大化）会盖住 docked 管理页：
  // 先还原布局再切换（点啥显示啥）
  usePanelLayout().restoreFromMaximized()
  if (visible.value && mode.value === 'docked') hide()
  else void open('docked')
}

// ============== 悬浮形态跳转语义（球/条/悬浮列表与管理页共用） ==============
/** 跳转项目视图并激活指定会话：归还该项目被接管会话 → 切项目 → 底部终端
 *  tab 激活（pendingSwitch 跨页生效）→ 收起本组件。
 *  router 由调用方在 setup 期捕获后传入（inject 不能在事件回调中调用） */
async function jumpToProjectSession(projectId: string, sessionId: string | undefined, router: Router) {
  const sessionsStore = useTerminalSessionsStore()
  for (const s of sessionsStore.projectSessions) {
    if (s.projectId === projectId && sessionsStore.managerAttached.has(s.id)) {
      sessionsStore.returnToPanel(s.id)
    }
  }
  // 切换守卫取消（未保存草稿确认选「取消」，P-20261003-105）→ 放弃跳转
  if ((await useProjectStore().selectProjectExplicit(projectId)) === false) return
  if (sessionId) useTerminalStore().requestSwitch(sessionId)
  const layout = usePanelLayout()
  layout.showBottomPanel.value = true
  layout.bottomTab.value = 'terminal'
  if (router.currentRoute.value.name !== 'project') await router.push({ name: 'project' })
  hide()
}

/** 悬浮形态点系统会话：展开为悬浮窗并激活该会话 */
async function jumpToAgentSession(id: string) {
  activeId.value = id
  await setMode('float')
}

// 打开状态持久化观察：visible/mode 任一变化即落盘；模块加载时读取上次状态
// 形成启动恢复意图（consumePendingOpenState 由 AgentTerminal 宿主挂载时消费）
watch([visible, mode], persistOpenState)
loadPendingOpenState()

/** 仅供测试使用：重置模块级状态与会话 store */
export function resetAgentTerminalStateForTest() {
  activeId.value = ''
  mode.value = 'docked'
  visible.value = false
  busy.value = false
  expandedMode.value = 'docked'
  pendingOpenState = null
  activateIntent.value = ''
  try { localStorage.removeItem(EXPANDED_KEY) } catch { /* ignore */ }
  try { localStorage.removeItem(OPEN_STATE_KEY) } catch { /* ignore */ }
  projectDockedMem.clear()
  // 项目切换 watch 重绑当前 active pinia（vitest setup 每用例换 pinia 实例，
  // 安装期闭包的 store 会被孤立；应用运行期本行不执行，watch 终身有效）
  if (navLayoutMemoryInstalled) watchProjectSwitch()
  useTerminalSessionsStore().resetForTest()
}

// 多实例总览「去操作」agent 意图的模块级消费（一次性安装）：
// AgentTerminalView 是惰性挂载（v-if everDocked），意图到达时 View 可能不存在，
// 由本 watcher（永活）负责 activeId + 打开 docked 使其挂载；touch/selectedId/
// 清除意图由 View 挂载后的 watcher 完成（意图不清除，View immediate 才看得到）
let sessionJumpWatchInstalled = false
function installSessionJumpWatcher(): void {
  if (sessionJumpWatchInstalled) return
  sessionJumpWatchInstalled = true
  const instanceStore = useInstanceStore()
  // detached scope：watcher 不随首次调用的组件卸载而销毁（该组件可能只是
  // 顺路调用 useAgentTerminal 的短命组件，卸载会让意图消费静默失效）
  effectScope(true).run(() => {
    watch(() => instanceStore.pendingSessionJump, (j) => {
      if (!j || j.kind !== 'agent' || j.instanceId !== instanceStore.currentInstanceId) return
      activeId.value = j.sessionId
      void open('docked')
    })
  })
}

// ============== OPS_ACTIVATE_TERMINAL 消费（agent 形态对齐底部终端） ==============
// 审批卡「查看发起会话」等入口广播激活指定终端会话：项目会话 tab 由底部
// TerminalView 消费；归属本形态的两类在此接管——系统会话 + 已被管理页接管的
// 项目会话（渲染权在管理页，底部面板只是挂起占位）。广播到达时本 View 可能
// 尚未挂载（宿主 v-if），选中对齐经 activateIntent 由 View 消费（同
// pendingSessionJump 模式），模块侧负责 activeId 与面板展开（mini 回上次展开
// 形态）；会话列表未拉取过时先对账再判定归属（审批卡可能先于列表加载出现）
const activateIntent = ref('')
async function onOpsActivateTerminal(e: Event): Promise<void> {
  const id = (e as CustomEvent<{ id?: string }>).detail?.id
  if (!id) return
  const store = useTerminalSessionsStore()
  if (!store.loaded) await store.refresh()
  if (!store.systemSessions.some(s => s.id === id) && !store.managerAttached.has(id)) return
  activateIntent.value = id
  activeId.value = id
  void open()
}
let opsActivateInstalled = false
function installOpsActivateListener(): void {
  if (opsActivateInstalled) return
  opsActivateInstalled = true
  window.addEventListener(OPS_ACTIVATE_TERMINAL, (e: Event) => { void onOpsActivateTerminal(e) })
}
/** View 侧消费激活意图（一次性）：选中对齐完成后调用清账 */
function consumeActivateIntent(): void {
  activateIntent.value = ''
}

// ============== 导航语义：回首页=纯首页，进项目恢复此前布局（P-20261107-3） ==============
// visible/mode 是本模块级状态（跨路由存活），首页 overlay 与项目内嵌双宿主吃同一
// 份——「项目内开着管理页点回首页」会把开态带进首页（导航动作没有区分「用户主动
// 开」与「路由切换路过」）。两条导航语义在 useAgentTerminal 首次调用时一次性安装：
// ①路由切到首页 = 路过收起：hideDocked() 只关 docked 管理页；float/mini 是全局
//   悬浮层跟随导航（既有行为不动）；用户在首页仍可点工具条图标主动开（open()）。
// ②进项目 = 恢复该项目此前布局：uiState.layout 是实例级单份（切项目即被新快照
//   整体覆盖）、工作区 snapshots 是手动存档——per-项目 docked 开合没有既有持久
//   化，这里自建会话级记忆（页内存，刷新即丢；跨刷新恢复仍走 OPEN_STATE_KEY
//   全局 boot 语义，二者互补不冲突）。有记忆才恢复（无记忆=本会话首次进入，
//   沿用现状自然流入，不强改）；记忆为关时也恢复关（TopBar 切项目不再把上一
//   个项目的开态带过去）。
const projectDockedMem = new Map<string, boolean>()
// 键=项目 id、值=单布尔，页生命周期内自然有界；上限仅防极端会话无界增长
const PROJECT_DOCKED_MEM_MAX = 200

function captureProjectDocked(projectId: string): void {
  if (!projectId) return
  projectDockedMem.set(projectId, visible.value && mode.value === 'docked')
  if (projectDockedMem.size > PROJECT_DOCKED_MEM_MAX) {
    const oldest = projectDockedMem.keys().next().value
    if (oldest !== undefined) projectDockedMem.delete(oldest)
  }
}

function restoreProjectDocked(projectId: string): void {
  const mem = projectId ? projectDockedMem.get(projectId) : undefined
  if (mem === undefined) return
  if (mem) {
    // float/mini 是用户当前活跃意图且全局跟随导航（既有行为）——不降级打断
    if (visible.value && mode.value !== 'docked') return
    void open('docked')
  } else {
    hideDocked()
  }
}

let navLayoutMemoryInstalled = false
// 项目切换 watch 的停止句柄：resetAgentTerminalStateForTest 重绑用（vitest 每用例
// setActivePinia(createPinia())，安装期闭包的 store 实例会被孤立——应用运行期
// pinia 终身单例不存在此问题，重绑仅为单测等价性）
let stopProjectSwitchWatch: (() => void) | null = null

/** 订阅项目切换（TopBar 选择器/实例 smart-stay 同路由换 id）：在项目路由内换
 *  项目 = 离旧项目采集 + 进新项目恢复。首页 enterProject 先改 id 再 push——
 *  此刻不采集（旧项目的布局早在离项目路由时已采集，此刻模块态已收起，误采集
 *  会用「关闭态」覆盖真实记忆），恢复交给 afterEach */
function watchProjectSwitch(): void {
  stopProjectSwitchWatch?.()
  stopProjectSwitchWatch = effectScope(true).run(() => {
    const projectStore = useProjectStore()
    return watch(() => projectStore.currentProjectId, (next, prev) => {
      if (next === prev) return
      if (router.currentRoute.value.name !== 'project') return
      captureProjectDocked(prev)
      restoreProjectDocked(next)
    })
  }) ?? null
}

function installNavLayoutMemory(): void {
  if (navLayoutMemoryInstalled) return
  // 全局 setup 把 vue-router 整体 mock（业务单测不触路由惯例）——router 为 undefined
  // 的环境跳过安装：导航语义不参与纯状态单测，需要它的用例文件级还原真实现
  // （本文件 useAgentTerminal.test.ts / __tests__/utils/presentAtoms.test.ts 同款）
  if (!router || typeof router.afterEach !== 'function') return
  navLayoutMemoryInstalled = true
  watchProjectSwitch()
  // boot 首导航（from=null）在安装点之前后到皆可：Map 必空、模块态未恢复，
  // 采集/恢复/收起均为无操作，boot 恢复仍由 consumePendingOpenState 承担
  router.afterEach((to, from) => {
    const projectId = useProjectStore().currentProjectId
    // 离项目路由：先采集后收起（顺序不可换）
    if (from.name === 'project' && to.name !== 'project') captureProjectDocked(projectId)
    if (to.name === 'home') hideDocked()
    if (to.name === 'project' && from.name !== null && from.name !== 'project') restoreProjectDocked(projectId)
  })
}

export function useAgentTerminal() {
  const store = useTerminalSessionsStore()
  installSessionJumpWatcher()
  installOpsActivateListener()
  installNavLayoutMemory()
  // 系统会话视图（兼容旧 AgentTermSession 形状；launched 仅建会话响应时有意义）
  const sessions = computed<AgentTermSession[]>(() =>
    store.systemSessions.map(s => ({ id: s.id, name: s.name, runtime: s.runtime || '', runtimeVersion: s.runtimeVersion, launched: true, path: s.path || '', currentDir: s.currentDir, sensitive: s.sensitive, initialPrompt: s.initialPrompt, origin: s.origin, createdAt: s.createdAt, derived: s.derived, resumed: s.resumed })),
  )
  return {
    sessions, activeId, mode, visible, busy, running, expandedMode,
    refresh, create, attachExternal, rename, destroy, killExternal, removeLocal, ensureOne,
    open, hide, hideDocked, collapse, setMode, toggleDocked,
    jumpToProjectSession, jumpToAgentSession,
    activateIntent, consumeActivateIntent,
    consumePendingOpenState,
  }
}
