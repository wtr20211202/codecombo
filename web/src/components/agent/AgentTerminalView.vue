<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import AgentTerminalSidebar from './AgentTerminalSidebar.vue'
import AgentTerminalHeader from './AgentTerminalHeader.vue'
import AgentTerminalFloatTabs from './AgentTerminalFloatTabs.vue'
import AgentTerminalPanes from './AgentTerminalPanes.vue'
import { useI18n } from '../../composables/useI18n'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { useDirectInputShares } from '../../composables/useDirectInputShares'
// 终端能力四件（直播/冻结/回放/导出）+ 直播徽标投影：与底部终端 tab 右键共用
// 件（P-20261106-7 双入口纪律——动作链与徽标数据面单一实现，本页只做接线）
import { useTerminalShareActions } from '../../composables/useTerminalShareActions'
import { useAgentTerminalFloat } from '../../composables/useAgentTerminalFloat'
import { useAgentTerminalSidebarWidth } from '../../composables/useAgentTerminalSidebarWidth'
import { useAgentTerminalGroups, buildDestroyConfirmContent } from '../../composables/useAgentTerminalGroups'
import { useAgentTerminalSelection } from '../../composables/useAgentTerminalSelection'
import { useTerminalTreeLocate } from '../../composables/useTerminalTreeLocate'
import { consumeDispatchRequest, dispatchOpenRequest } from '../../composables/useInstanceDispatch'
import { consumeTemplateDialogRequest, templateDialogRequest } from '../../composables/useAgentTemplateLaunch'
// 编辑器选区 Alt+拖拽落点（P-20261003-162）：协议/文本拼装在 utils/selectionDrag
import { buildSelectionDragText, SELECTION_DRAG_DROP_EVENT, type EditorSelectionDragPayload } from '../../utils/selectionDrag'
import { copyText } from '../../utils/clipboard'
// 选区内联 AI 编辑「无活跃会话」引导（P-20261005-206）：指令预填新建对话框
import { consumeInlineEditDialogRequest, inlineEditDialogRequest } from '../../composables/useInlineEditGuide'
import NewSessionDialog from './NewSessionDialog.vue'
import CrossReviewDialog from './CrossReviewDialog.vue'
import { openCrossReview } from '../../composables/useCrossReview'
import ChainContinueDialog from './ChainContinueDialog.vue'
import { openChainContinue, openAgentChains } from '../../composables/useAgentChain'
import { openCompareExperiment } from '../../composables/useCompareExperiment'
import { useLockStore } from '../../stores/lock'
import { useApprovalsStore } from '../../stores/approvals'
import { shareApi } from '../../api/domains/share'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useInstanceStore } from '../../stores/instance'
import { useProjectStore } from '../../stores/project'
import { usePostmortemStore } from '../../stores/postmortem'
import { confirmDialog } from '../../composables/useDialog'

/**
 * 全局终端 docked 管理页（默认打开形态）：左侧多会话（可分组）+ 右侧终端区。
 * - 会话本体在服务端终端管理器（tmux 常驻）；分组/侧栏折叠持久化在 uiState
 * - 终端区多会话 keep-alive：切会话保留 xterm 现场；TerminalPane 挂载即连接，
 *   会话切换/形态切换重连由 scrollback 重放补齐现场
 * - 终端能力与项目终端同层：右键菜单（复制/粘贴/清屏/导出）+ 图片粘贴上传，
 *   空状态引导说明可直接操作本系统
 *
 * 区块拆分（P-20261001-20）：头部 chrome（AgentTerminalHeader）/ 悬浮窗 tab 条
 * （AgentTerminalFloatTabs）/ 右侧终端区与右键菜单（AgentTerminalPanes）为子组件，
 * 悬浮窗几何 / 侧栏拖宽 / 选中模型 / 侧栏数据模型在
 * useAgentTerminal{Float,SidebarWidth,Selection,Groups} 组合式；本文件持有装配
 * 与形态编排。
 */
defineProps<{
  /** 独立模式（首页全屏 overlay）：头部显示关闭按钮 */
  standalone?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()
const message = useMessage()
const lockStore = useLockStore()
const sessionsStore = useTerminalSessionsStore()
const projectStore = useProjectStore()
// tab × 结束会话确认的 pending 审批警示源（P-20261003-275）：pendingSessionIds
// 与终端会话 id 同域（P-198 静默标同款归属判定）
const approvalsStore = useApprovalsStore()

// 终端根区吞掉浏览器原生右键菜单：pane 内由 TerminalPaneContextMenu 打开自家菜单；
// pane 外缝隙（侧栏/头部/tab 条附近）漏出系统菜单会造成「双菜单」观感
function suppressNativeMenu(e: Event): void {
  e.preventDefault()
}

// ============== 归还语义：本页不可见（关闭/收球/切悬浮窗）时全量归还 ==============
// 注意：必须在下方 useAgentTerminal() 解构之后注册可见性相关 watch——getter 在
// 注册时立即求值，若引用未初始化的 visible 会抛 TDZ（被 Vue 吞成 console error，
// watcher 静默失效 = 归还语义从未生效）
onBeforeUnmount(() => {
  sessionsStore.returnAllToPanel()
})

const {
  sessions, activeId, running,
  refresh, rename, destroy, killExternal, removeLocal, setMode, collapse, hide, visible, mode, open,
  activateIntent, consumeActivateIntent,
} = useAgentTerminal()

// 右侧终端区（AgentTerminalPanes）：refit 由选中模型/拖宽回调经其暴露方法驱动
const panesRef = ref<InstanceType<typeof AgentTerminalPanes> | null>(null)

// ============== 选中模型（useAgentTerminalSelection） ==============
const {
  selectedId, lastViewedSessionId,
  selectedProjectSession, attachedProjectSessions, mountedAgentSessions, displaySessions,
  touch, selectAgent, attachProject, ensureDockedSelection,
} = useAgentTerminalSelection({
  sessions,
  activeId,
  visible,
  mode,
  sessionsStore,
  getPanes: () => panesRef.value,
})

// ============== 多实例总览「去操作」意图消费（agent 会话） ==============
// setSessionJump 后到达（本实例挂载时 immediate / 之后变化时）：保证管理页
// docked 可见并选中该会话。instanceId 必检——意图设置时旧实例树仍在，
// 只有与本实例匹配的意图才能消费
const instanceStoreForJump = useInstanceStore()
watch(() => instanceStoreForJump.pendingSessionJump, (j) => {
  if (!j || j.kind !== 'agent' || j.instanceId !== instanceStoreForJump.currentInstanceId) return
  instanceStoreForJump.consumeSessionJump()
  touch(j.sessionId)
  selectedId.value = j.sessionId
  activeId.value = j.sessionId
  void open('docked')
}, { immediate: true })

// ============== OPS_ACTIVATE_TERMINAL 激活意图消费（审批卡「查看发起会话」等） ==============
// 归属判定 / activeId / 面板展开由 useAgentTerminal 模块级监听器完成；本 View 惰性
// 挂载（宿主 v-if），意图可能先于挂载到达——immediate 消费积压意图，之后随变化
// 消费。选中对齐 pendingSessionJump 同款三连（touch/selectedId/activeId）：系统
// 会话与被接管项目会话都直接置选中（后者 keep-alive 已渲染，置选中即切 pane）
watch(activateIntent, (id) => {
  if (!id) return
  consumeActivateIntent()
  if (!sessions.value.some(s => s.id === id) && !sessionsStore.managerAttached.has(id)) return
  touch(id)
  selectedId.value = id
  activeId.value = id
}, { immediate: true })

// ============== 悬浮窗形态（P4 打磨：View 即窗口，零闪保活） ==============
// mode==='float' 时容器变形为悬浮窗：几何/拖拽/缩放自 sc.agentTerminal.* 持久化
// （与旧 AgentTerminalFloat 同键，无缝迁移）；DOM 零移动 → 零重放零闪
const isFloat = computed(() => mode.value === 'float')
const { floatPos, floatSize, loadFloatGeometry, onHeaderPointerDown, onFloatResizeDown, dispose: disposeFloat } =
  useAgentTerminalFloat({ isFloat })

// ============== docked 侧栏宽度拖拽（1.5）：160-480px，localStorage 持久化 ==============
const { sidebarWidth, sideResizing, loadSidebarWidth, onSidebarResizeDown, dispose: disposeSidebarWidth } =
  useAgentTerminalSidebarWidth({
    onResizeEnd: () => {
      // 拖拽结束 refit 选中的 pane（宽度变化后 xterm 列数补齐）
      const pid = selectedProjectSession.value?.id || activeId.value
      void nextTick(() => panesRef.value?.fitFor(pid))
    },
  })

// tab × 结束会话（确认弹窗；单会话场景由空态/管理页承接）。
// close 语义分流（P-20261005-189）：外部接管会话的「结束」=解除接管——
// 本系统放手，tmux 会话与其中进程原样存活（文案随之区分，诚实告知；
// 解除接管后裁决仍可送达，不附 pending 警示，真实 destroy 才附——P-20261003-275）
async function onDestroySession(id: string) {
  const s = sessions.value.find(ss => ss.id === id)
  if (!s) return
  const external = s.origin === 'external'
  const ok = await confirmDialog({
    title: external ? t('agentTerminal.external.releaseTitle') : t('agentTerminal.destroy'),
    content: external
      ? t('agentTerminal.external.releaseConfirm', { name: s.name })
      : buildDestroyConfirmContent(t, approvalsStore.pendingSessionIds.has(s.id), s.name),
    type: 'warning',
  })
  if (!ok) return
  await destroy(id)
}

onMounted(loadFloatGeometry)
onMounted(loadSidebarWidth)
onBeforeUnmount(() => {
  disposeFloat()
  disposeSidebarWidth()
})

// ============== 侧栏列表页签与悬浮窗 tab 条 ==============
/** 侧栏列表页签：终端会话 / Claude 会话（P5） */
const managerListTab = ref<'terminals' | 'claude'>('terminals')

/** 会话创建时间面（id → createdAt ISO，P-20261003-174）：侧栏时间 chips 的
 *  兜底时间基点——activityMap 只由已连接宿主的输出事件写入，刷新后为空，
 *  纯活动判定会把今天创建的会话也清出「今天」窗口（侧栏 hitTime 注记同源） */
const createdMapBySessionId = computed(() => {
  const out: Record<string, string> = {}
  for (const s of sessionsStore.sessions) out[s.id] = s.createdAt
  return out
})

/** 悬浮窗 tab 列表：系统会话 + 全部被接管的项目会话（多挂接模型下挂接数
 *  可超过一个——旧实现只列选中的一个，其余挂接会话在悬浮窗里既切不过去
 *  也无法从 tab 条归还） */
const floatTabs = computed(() => {
  const list: { id: string; name: string; kind: 'agent' | 'project' }[] =
    sessions.value.map(s => ({ id: s.id, name: s.name, kind: 'agent' as const }))
  for (const ps of attachedProjectSessions.value) {
    list.push({ id: ps.id, name: ps.name, kind: 'project' as const })
  }
  return list
})
/** 会话总数 = 系统会话 + 全部项目会话（与左侧树行数一致）。统计口径是「本页
 *  管理的会话清单」，接管/归还只改变会话渲染在管理页还是项目底部面板，不新建
 *  也不销毁，不应引起计数跳动；谁被接管由行内「管理页」徽章逐行表达。
 *  悬浮窗 tab 条走 floatTabs（只列系统 + 被接管，悬浮窗里只渲染这些 pane），
 *  与本计数口径不同，勿合并 */
const sessionCount = computed(() => sessions.value.length + sessionsStore.projectSessions.length)
/** 悬浮窗 tab 激活键：被接管的项目会话优先（与 pane 渲染选中同口径） */
const floatActiveKey = computed(() => selectedProjectSession.value?.id ?? activeId.value)

// ============== 后台 tab 未读活动点：本页可见会话登记（P-20261003-310） ==============
// docked/float 双形态同 View：floatActiveKey 即当前渲染的 pane（输出不点亮
// 未读）；本页隐藏（收球 mini / 关闭 overlay）时全部会话视作后台。登记变化
// 即清除该会话未读（侧栏点选/悬浮 tab 切换/跳转全走 selectedId/activeId）
const managerVisible = computed(() => visible.value && mode.value !== 'mini')
watch(
  () => [managerVisible.value, floatActiveKey.value] as const,
  ([vis, id]) => sessionsStore.setHostVisible('agentManager', vis && id ? [id] : []),
  { immediate: true },
)
onBeforeUnmount(() => sessionsStore.setHostVisible('agentManager', []))

// 用户最近激活会话信标（P-20261004-52）：ui.snapshot 现场上报消费——本页
// 可见（docked/float 非 mini）时当前渲染的 pane 即用户正看的会话；隐藏不写
//（底部项目终端的最后激活值保持有效，两宿主最后激活者胜）
watch(
  () => (managerVisible.value && floatActiveKey.value) || '',
  (id) => { if (id) sessionsStore.setActiveSession(id) },
  { immediate: true },
)

/** 悬浮窗 tab 点击：系统会话 → selectAgent；项目会话 → 仅切换渲染选中 */
function onFloatTabClick(tab: { id: string; kind: 'agent' | 'project' }) {
  if (tab.kind === 'agent') selectAgent(tab.id)
  else {
    selectedId.value = tab.id
    lastViewedSessionId.value = tab.id
  }
}
/** 悬浮窗 tab ×：系统会话销毁；项目会话归还底部面板（取回语义，不销毁） */
async function onFloatTabClose(tab: { id: string; kind: 'agent' | 'project' }) {
  if (tab.kind === 'agent') {
    await onDestroySession(tab.id)
  } else {
    sessionsStore.returnToPanel(tab.id)
    if (selectedId.value === tab.id) selectedId.value = ''
  }
}

// ============== 会话行「在文件树中定位」（P-20261002-125，复用 P-32 解析层） ==============
// 管理页全量会话清单（agent 免项目绑定 projectId='' + 项目会话带归属）喂给
// 解析层：dir 在当前项目内的会话行可定位（右键菜单/悬浮 tab 按钮逐行派发
// OPS_LOCATE_IN_TREE，由 FileTreeView 开面板展开定位），项目外无解析值 →
// 菜单项置灰 / 按钮不渲染。首页独立模式无当前项目，同样无解析值自然全灰
const locateTabs = computed(() => sessionsStore.sessions.map(s => ({ id: s.id, projectId: s.projectId })))
const { dirByTabId: dirBySessionId, locateTab: locateSessionInTree } = useTerminalTreeLocate({
  tabs: locateTabs,
  activeTabId: selectedId,
})

// ============== 侧栏数据模型（分组/项目分组/持久化/动作，useAgentTerminalGroups） ==============
const {
  groups, booting, sidebarCollapsed,
  collapsedProjects, projectGroups,
  boot,
  onToggleProject, onReorderProjectGroups, onReorderProjectSessions,
  openProject, projectCreateOptions, onCreateProjectSelect,
  onProjectAction, onProjectSessionDestroy: onGroupsProjectSessionDestroy,
  onSessionAction, onGroupAction,
  onReorderGroups, onReorderGroupSessions, onMoveSessionByDrag, onBatchMove, onBatchDestroy,
} = useAgentTerminalGroups({
  sessions,
  selectedId,
  lastViewedSessionId,
  sessionsStore,
  projectStore,
  rename,
  destroy,
  kill: killExternal,
  attachProject,
  getSelectedProjectSession: () => selectedProjectSession.value,
  hide,
  afterRestore: async () => {
    await refresh()
    ensureDockedSelection()
  },
})

// 锁定态挂载时请求 423 失败：解锁后重拉
watch(() => lockStore.isLocked, (nv, ov) => {
  if (ov && !nv) void boot()
})

onMounted(boot)

/** 项目会话右键动作路由：locate-tree（在文件树中定位）本地派发，其余（结束
 *  会话确认）交还分组模型 */
function onProjectSessionAction(payload: { sessionId: string; key: 'destroy' } | { sessionId: string; key: 'locate-tree' }) {
  if (payload.key === 'locate-tree') {
    locateSessionInTree(payload.sessionId)
    return
  }
  void onGroupsProjectSessionDestroy(payload)
}

// ============== 交叉审查（P-20261003-6）：会话行入口 → 弹层选目标 runtime ==============
// 源会话在宿主解析（侧栏行只有 id）；弹层实例挂本页一份（产出面板入口直接调
// 模块级 openCrossReview，同一份单例状态）
function onCrossReview(sessionId: string) {
  const s = sessions.value.find(ss => ss.id === sessionId)
  if (!s) return
  openCrossReview({ id: s.id, name: s.name, runtime: s.runtime || '', dir: s.path || undefined })
}

// ============== 完成后接续（P-20261004-38）：会话行入口 → 链定义弹层 ==============
// 源会话在宿主解析（同 cross-review）；弹层实例挂本页一份（模块级
// openChainContinue 同一份单例状态，他页入口共享）
function onChainContinue(sessionId: string) {
  const s = sessions.value.find(ss => ss.id === sessionId)
  if (!s) return
  openChainContinue({ id: s.id, name: s.name, runtime: s.runtime || '', dir: s.path || undefined })
}

// ============== 标记审阅基线（P-20261003-217）：会话行入口 → 记当前时点 ==============
// 长会话阶段性审阅——本轮改动审完打标记，产出视图可切换 diff 范围到任一标记；
// 失败 toast 由拦截器统一弹，这里只反馈成功
async function onReviewMark(sessionId: string) {
  await sessionsStore.markReviewBaseline(sessionId)
  message.success(t('agentTerminal.markBaselineDone'))
}

// ============== 敏感标记（P-20261003-155）：会话行入口 → 切换标记 ==============
// 人工策展的安全标注（调试时贴过凭据的会话），导出/分享出域命中时服务端拦
// 第一跳弹「确认出域」；失败 toast 由拦截器统一弹，这里只反馈成功
async function onToggleSensitive(sessionId: string) {
  const next = !(sessions.value.find(s => s.id === sessionId)?.sensitive === true)
  await sessionsStore.setSensitive(sessionId, next)
  message.success(t(next ? 'terminal.markSensitiveDone' : 'terminal.unmarkSensitiveDone'))
}

// ============== 直通输入持权（P-20261024-1）：会话行橙点徽标 + 右键收回 ==============
// 数据面在 useDirectInputShares（15s 惰性轮询 + 批准/收回点即时 bump）；这里
// 只做投影与动作：直通 v1 限定 agent 会话，owner 侧「谁在输入」的常驻可见位
// 就是本管理页的会话行（项目终端 tab 不挂——shell 会话不可直通）
const directInputsApi = useDirectInputShares()
onMounted(directInputsApi.start)
onBeforeUnmount(directInputsApi.stop)
/** 会话行徽标/右键收回的数据投影：sessionId → {nick, visitorTail}（有效期
 *  过滤在数据面已做，这里只剥展示字段） */
const directHolds = computed(() => {
  const src = directInputsApi.holdBySession.value
  if (!Object.keys(src).length) return undefined
  const out: Record<string, { nick?: string; visitorTail?: string }> = {}
  for (const id of Object.keys(src)) {
    out[id] = { nick: src[id]!.nick, visitorTail: src[id]!.visitorTail }
  }
  return out
})
/** 一键收回访客直通输入权（四路回收入口的会话侧）：token 键收回即解除会话
 *  只读闸（owner 键盘即时归还）；bump 即时对账摘徽标。P-20261106-8 起同表
 *  混入可写上行条目（writable 标记）——收回方向分流为 setWritable off
 *  （断上行连接，语义等价「主人关掉可写」） */
async function onDirectRevoke(sessionId: string) {
  const hold = directInputsApi.holdBySession.value[sessionId]
  if (!hold) return
  try {
    if (hold.writable) {
      await shareApi.setWritable(hold.token, false)
    } else {
      await shareApi.revokeDirect(hold.token)
    }
    message.success(t('terminal.revokeDirectInputDone'))
  } catch { /* 拦截器已 toast */ } finally {
    directInputsApi.bump()
  }
}

// ============== 终端能力四件 + 直播徽标（P-20261106-7 双入口纪律） ==============
// 底部终端 tab 右键的直播分享/冻结分享/分享回放/导出输出 + 直播红点徽标，在本
// 管理页的会话树行（系统会话 + 项目会话）同款落地——agent/tmux 持久会话的宿主
// 就是本页，此前四项能力在其主入口缺席。动作链与徽标数据面均收口
// useTerminalShareActions（单实现）：直播按锚点态分流创建/撤销；导出走服务端
// 会话层 CaptureScrollback 链（tmux capture-pane / native 环形缓冲），detached
// 会话无视图缓冲同样可导出、两入口导出内容一致；徽标沿用 useTerminalLiveShares
// 30s 惰性轮询 + 变更点 bump（引用计数——底部终端 tab 卸载不掐本页轮询）。
// 【横向纪律】终端会话级能力新增必须两入口（tab 右键 + 本页行右键）同步接线
const shareActions = useTerminalShareActions()
const liveTitles = shareActions.liveTitles
onMounted(shareActions.start)
onBeforeUnmount(shareActions.stop)
/** 会话树行能力四件派发：系统会话查 sessions、项目会话查统一 store（两树
 *  会话集不相交，先后查找即覆盖全量）；名用于导出下载名/出域警示文案 */
function onCapabilityAction(payload: { sessionId: string; key: 'liveShare' | 'frozenShare' | 'replayShare' | 'exportOutput' }) {
  const s = sessions.value.find(ss => ss.id === payload.sessionId)
    || sessionsStore.projectSessions.find(ss => ss.id === payload.sessionId)
  if (!s) return
  const target = { id: s.id, name: s.name }
  if (payload.key === 'liveShare') void shareActions.toggleLiveShare(target)
  else if (payload.key === 'frozenShare') shareActions.createFrozenShare(target.id)
  else if (payload.key === 'replayShare') void shareActions.shareReplay(target.id)
  else void shareActions.exportOutput(target)
}

// ============== 新建会话对话框（B1：主入口，替代旧 runtime 下拉） ==============
// 运行时/会话名/工作目录/启动命令在对话框内选择；入口可预填 dir（worktree 场景）
// 与 prompt（重新发起场景，P-20261003-146）
const showNewDialog = ref(false)
const dialogPrefill = ref<{ dir?: string; runtime?: string; instanceId?: string; prompt?: string; templateId?: string }>({})
function openNewDialog(prefill?: { dir?: string; runtime?: string; instanceId?: string; prompt?: string; templateId?: string }) {
  dialogPrefill.value = prefill || {}
  showNewDialog.value = true
}

// ============== 命令面板「按模板新建会话」降级出口消费（P-20261005-10） ==============
// 模板占位符上下文缺失时执行链不经创建、改开对话框预填该模板（P-16「原样
// 保留+提示」交对话框既有面呈现）。本 View 惰性挂载（宿主 v-if），请求可能
// 先于挂载到达——immediate 消费积压请求，之后随变化消费；跨 remount 幂等由
// consumeTemplateDialogRequest 的模块级消费进度保证（dispatchOpenRequest 同款）。
// 注册位必须在 openNewDialog/dialogPrefill 声明之后：immediate 回调在挂载期
// 同步执行，有积压请求时会当场调用 openNewDialog 写 dialogPrefill
watch(templateDialogRequest, () => {
  const tid = consumeTemplateDialogRequest()
  if (tid !== null) openNewDialog({ templateId: tid })
}, { immediate: true })

// ============== 选区内联 AI 编辑「无活跃会话」引导消费（P-20261005-206） ==============
// 编辑器浮层发送指令而无活跃会话时，编辑器侧不静默新建——拉起 docked 管理页
// 并打开新建对话框预填结构化指令（用户确认后走既有创建链，可改可弃）。消费
// 范式同上（模板降级出口）：immediate 消费积压 + consumeInlineEditDialogRequest
// 模块级消费进度跨 remount 幂等；注册位同样在 openNewDialog/dialogPrefill 之后
watch(inlineEditDialogRequest, () => {
  const prompt = consumeInlineEditDialogRequest()
  if (prompt !== null) openNewDialog({ prompt })
}, { immediate: true })

// ============== 重新发起（P-20261003-146）：会话行入口 → 预填新建对话框 ==============
// 取创建时落 meta 的 initialPrompt（launchArgs 原文）+ dir/runtime 组装预填，
// 用户确认后走既有创建链（可改可弃，不自动发起——重发指令的上下文时效用户自担，
// 与排队指令同款边界）。无记录（无 prompt 创建/旧会话）同样可用：指令留空
function onRelaunch(sessionId: string) {
  const s = sessions.value.find(ss => ss.id === sessionId)
  if (!s) return
  openNewDialog({
    dir: s.path || undefined,
    runtime: s.runtime || undefined,
    prompt: s.initialPrompt || undefined,
  })
}

// ============== 复盘报告（P-20261004-60）：会话行入口 → App 层复盘弹层 ==============
// 弹层本体挂 App 层单一实例（通知卡动作同达），这里只写 postmortem store
function onPostmortem(sessionId: string) {
  usePostmortemStore().openSession(sessionId)
}

// ============== 联邦派发入口信号（P-20261004-101：fleet 总览「在此实例新建会话」） ==============
// View 是惰性挂载（宿主 v-if），请求可能先于挂载到达——immediate 消费积压请求，
// 之后随变化消费；consumeDispatchRequest 携模块级消费进度（跨 remount 幂等，
// 已消费的旧请求不会在重挂树上幽灵重放）
watch(dispatchOpenRequest, () => {
  const target = consumeDispatchRequest()
  if (target !== null) openNewDialog({ instanceId: target || undefined })
}, { immediate: true })
/** 对话框创建成功：接管到本页渲染（选型失败降级信息由对话框统一处理） */
function onDialogCreated(s: { id: string; name: string; runtime: string }) {
  touch(s.id)
  selectedId.value = s.id
}

/** 兼容旧调用形态（外部组件 emit create）：统一转对话框入口 */
function onCreate() {
  openNewDialog()
}

// ============== 编辑器选区拖拽落点（P-20261003-162） ==============
// 手势与拖影在 MonacoEditor（Alt+拖，views/editor/selectionDrag）；本页只消费
// 落点：会话行 = 追加到该会话输入行（xterm 粘贴，不回车 = 不发送）；新建区 =
// 预填新建对话框（用户确认才创建，不自动发起）。未命中目标由源侧直接取消。
// 落点属性：系统会话行 data-sc-selection-drop="session:<id>"（AgentSidebarSessionTree
// 三处行模板；项目会话行不在本版落点面），新建按钮 "new-session"（侧栏 + 头部两处）。
function onSelectionDrop(e: Event): void {
  // spring-open 展开的就是本页；隐藏/悬浮形态下侧栏不在场，忽略迟到事件
  if (!visible.value || mode.value !== 'docked') return
  const detail = (e as CustomEvent<{ target?: string; selection?: EditorSelectionDragPayload }>).detail
  const target = detail?.target || ''
  const payload = detail?.selection
  if (!target || !payload?.text) return
  const text = buildSelectionDragText(payload, t)
  if (target === 'new-session') {
    openNewDialog({ prompt: text })
    return
  }
  if (!target.startsWith('session:')) return
  const id = target.slice('session:'.length)
  const session = sessions.value.find(s => s.id === id)
  if (!session) return
  void appendToSessionInput(id, session.name, text)
}

/** 追加到会话输入行：先选中（惰性挂载 pane）→ 轮询等 WS 连上再写。
 *  pane 就绪判定/粘贴降级（括号粘贴不可用压单行）在 TerminalPane.insertText；
 * 超时（约 4s）不吞内容——选区落剪贴板供手动粘贴，失败可恢复。 */
async function appendToSessionInput(id: string, name: string, text: string): Promise<void> {
  selectAgent(id)
  let outcome: 'multi' | 'single' | null = null
  for (let i = 0; i < 40 && !outcome; i++) {
    outcome = panesRef.value?.insertTextFor(id, text) ?? null
    if (!outcome) await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (outcome === 'multi') {
    message.success(t('editor.selectionDrag.appended', { name }))
  } else if (outcome === 'single') {
    message.success(t('editor.selectionDrag.appendedSingleLine', { name }))
  } else {
    const copied = await copyText(text)
    message.warning(t(copied ? 'editor.selectionDrag.paneNotReady' : 'editor.selectionDrag.paneNotReadyNoClipboard'))
  }
}

onMounted(() => window.addEventListener(SELECTION_DRAG_DROP_EVENT, onSelectionDrop))
onBeforeUnmount(() => window.removeEventListener(SELECTION_DRAG_DROP_EVENT, onSelectionDrop))

// ============== 会话产出面板（B3） ==============
const showActivity = ref(false)
const activitySessionId = computed(() => (showActivity.value ? activeId.value || selectedId.value : ''))
function toggleActivity() {
  showActivity.value = !showActivity.value
}

// 底层会话退出（shell 死亡）：从列表移除并提示
function onSessionExit(sessionId: string) {
  const s = sessions.value.find(ss => ss.id === sessionId)
  removeLocal(sessionId)
  if (s) message.info(t('agentTerminal.exitToast', { name: s.name }))
}

// 项目会话退出（native shell 死亡等）：本地清理 + 若正选中则回到空态
function onProjectSessionExit(sessionId: string) {
  const s = sessionsStore.projectSessions.find(ss => ss.id === sessionId)
  sessionsStore.markExited(sessionId)
  if (selectedId.value === sessionId) selectedId.value = ''
  if (s) message.info(t('agentTerminal.exitToast', { name: s.name }))
}

/** 项目会话双击内联重命名（侧栏直传新名） */
async function onProjectSessionRename(payload: { sessionId: string; name: string }) {
  if (payload.name.trim()) await sessionsStore.rename(payload.sessionId, payload.name.trim())
}

// 分组数据里可能残留已销毁会话 id：渲染侧按 sessions 过滤，这里不做清理
</script>

<template>
  <div
    class="atv-root"
    :class="{ 'is-float': isFloat }"
    :style="isFloat ? { left: `${floatPos.x}px`, top: `${floatPos.y}px`, width: `${floatSize.w}px`, height: `${floatSize.h}px` } : undefined"
    @contextmenu="suppressNativeMenu"
  >
    <AgentTerminalHeader
      :session-count="sessionCount"
      :running="running"
      :is-float="isFloat"
      :standalone="standalone"
      :sidebar-collapsed="sidebarCollapsed"
      :show-activity="showActivity"
      :project-create-options="projectCreateOptions"
      @new="openNewDialog()"
      @compare="openCompareExperiment()"
      @chains="openAgentChains()"
      @create-project="onCreateProjectSelect"
      @dock="setMode('docked')"
      @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
      @float="setMode('float')"
      @collapse="collapse"
      @toggle-activity="toggleActivity"
      @close="emit('close')"
      @header-pointerdown="onHeaderPointerDown"
    />

    <!-- 悬浮窗 tab 条（多会话：系统会话 + 被接管的项目会话；单会话隐藏） -->
    <AgentTerminalFloatTabs
      v-if="isFloat && floatTabs.length > 1"
      :tabs="floatTabs"
      :active-key="floatActiveKey"
      :locate-dirs="dirBySessionId"
      :unread-map="sessionsStore.unreadMap"
      @tab-click="onFloatTabClick"
      @tab-close="onFloatTabClose"
      @tab-locate="({ id }) => locateSessionInTree(id)"
    />

    <div class="atv-body">
      <!-- 左侧会话列表（可折叠；宽度可拖拽调整） -->
      <AgentTerminalSidebar
        v-show="!sidebarCollapsed && !isFloat"
        v-model:list-tab="managerListTab"
        class="atv-sidebar"
        :style="{ width: `${sidebarWidth}px` }"
        :sessions="displaySessions"
        :groups="groups"
        :active-id="activeId"
        :booting="booting"
        :project-groups="projectGroups"
        :selected-id="selectedId"
        :running-map="sessionsStore.runningMap"
        :activity-map="sessionsStore.activityMap"
        :created-map="createdMapBySessionId"
        :unread-map="sessionsStore.unreadMap"
        :sort-mode="sessionsStore.sortMode"
        :group-mode="sessionsStore.groupMode"
        :runtime-filter="sessionsStore.runtimeFilter"
        :collapsed-projects="collapsedProjects"
        :locate-dirs="dirBySessionId"
        :direct-holds="directHolds"
        :live-titles="liveTitles"
        @direct-revoke="onDirectRevoke"
        @capability-action="onCapabilityAction"
        @update:sort-mode="sessionsStore.setSortMode"
        @update:group-mode="sessionsStore.setGroupMode"
        @toggle-runtime-filter="sessionsStore.toggleRuntimeFilter"
        @clear-runtime-filter="sessionsStore.clearRuntimeFilter"
        @select="selectAgent"
        @attach-project="attachProject"
        @open-project="openProject"
        @open-project-session="({ projectId, sessionId }) => openProject(projectId, sessionId)"
        @toggle-project="onToggleProject"
        @project-action="onProjectAction"
        @project-session-action="onProjectSessionAction"
        @locate-tree="locateSessionInTree"
        @cross-review="onCrossReview"
        @chain-continue="onChainContinue"
        @review-mark="onReviewMark"
        @toggle-sensitive="onToggleSensitive"
        @relaunch="onRelaunch"
        @postmortem="onPostmortem"
        @create="onCreate"
        @session-action="onSessionAction"
        @rename-project="onProjectSessionRename"
        @group-action="onGroupAction"
        @reorder-groups="onReorderGroups"
        @reorder-group-sessions="onReorderGroupSessions"
        @move-session="onMoveSessionByDrag"
        @reorder-project-groups="onReorderProjectGroups"
        @reorder-project-sessions="onReorderProjectSessions"
        @batch-move="onBatchMove"
        @batch-destroy="onBatchDestroy"
      />
      <!-- 侧栏宽度拖拽把手（docked 且未折叠时显示） -->
      <div
        v-show="!sidebarCollapsed && !isFloat"
        class="atv-side-resizer"
        :class="{ 'is-resizing': sideResizing }"
        :title="t('agentTerminal.sidebarResizeTip')"
        @pointerdown="onSidebarResizeDown"
      />

      <!-- 右侧终端区：多会话 keep-alive + 右键菜单（AgentTerminalPanes） -->
      <AgentTerminalPanes
        ref="panesRef"
        :sessions="sessions"
        :active-id="activeId"
        :selected-id="selectedId"
        :selected-project-session="selectedProjectSession ?? null"
        :attached-project-sessions="attachedProjectSessions"
        :mounted-agent-sessions="mountedAgentSessions"
        :show-activity="showActivity"
        :activity-session-id="activitySessionId"
        :manager-list-tab="managerListTab"
        @exit="onSessionExit"
        @project-exit="onProjectSessionExit"
        @activity-close="showActivity = false"
        @new="openNewDialog()"
      />
    </div>

    <!-- 悬浮窗缩放手柄：四边 + 四角（se 沿用 .agt-resize e2e 契约类名） -->
    <template v-if="isFloat">
      <div
        v-for="dir in (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const)"
        :key="dir"
        class="agt-resize-zone"
        :class="[`agt-resize-${dir}`, dir === 'se' ? 'agt-resize' : '']"
        @pointerdown="(e: PointerEvent) => onFloatResizeDown(dir, e)"
      />
    </template>

    <!-- 新建会话对话框（多入口共享：头部按钮 / 空态 / 侧栏 create 事件）。
         必须位于根节点内部：多根组件会禁用 attribute 透传，宿主传入的
         class="agt-fill"（内嵌主区 flex:1 占满）会被静默丢弃——历史上
         docked 管理页在项目内宽度坍缩为内容宽即此根因 -->
    <NewSessionDialog
      v-model:show="showNewDialog"
      :prefill-dir="dialogPrefill.dir"
      :prefill-runtime="dialogPrefill.runtime"
      :prefill-instance-id="dialogPrefill.instanceId"
      :prefill-prompt="dialogPrefill.prompt"
      :prefill-template-id="dialogPrefill.templateId"
      @created="onDialogCreated"
    />

    <!-- 交叉审查弹层（P-20261003-6）：会话行右键 / 产出面板操作区两入口共享
         一份实例（源会话状态在 useCrossReview 模块级单例） -->
    <CrossReviewDialog />

    <!-- 完成后接续弹层（P-20261004-38）：会话行右键入口，源会话状态在
         useAgentChain 模块级单例（他页入口经 openChainContinue 共享） -->
    <ChainContinueDialog />
  </div>
</template>

<style scoped>
.atv-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  overflow: hidden;
}
/* 悬浮窗形态（View 即窗口）：固定定位 + 持久化几何，DOM 零移动 */
.atv-root.is-float {
  position: fixed;
  z-index: 1500; /* 低于 naive 弹窗（~2000），与旧悬浮窗一致 */
  border: 1px solid var(--border-default);
  border-radius: 10px;
  box-shadow: var(--shadow-strong, 0 12px 40px rgba(0, 0, 0, 0.35));
  overflow: hidden;
}
/* 悬浮窗缩放手柄：四边 + 四角命中区（透明，悬停微亮提示可抓取）；
   se 命中区带旧款斜纹视觉（e2e 以 .agt-resize-se 定位） */
.agt-resize-zone {
  position: absolute;
  z-index: 100;
  pointer-events: auto;
}
.agt-resize-zone:hover { background: color-mix(in srgb, var(--accent-blue) 35%, transparent); }
.agt-resize-n { top: -3px; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
.agt-resize-s { bottom: -3px; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
.agt-resize-e { right: -3px; top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
.agt-resize-w { left: -3px; top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
.agt-resize-ne, .agt-resize-sw { width: 14px; height: 14px; cursor: nesw-resize; }
.agt-resize-nw, .agt-resize-se { width: 14px; height: 14px; cursor: nwse-resize; }
.agt-resize-ne { top: -3px; right: -3px; border-top-right-radius: 10px; }
.agt-resize-nw { top: -3px; left: -3px; border-top-left-radius: 10px; }
.agt-resize-sw { bottom: -3px; left: -3px; border-bottom-left-radius: 10px; }
.agt-resize-se {
  right: -3px;
  bottom: -3px;
  border-bottom-right-radius: 10px;
  background: linear-gradient(135deg, transparent 0 50%, var(--border-default) 50% 55%, transparent 55% 70%, var(--border-default) 70% 75%, transparent 75%);
}
.agt-resize-se:hover {
  background: linear-gradient(135deg, transparent 0 50%, var(--accent-blue) 50% 55%, transparent 55% 70%, var(--accent-blue) 70% 75%, transparent 75%);
}

.atv-body { flex: 1; display: flex; min-height: 0; }
/* 侧栏宽度由内联 style（sidebarWidth，可拖拽 160-480px）驱动 */
.atv-sidebar {
  flex-shrink: 0;
  border-right: 1px solid var(--border-default);
  background: var(--bg-panel);
}
/* 侧栏宽度拖拽把手：常显竖向握把纹（可发现性——纯透明把手等于不存在），
   悬停/拖拽中整条高亮加宽命中区 */
.atv-side-resizer {
  width: 8px;
  margin: 0 -4px;
  z-index: 5;
  cursor: col-resize;
  flex-shrink: 0;
  position: relative;
  transition: background var(--motion-base);
}
.atv-side-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  border-radius: 1px;
  background: var(--border-default);
  opacity: 0.6;
  transition: background var(--motion-base), opacity var(--motion-base);
}
.atv-side-resizer:hover::after,
.atv-side-resizer.is-resizing::after { background: var(--accent-blue); opacity: 1; }
.atv-side-resizer:hover,
.atv-side-resizer.is-resizing { background: color-mix(in srgb, var(--accent-blue) 14%, transparent); }
</style>
