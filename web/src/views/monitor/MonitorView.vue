<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NIcon, NInput, useMessage } from 'naive-ui'
import { ArrowBackOutline, EyeOffOutline, EyeOutline, OptionsOutline, PlaySkipForwardOutline, RefreshOutline, ReorderTwoOutline, TvOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useAssistantTaskStore, type TaskProgressStep } from '../../stores/assistantTask'
import { useApprovalsStore } from '../../stores/approvals'
import { useAsksStore } from '../../stores/asks'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useProjectStore } from '../../stores/project'
import { useLockStore } from '../../stores/lock'
import { useApprovalActions } from '../../composables/useApprovalActions'
import { useAskActions } from '../../composables/useAskActions'
import { opsConfirmApi } from '../../api/domains/opsconfirm'
import type { ApprovalRecord } from '../../api/domains/opsconfirm'
import { opsAskApi } from '../../api/domains/opsask'
import type { AskRecord } from '../../api/domains/opsask'
import { useStallTriageStore } from '../../stores/stallTriage'
import { maskApprovalSecrets } from '../../utils/sensitiveMask'
import { relativeTimeParts } from '../../utils/relative-time'
import { sessionBadgeDecision } from '../../utils/session-idle'
import { copyText } from '../../utils/clipboard'
import { collectFleetBatches, type FleetBatchView, type FleetMemberRow } from '../../utils/fleetBatches'
import { OPS_ACTIVATE_TERMINAL } from '../../utils/opsEvents'
import { REMOTE_TASK_PREFIX } from '../../utils/remoteTaskKey'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { useMonitorBoardLayout } from '../../composables/useMonitorBoardLayout'
import { useMonitorCarousel, MONITOR_CAROUSEL_INTERVALS } from '../../composables/useMonitorCarousel'
import {
  mergeMonitorCardOrder,
  monitorCardLabelKey,
  splitMonitorVisibility,
  type MonitorCardId,
} from '../../utils/monitorBoardLayout'
import RecordingBrowser from '../../components/recording/RecordingBrowser.vue'
import ApprovalTierPopover from '../../components/agent/ApprovalTierPopover.vue'
import HandoverPackageModal from '../../components/monitor/HandoverPackageModal.vue'
import AttentionTriageBar from '../../components/monitor/AttentionTriageBar.vue'
import InstanceHealthCard from '../../components/monitor/InstanceHealthCard.vue'
import ActivityHeatmapCard from '../../components/monitor/ActivityHeatmapCard.vue'
import FederationActivityCard from '../../components/monitor/FederationActivityCard.vue'
import FleetNotifyCard from '../../components/monitor/FleetNotifyCard.vue'
import ChangeStreamCard from '../../components/monitor/ChangeStreamCard.vue'
import AgentCollabStreamCard from '../../components/monitor/AgentCollabStreamCard.vue'
import InstanceNotifyOverview from '../../components/instance/InstanceNotifyOverview.vue'
import ApprovalGuideBar from '../../components/agent/ApprovalGuideBar.vue'
import ApprovalRuleSuggestBar from '../../components/agent/ApprovalRuleSuggestBar.vue'
import { useApprovalRuleSuggest } from '../../composables/useApprovalRuleSuggest'

/**
 * 值班大屏（P-20261001-5）：为第二块显示器/平板设计的 agent 机群监控页。
 * 独立于 Layout 的全屏卡片墙（无侧栏/顶栏），四类卡片一屏尽览：
 * - 审批卡：approvals.pending（裁决复用 useApprovalActions，与全局卡片堆一致；
 *   挂载时经 GET /ops-confirm 回填 pending——全局卡堆只靠广播入账，大屏常在
 *   审批产生之后才打开，需要一次冷启动补账）
 * - 提问卡：asks.pending（P-20261001-27，作答复用 useAskActions 与全局卡片堆
 *   一致；挂载时经 GET /ops-ask 冷启动补账，同款广播兜底增量）
 * - 任务进度卡：assistantTask.bySession（WS task.progress 实时更新，进度归属
 *   到终端会话；无归属时回退全局任务字段）
 * - 终端会话卡：terminal-sessions store（运行态 runningMap / 活动时间
 *   activityMap，terminals.changed 广播实时对账）
 *
 * 数据全部来自既有 store / 既有 API，无新后端；主题走全局 CSS 变量自适应；
 * 锁定由 App 层 LockScreenOverlay 覆盖（RouterView 之外），接口走既有 /api 鉴权。
 */

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const assistantTask = useAssistantTaskStore()
const approvals = useApprovalsStore()
const asks = useAsksStore()
const sessionsStore = useTerminalSessionsStore()
const projectStore = useProjectStore()
// 会话卡跳转复用（P-20261003-53 ③）：项目会话的接管归还/切项目/底部激活全链在此
const { jumpToProjectSession } = useAgentTerminal()
const { agentLabel, decide } = useApprovalActions()
// 停滞分诊卡（P-20261004-37）：停滞强标点击打开（卡本体挂 App 层单实例）
const stallTriage = useStallTriageStore()
// 提问卡来源标签走提问域实现（ops.ask.agentUnknown 文案；映射与审批一致）
const { agentLabel: askAgentLabel, answerText } = useAskActions()

// ============== 数据加载 ==============
const refreshing = ref(false)
const refreshedAt = ref('')
// 实例健康卡（P-20261003-28）：refreshAll/R 键顺带触发其 refresh()（卡自身
// 另有 30s 轮询兜底），解锁后 coldSeed 补账同样覆盖到它
const healthCardRef = ref<InstanceType<typeof InstanceHealthCard> | null>(null)
// 实例活动热力图卡（P-20261003-37）：同款 refreshAll 顺带刷新（天粒度数据
// 无需轮询，挂载即拉 + 手动刷新即最新）
const activityCardRef = ref<InstanceType<typeof ActivityHeatmapCard> | null>(null)
// 联邦活动热力卡（P-20261004-98）：同款 refreshAll 顺带刷新（天粒度数据无需
// 轮询，服务端另有 5 分钟聚合缓存）
const federationCardRef = ref<InstanceType<typeof FederationActivityCard> | null>(null)
// 跨实例通知卡（P-20261003-125）：同款 refreshAll 顺带刷新（卡自带 60s 轮询
// 兜底）；点击卡片开聚合弹层（本页宿主渲染，与 Layout 宿主互不相干）
const fleetNotifyCardRef = ref<InstanceType<typeof FleetNotifyCard> | null>(null)
const showFleetNotify = ref(false)
// 跨项目实时变更流卡（P-20261003-232）：同款 refreshAll 顺带刷新（卡自带 5s
// 轮询兜底）——「刚刚发生了什么」的即时重读
const changeStreamCardRef = ref<InstanceType<typeof ChangeStreamCard> | null>(null)
// agent 协作流卡（P-20261008-6）：同款 refreshAll 顺带刷新（纯事件驱动零轮询，
// 刷新语义 = 链清单对账一次）——「agent 间正在发生什么」的即时对账
const collabCardRef = ref<InstanceType<typeof AgentCollabStreamCard> | null>(null)

/** 大屏冷启动补账：列表里的 pending 回填进 store（广播兜底增量） */
async function seedApprovals() {
  try {
    // 响应解包约定：axios 拦截器已返回 gin body，业务负载在 res.data。
    // status=pending（P-20261003-254）：本页只消费 pending 补账，服务端过滤后
    // payload 不再随每日清理窗口内历史增长；不带 limit = pending 全量语义
    const res = (await opsConfirmApi.list({ status: 'pending' })) as unknown as { data?: ApprovalRecord[] }
    for (const a of res?.data ?? []) {
      if (a.status === 'pending') approvals.upsert(a)
    }
  } catch { /* 列表拉取失败不阻塞大屏（WS 广播兜底增量） */ }
}

/** 提问冷启动补账（P-20261001-27）：与审批同款——大屏常在提问产生后才打开 */
async function seedAsks() {
  try {
    const res = (await opsAskApi.list()) as unknown as { data?: AskRecord[] }
    for (const a of res?.data ?? []) {
      if (a.status === 'pending') asks.upsert(a)
    }
  } catch { /* 列表拉取失败不阻塞大屏（WS 广播兜底增量） */ }
}

async function refreshAll() {
  refreshing.value = true
  try {
    await Promise.all([sessionsStore.refresh(), seedApprovals(), seedAsks(), healthCardRef.value?.refresh(), activityCardRef.value?.refresh(), federationCardRef.value?.refresh(), fleetNotifyCardRef.value?.refresh(), changeStreamCardRef.value?.refresh(), collabCardRef.value?.refresh()])
    refreshedAt.value = new Date().toLocaleTimeString()
  } finally {
    refreshing.value = false
  }
}

// 冷启动补账与解锁时序（附带修复既有缺陷）：锁定遮罩是覆盖式，本组件在
// 引导期即挂载，而 isLocked 默认 true——此时发起补账必然无 token 423 空手
// 而归，且解锁后无人重拉，大屏停在「机群空闲」空态直到手动刷新（锁定启用
// 时每次进入都如此）。改为：锁定/未判定期挂起补账，解锁落定即拉一次；
// 未锁引导只经历 true→false 一次翻转，语义上仍是单次补账
const lockStore = useLockStore()
const coldSeedPending = ref(false)
watch(() => lockStore.isLocked, (locked) => {
  if (!locked && coldSeedPending.value) {
    coldSeedPending.value = false
    void board.restore()
    void refreshAll()
  }
})

onMounted(() => {
  // 布局恢复（P-20261004-18）：与数据补账并行不阻塞首屏（恢复落地前按内置序
  // 渲染，短暂陈旧序同活动栏手动序恢复先例可接受）；锁定态先试恢复（423 静默
  // 回落默认布局），解锁落定由下方 watcher 重拉
  void board.restore()
  if (lockStore.isLocked) {
    coldSeedPending.value = true
    return
  }
  void refreshAll()
})

// ============== 过程实况（P-20261001-15） ==============
// 审批录制的浏览/回放（值班大屏作为审批历史承载面：列表含已裁决窗口的录制）
const showRecording = ref(false)
const recordingApprovalId = ref('')
function openRecording(id?: string): void {
  recordingApprovalId.value = id ?? ''
  showRecording.value = true
}

// ============== 键盘刷新（P-20261002-80） ==============
// R = refreshAll：大屏值守场景手挂键盘，R 刷新是监控页惯例。焦点落在按钮/
// 输入框等交互元素时跳过（closest 判定同通知中心先例），不抢占任何元素键位；
// 带修饰键的 R（如 Ctrl+R 浏览器刷新）不拦截；锁定态（接口 423 空转）、录制
// 回放弹层打开、刷新进行中（防重入）均不响应
function onBoardKeydown(e: KeyboardEvent): void {
  if (e.key !== 'r' && e.key !== 'R') return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const target = e.target as HTMLElement | null
  if (target?.closest('button, input, textarea, select, [contenteditable="true"]')) return
  if (lockStore.isLocked || showRecording.value || refreshing.value) return
  void refreshAll()
}
onMounted(() => window.addEventListener('keydown', onBoardKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onBoardKeydown))

// ============== 审批卡 ==============
const approvalCards = computed(() =>
  [...approvals.pendingList].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')))

// 模式自学习建议（P-20261006-28）：与全局卡堆同源同节流（useApprovalRuleSuggest
// 单例，大屏裁决同计入模式）；pending 增长即刷新检测源，同 ApprovalCards 宿主
const ruleSuggest = useApprovalRuleSuggest()
watch(() => approvals.pendingCount, (n) => {
  if (n > 0) void ruleSuggest.refresh()
})
const ruleSuggestion = computed(() => ruleSuggest.suggestionFor(approvalCards.value))

/** 审批发起会话名（值班场景需一眼定位来源会话；列表对账后无此 id 时不显示） */
function approvalSessionName(id?: string): string {
  if (!id) return ''
  return sessionsStore.sessions.find(s => s.id === id)?.name || ''
}

// ============== 提问卡（P-20261001-27） ==============
const askCards = computed(() =>
  [...asks.pendingList].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')))

/** 提问发起会话名（口径与审批卡一致） */
function askSessionName(id?: string): string {
  return approvalSessionName(id)
}

/** 自由文本形态的每卡草稿（选项形态点击即答，无需草稿） */
const askDrafts = ref<Record<string, string>>({})
function submitAskDraft(a: AskRecord) {
  const v = (askDrafts.value[a.id] || '').trim()
  if (!v) return
  delete askDrafts.value[a.id]
  void answerText(a.id, v)
}

// ============== 任务进度卡 ==============
interface TaskCard {
  id: string
  /** 会话名（bySession 键 = 终端会话 id）；无归属上报时为空 → 显示未知会话。
   *  远程条目（P-20261004-131）本地会话表查不到，用回流自带的 remote 元数据 */
  sessionName: string
  /** 远程来源实例展示名（remote: 命名空间键在位时有值——实例徽标） */
  remoteInstance: string
  task: string
  step: string
  status: string
  updatedAt: number
  /** 结构化步骤清单（P-20261004-7）：steps 在位时 step 为当前项指针 */
  steps: TaskProgressStep[]
  /** 可能失联（P-20261003-303）：running 且超阈值无上报——弱化样式+徽标，
   *  不清数据（真终态到达仍可覆盖） */
  stale: boolean
  /** 已失效过渡（P-20261004-31）：归属会话已不在会话表且仍 running。清账
   *  （pruneClosedSessions）只随 terminals.changed 快照/refresh 到达，本地
   *  移除路径（destroy/markExited）与上报竞态的间隙里先置灰标「已失效」
   *  过渡，不按活卡误导值班判读 */
  invalid: boolean
}

/** 会话存活集（invalid 判定用）：computed 建一次 Set 逐卡 O(1)，不在逐卡
 *  映射里反复线性扫 sessions（进度上报每步触发 taskCards 重算） */
const sessionIdSet = computed(() => new Set(sessionsStore.sessions.map(s => s.id)))

/** 已失效判据（P-20261004-31）：本地键 + running + 会话表已加载且查无此会话。
 *  - remote: 键豁免——远程会话不在本地快照是常态而非死亡（收账挂派发记录
 *    生命周期，useFleetTaskBackflow），与 store 侧 pruneClosedSessions 的
 *    remote 豁免同一裁决（键前缀判定同源）
 *  - loaded 守卫防冷启动误判：会话列表尚未拉回时全体本地键都「不存在」，
 *    不能据此批量置灰（首拉成功后 loaded 恒 true，此后列表即权威存活面）
 *  - 只对 running 生效：done/failed 是真终态，供回看的卡不因会话关闭变脸 */
function taskEntryInvalid(id: string, status: string): boolean {
  if (id.startsWith(REMOTE_TASK_PREFIX) || status !== 'running') return false
  if (!sessionsStore.loaded) return false
  return !sessionIdSet.value.has(id)
}

const taskCards = computed<TaskCard[]>(() =>
  Object.entries(assistantTask.bySession)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .map(([id, v]) => ({
      id,
      sessionName: sessionsStore.sessions.find(s => s.id === id)?.name || v.remote?.sessionName || '',
      remoteInstance: v.remote?.instanceName || '',
      task: v.task,
      step: v.step,
      status: v.status || 'running',
      updatedAt: v.updatedAt,
      steps: v.steps ?? [],
      stale: assistantTask.staleSessionIds.has(id),
      invalid: taskEntryInvalid(id, v.status || 'running'),
    })))

/** 无会话归属的全局任务兜底卡（不带 terminalId 的 task.progress 只写全局字段） */
const globalTaskCard = computed<TaskCard | null>(() => {
  if (!assistantTask.active || assistantTask.status !== 'running') return null
  if (taskCards.value.some(c => c.status === 'running')) return null
  return {
    id: '__global__',
    sessionName: '',
    remoteInstance: '',
    task: assistantTask.task,
    step: assistantTask.step,
    status: 'running',
    updatedAt: assistantTask.updatedAt,
    steps: assistantTask.steps,
    stale: assistantTask.isStale,
    invalid: false,
  }
})

// ============== 编队聚合卡（P-20261005-145） ==============
// bulk-agent 批的聚合盯盘面：批内成员终态计数（N done / M failed / K running）
// + 失败高亮 + 展开成员行直达。计数与批级完成通知共用 collectFleetBatches
// 纯函数（口径一份）；成员全会话关闭的批自然消失（完成事实已由通知承载）。
// 侧栏会话树 fleet 顶层自动分组列二期（MVP 免动分组语义，聚合卡+通知为主）
const fleetBatchCards = computed<FleetBatchView[]>(() =>
  collectFleetBatches(sessionsStore.sessions, assistantTask.bySession))

/** 展开态（成员行清单）：点卡头切换；通知直达自动展开 */
const expandedFleets = ref(new Set<string>())
function toggleFleetExpand(batchId: string): void {
  const next = new Set(expandedFleets.value)
  if (next.has(batchId)) next.delete(batchId)
  else next.add(batchId)
  expandedFleets.value = next
}

/** 直达高亮：通知 action 携 ?fleet=<batchId> 落地即展开+高亮+滚动定位；
 *  query 消失（再次进入不带参）即摘除高亮 */
const highlightFleetId = ref('')
watch(() => route.query.fleet, (v) => {
  const id = typeof v === 'string' ? v : ''
  highlightFleetId.value = id
  if (!id) return
  if (!expandedFleets.value.has(id)) {
    expandedFleets.value = new Set([...expandedFleets.value, id])
  }
  void nextTick(() => {
    document.querySelector(`[data-fleet-card="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}, { immediate: true })

/** 成员行点击直达（jumpSession 同款分流）：编队成员多为系统会话（dir=项目根
 *  但免项目绑定）→ 回首页交 OPS 激活意图；带项目归属的行走接管归还链 */
async function jumpFleetMember(m: FleetMemberRow): Promise<void> {
  if (!m.live) return
  if (m.projectId) {
    await jumpToProjectSession(m.projectId, m.id, router)
    return
  }
  if (router.currentRoute.value.name !== 'home') await router.push('/')
  window.dispatchEvent(new CustomEvent(OPS_ACTIVATE_TERMINAL, { detail: { id: m.id } }))
}

// ============== 终端会话卡 ==============
/** 会话卡行标档位（P-20261004-37 sessionBadgeDecision 共用决策）：停滞强标 /
 *  静默弱标 / pending 特化三档同源；n=0 不渲染 */
interface SessionBadge {
  stall: boolean
  badge: string
  tip: string
  n: number
}

interface SessionCard {
  id: string
  name: string
  kind: string
  projectId: string
  projectName: string
  running: boolean
  activityText: string
  /** 行标档位决策：停滞强标优先（弱样标一档之上），n=0 = 不显示 */
  badge: SessionBadge
  path: string
}

const sessionCards = computed<SessionCard[]>(() => {
  // 读心跳时钟登记依赖：停滞判据的分钟数随 30s 心跳随时间重算（值班大屏
  // 常驻页面，agent 死后无事件驱动，无 tick 强标永不点亮）
  void assistantTask.nowTick
  return sessionsStore.sortedSessions.map(s => {
    const ts = sessionsStore.activityMap[s.id]
    const p = assistantTask.bySession[s.id]
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      projectId: s.projectId,
      projectName: projectStore.projects.find(p => p.id === s.projectId)?.name || '',
      running: sessionsStore.runningMap[s.id] === true,
      activityText: ts ? relTime(ts) : '',
      badge: sessionBadgeDecision({
        taskRunning: p?.status === 'running',
        running: sessionsStore.runningMap[s.id],
        lastActivity: ts,
        lastReportAt: p?.updatedAt,
        hasPendingApproval: approvals.pendingSessionIds.has(s.id),
      }),
      path: s.path,
    }
  })
})

/** 卡片 tooltip：工作目录 + 行标 hover 提示（P-20261003-53 ②，pending 特化 P-198，
 *  停滞特化 P-20261004-37——同一位三档文案） */
function sessCardTitle(s: SessionCard): string {
  return s.badge.n > 0 ? `${s.path}\n${t(s.badge.tip)}` : s.path
}

/** 行标点击（P-20261004-37）：停滞强标开分诊卡（截停防触发跳转）；弱标不拦截
 *  ——与既有「点卡跳会话」行为一致 */
function onSessBadgeClick(s: SessionCard, e: MouseEvent): void {
  if (!s.badge.stall) return
  e.stopPropagation()
  stallTriage.openSession(s.id)
}

/** 静默卡点击跳会话（③）：系统会话回首页交 OPS 激活意图（悬浮/管理页定位），
 *  项目会话走 jumpToProjectSession 同款（接管归还 + 切项目 + 底部终端激活） */
async function jumpSession(s: SessionCard) {
  if (s.projectId) {
    await jumpToProjectSession(s.projectId, s.id, router)
    return
  }
  if (router.currentRoute.value.name !== 'home') await router.push('/')
  window.dispatchEvent(new CustomEvent(OPS_ACTIVATE_TERMINAL, { detail: { id: s.id } }))
}

const isEmpty = computed(() =>
  approvalCards.value.length === 0 &&
  askCards.value.length === 0 &&
  taskCards.value.length === 0 &&
  globalTaskCard.value === null &&
  fleetBatchCards.value.length === 0 &&
  sessionCards.value.length === 0)

// ============== 卡片类目布局（P-20261004-18） ==============
// 类目级顺序 + 显隐定制：编辑模式（会话态开关）下按类目块拖拽重排（insert-
// before，活动栏面板拖拽同手势）+ 眼睛按类目显隐；布局持久化 uiState
// monitorBoard 命名空间（顺序/显隐裁决纯函数在 utils/monitorBoardLayout，
// 胶水在 useMonitorBoardLayout）。防漏看护栏：隐藏类目出现待处理项时自动
// 临时置顶显示并高亮——宁可多看一眼，不可漏看一项。
const board = useMonitorBoardLayout()
/** 编辑模式（模板高频用，取顶层引用随模板自动解包） */
const editing = board.editMode

/** 各类目当前条目数（isEmpty 维持「机群级」语义不动：编辑模式计数徽标 +
 *  空态判定都看机器事实，不看用户显隐——隐藏不等于不存在） */
const catCounts = computed<Record<MonitorCardId, number>>(() => ({
  fleet: fleetBatchCards.value.length,
  approvals: approvalCards.value.length,
  asks: askCards.value.length,
  tasks: taskCards.value.length + (globalTaskCard.value ? 1 : 0),
  sessions: sessionCards.value.length,
}))

/** 各类目「有待处理项」判定（隐藏类目的临时置顶触发条件，语义按类目分）：
 *  审批/提问 = 存在待处理卡；任务 = 存在未终态卡（failed/失联/已失效过渡
 *  都是急事，done 是唯一了结态）；会话 = 存在运行中；编队 = 存在运行中或
 *  失败批。全局兜底任务卡只在 running 时存在，天然计入 */
const pendingCats = computed<Set<MonitorCardId>>(() => {
  const s = new Set<MonitorCardId>()
  if (fleetBatchCards.value.some(b => b.running > 0 || b.failed > 0)) s.add('fleet')
  if (approvalCards.value.length > 0) s.add('approvals')
  if (askCards.value.length > 0) s.add('asks')
  if (taskCards.value.some(c => c.status !== 'done') || globalTaskCard.value !== null) s.add('tasks')
  if (sessionCards.value.some(c => c.running)) s.add('sessions')
  return s
})

/** 渲染的类目块：查看态 = 常驻（用户序）+ 临时置顶（隐藏但有待处理，内置序
 *  在前——先看到急事再看日常布局）；编辑态 = 全类目罗列（隐藏项以占位形态
 *  在场，可恢复显示、参与排序）。查看态类目块无类目头，与历史纯卡流观感一致 */
interface RenderedCat {
  id: MonitorCardId
  labelKey: string
  count: number
  hidden: boolean
  /** 临时置顶（查看态专属）：整块高亮 + 「临时显示」注记 */
  temp: boolean
}

const renderedCats = computed<RenderedCat[]>(() => {
  const merged = mergeMonitorCardOrder(board.cardOrder.value)
  const hiddenSet = new Set(board.hiddenCards.value)
  const mk = (id: MonitorCardId, temp: boolean): RenderedCat =>
    ({ id, labelKey: monitorCardLabelKey(id), count: catCounts.value[id], hidden: hiddenSet.has(id), temp })
  if (editing.value) {
    return merged.map(id => mk(id, false))
  }
  const { shown, tempShown } = splitMonitorVisibility(merged, board.hiddenCards.value, pendingCats.value)
  return [...tempShown.map(id => mk(id, true)), ...shown.map(id => mk(id, false))]
})

// 类目块拖拽重排（编辑模式限定）：dragstart 打在类目头（唯一拖拽把柄，卡面
// 交互不受影响），dragover/drop 打在整块（目标好瞄准）；dataTransfer 只为满足
// Firefox 启动条件（活动栏同款教训），判定只认组件内 dragCatId 状态
const dragCatId = ref('')
const overCatId = ref('')
function onCatDragStart(id: string, e: DragEvent): void {
  if (!editing.value) return
  dragCatId.value = id
  e.dataTransfer?.setData('text/plain', id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onCatDragOver(id: string, e: DragEvent): void {
  if (!editing.value || !dragCatId.value || id === dragCatId.value) return
  e.preventDefault() // 允许在此类目块上 drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  overCatId.value = id
}
function onCatDragLeave(id: string): void {
  if (overCatId.value === id) overCatId.value = ''
}
function onCatDrop(id: string): void {
  if (editing.value && dragCatId.value && id !== dragCatId.value) board.moveCard(dragCatId.value, id)
  overCatId.value = ''
}
function onCatDragEnd(): void {
  dragCatId.value = ''
  overCatId.value = ''
}

// ============== 「需注意」分诊条定位（P-20261005-164） ==============
// chip 点击滚动定位到对应类目区（聚合数据在 AttentionTriageBar，类目区 DOM
// 在本宿主）：定位即短暂描边高亮（操作反馈，1.6s 自愈不残留），与编队卡
// 通知直达高亮（is-highlight）同「定位必有落点反馈」的视觉语言。
// 落点类目若被用户隐藏，防漏看护栏（pendingCats）已把它临时置顶渲染——
// 分诊信号本身即是 pending 事实，目标区在此刻恒在场，无需额外显隐处理
const attentionFocusCat = ref<MonitorCardId | ''>('')
let attentionFocusTimer: ReturnType<typeof setTimeout> | null = null
function locateAttentionTarget(cat: MonitorCardId): void {
  void nextTick(() => {
    document.querySelector(`[data-testid="monitor-cat-${cat}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
  attentionFocusCat.value = cat
  if (attentionFocusTimer !== null) clearTimeout(attentionFocusTimer)
  attentionFocusTimer = setTimeout(() => { attentionFocusCat.value = '' }, 1600)
}
onBeforeUnmount(() => {
  if (attentionFocusTimer !== null) clearTimeout(attentionFocusTimer)
})

// ============== 轮播模式（P-20261005-166） ==============
// 挂墙平板/副屏全天值守形态的观看编排：开启后每 N 秒滚动定位下一类目区并
// 蓝描边高亮「当前幕」（与分诊条定位同视觉语言），无人值守的墙屏自动循环
// 关键区块。会话态不持久（刷新回查看态，同编辑模式裁决）。暂停/恢复/交互
// 豁免裁决全在 useMonitorCarousel（纯函数面单测直驱），本页只接线：
// - 区块序列 = 墙内当前渲染类目块（含 instance 固定区），每步现取 DOM 为准
// - 开启即引导全屏（挂墙形态零浏览器 chrome）：开关点击即用户手势满足全屏
//   API 手势要求，iframe/被拒等失败静默——轮播本体不依赖全屏成败；Esc 退出
//   全屏是浏览器内建行为无需自管键位；关停/卸载只回收本次开关引导的全屏
// - 交互暂停：滚动/按压/按键任一命中即挂起（人在操作时不抢滚动条，idle 60s
//   自动恢复）；轮播控件自身豁免——开关/换档是编排操作，开了就被自己暂停
//   是死循环
// - 与编辑模式互斥：编辑态轮播只会扫占位块，两向进入都关掉对方
const wallRef = ref<HTMLElement | null>(null)
const carousel = useMonitorCarousel(() =>
  Array.from(wallRef.value?.querySelectorAll<HTMLElement>('[data-testid^="monitor-cat-"]') ?? []))
/** 模板高频用（顶层引用随模板自动解包），同 editing 先例 */
const carouselOn = carousel.on
const carouselPaused = carousel.pausedByInteraction
const carouselFocusId = carousel.focusId
const carouselIntervalSec = carousel.intervalSec
/** 本次会话是否经轮播开关引导进入全屏（区分用户手动全屏，回收不越权） */
let carouselFullscreenRequested = false

function toggleCarousel(): void {
  const next = !carousel.on.value
  carousel.setOn(next)
  if (!next) {
    if (carouselFullscreenRequested && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => { /* 已被 Esc 退出等：no-op */ })
    }
    carouselFullscreenRequested = false
    return
  }
  if (editing.value) editing.value = false
  // 可选调用（旧 Safari 无未前缀 API）：缺失时静默——全屏是增强不是前提
  const fsTarget = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> }
  fsTarget.requestFullscreen?.().then(() => {
    carouselFullscreenRequested = true
  }).catch(() => { /* 全屏不可用（无手势上下文/被策略拒绝）：轮播照常 */ })
}

// 编辑模式进入即关停轮播（反向互斥在 toggleCarousel）
watch(editing, (v) => {
  if (v) carousel.setOn(false)
})

/** 交互暂停接线（passive：只观测不拦截，滚动原生语义不变） */
function onCarouselInterrupt(e: Event): void {
  if ((e.target as HTMLElement | null)?.closest('.mon-carousel-ctl')) return
  carousel.onUserInteraction()
}
onMounted(() => {
  window.addEventListener('wheel', onCarouselInterrupt, { passive: true })
  window.addEventListener('pointerdown', onCarouselInterrupt)
  window.addEventListener('keydown', onCarouselInterrupt)
})
onBeforeUnmount(() => {
  window.removeEventListener('wheel', onCarouselInterrupt)
  window.removeEventListener('pointerdown', onCarouselInterrupt)
  window.removeEventListener('keydown', onCarouselInterrupt)
  carousel.dispose()
  // 卸载也回收本次开关引导的全屏（轮播随路由消失，全屏留在非轮播页是悬置态；
  // 用户手动进入的全屏不越权回收，Esc 浏览器内建退出不受影响）
  if (carouselFullscreenRequested && document.fullscreenElement) {
    void document.exitFullscreen().catch(() => { /* 已被 Esc 退出等：no-op */ })
  }
})

// ============== 文案工具 ==============
/** 相对时间（复用 agentTerminal.activity* 文案，与悬浮列表/管理页一致） */
function relTime(ts: number): string {
  const p = relativeTimeParts(ts)
  return t(`agentTerminal.${p.key}`, { n: p.n })
}

function taskStatusLabel(status: string): string {
  if (status === 'done') return t('monitorBoard.statusDone')
  if (status === 'failed') return t('monitorBoard.statusFailed')
  return t('monitorBoard.statusRunning')
}

// ============== 交接班摘要（P-20261003-8） ==============
// 纯前端聚合大屏当前事实为结构化纯文本（时间戳 + 关键指标水位 + pending
// 审批/提问清单 + 运行中会话名/时长/最近进度），一键复制成可传阅摘要；
// 数据全部来自本页既有 computed（审批/提问卡、任务卡、会话卡），零新请求
const message = useMessage()

/** 会话已运行时长（createdAt 由服务端下发 RFC3339；解析失败按未知时长占位） */
function shiftDur(s: SessionCard): string {
  const created = Date.parse(sessionsStore.sessions.find(x => x.id === s.id)?.createdAt || '')
  if (!Number.isFinite(created)) return '—'
  const min = Math.max(0, Math.floor((Date.now() - created) / 60_000))
  if (min < 1) return t('monitor.shift.durLt1m')
  const h = Math.floor(min / 60)
  if (h < 1) return t('monitor.shift.durM', { m: min })
  return t('monitor.shift.durHM', { h, m: min % 60 })
}

function buildShiftSummary(): string {
  const running = sessionCards.value.filter(s => s.running)
  // 任务水位不计已失效卡（P-20261004-31）：归属已死只是清账未达，不算「运行中」
  const taskTotal = taskCards.value.filter(c => c.status === 'running' && !c.invalid).length +
    (globalTaskCard.value ? 1 : 0)
  const lines: string[] = [
    t('monitor.shift.heading', { time: new Date().toLocaleString() }),
    t('monitor.shift.watermark', {
      sessions: running.length,
      tasks: taskTotal,
      approvals: approvalCards.value.length,
      asks: askCards.value.length,
    }),
    t('monitor.shift.approvals', { n: approvalCards.value.length }),
  ]
  if (approvalCards.value.length === 0) {
    lines.push(t('monitor.shift.none'))
  } else {
    approvalCards.value.forEach((a, i) => {
      const sess = approvalSessionName(a.sessionId)
      lines.push(`${i + 1}. [${agentLabel(a.agent)}] ${a.op}${a.target ? ` ${maskApprovalSecrets(a.target)}` : ''}${sess ? ` · ${sess}` : ''}`)
    })
  }
  lines.push(t('monitor.shift.asks', { n: askCards.value.length }))
  if (askCards.value.length === 0) {
    lines.push(t('monitor.shift.none'))
  } else {
    askCards.value.forEach((a, i) => {
      const sess = askSessionName(a.terminalId)
      lines.push(`${i + 1}. ${a.question}${sess ? ` · ${sess}` : ''}`)
    })
  }
  lines.push(t('monitor.shift.sessions', { n: running.length }))
  if (running.length === 0) {
    lines.push(t('monitor.shift.none'))
  } else {
    for (const [i, s] of running.entries()) {
      const proj = s.projectName ? t('monitor.shift.sessProj', { name: s.projectName }) : ''
      lines.push(`${i + 1}. ${s.name}${proj ? ` ${proj}` : ''} · ${t('monitor.shift.durLabel', { dur: shiftDur(s) })} · ${t('monitor.shift.lastActivity', { time: s.activityText || '—' })}`)
      // 最近进度：该会话归属的运行中任务步骤（无归属任务不进摘要）
      const step = taskCards.value.find(c => c.id === s.id && c.status === 'running')?.step
      if (step) lines.push(t('monitor.shift.currentStep', { step }))
    }
  }
  return lines.join('\n')
}

async function copyShiftSummary(): Promise<void> {
  const ok = await copyText(buildShiftSummary())
  if (ok) message.success(t('monitor.shift.copied'))
  else message.error(t('common.copyFailed'))
}

// ============== 值班交接包（P-20261005-148） ==============
// 摘要（P-8）之上的结构化升级面：markdown 交接文档（在跑会话/待裁决审批/
// 待回答提问/当日日报/热力图今日格）+ 双出口（复制 / 24h 片段分享短链）。
// 弹窗自包含（数据装配/分享/结果渲染全在组件内），本页只持开合
const showHandover = ref(false)
</script>

<template>
  <div class="mon-root">
    <header class="mon-head">
      <div class="mon-head-title">
        <!-- 页头图标随目的地 nav 注册表（P-20261022-2）：monitor=TvOutline（盯屏/大屏），
             与首页工具条/命令面板入口同图；SpeedometerOutline 归还「仪表盘」专用 -->
        <n-icon
          size="18"
          class="mon-head-icon"
        >
          <TvOutline />
        </n-icon>
        <h1 class="mon-head-text">
          {{ t('monitorBoard.title') }}
        </h1>
        <span class="mon-head-sub">{{ t('monitorBoard.subtitle') }}</span>
      </div>
      <div class="mon-head-actions">
        <!-- 卡片布局编辑开关（P-20261004-18）：编辑模式（会话态）下类目块可拖拽
             重排、可按类目显隐；布局本体落 uiState monitorBoard 持久，编辑态
             本身不落盘（值守大屏刷新后应回到查看态） -->
        <button
          class="mon-btn"
          :class="{ 'is-active': editing }"
          data-testid="monitor-edit-toggle"
          :aria-pressed="editing ? 'true' : 'false'"
          :title="t(editing ? 'monitorBoard.layout.editActiveTitle' : 'monitorBoard.layout.editTitle')"
          @click="editing = !editing"
        >
          <n-icon
            size="14"
            class="mon-btn-icon"
          >
            <OptionsOutline />
          </n-icon>
        </button>
        <!-- 轮播模式（P-20261005-166）：挂墙值守自动循环关键区块，开启出现间隔
             档位与暂停注记；三类控件同挂 mon-carousel-ctl——编排操作豁免交互
             暂停（否则开启即被自己的点击暂停，死循环） -->
        <button
          class="mon-btn mon-carousel-ctl"
          :class="{ 'is-active': carouselOn }"
          data-testid="monitor-carousel-toggle"
          :aria-pressed="carouselOn ? 'true' : 'false'"
          :title="t('monitorBoard.carousel.toggleTitle')"
          @click="toggleCarousel"
        >
          <n-icon
            size="14"
            class="mon-btn-icon"
          >
            <PlaySkipForwardOutline />
          </n-icon>
        </button>
        <select
          v-if="carouselOn"
          v-model.number="carouselIntervalSec"
          class="mon-carousel-interval mon-carousel-ctl"
          data-testid="monitor-carousel-interval"
          :title="t('monitorBoard.carousel.intervalTitle')"
        >
          <option
            v-for="s in MONITOR_CAROUSEL_INTERVALS"
            :key="s"
            :value="s"
          >
            {{ s }}s
          </option>
        </select>
        <span
          v-if="carouselPaused"
          class="mon-carousel-paused mon-carousel-ctl"
          data-testid="monitor-carousel-paused"
        >{{ t('monitorBoard.carousel.paused') }}</span>
        <!-- 交接班摘要（P-20261003-8）：一键聚合复制，接管成手从逐卡扫读变一段可传阅摘要 -->
        <n-button
          size="tiny"
          quaternary
          class="mon-head-shift"
          :title="t('monitor.shift.buttonTitle')"
          @click="copyShiftSummary"
        >
          {{ t('monitor.shift.button') }}
        </n-button>
        <!-- 值班交接包（P-20261005-148）：markdown 交接文档 + 复制/24h 分享双出口，
             接手人视角补齐（进行时快照 + 静态快照注记） -->
        <n-button
          size="tiny"
          quaternary
          class="mon-head-handover"
          data-testid="monitor-handover-btn"
          :title="t('handover.buttonTitle')"
          @click="showHandover = true"
        >
          {{ t('handover.button') }}
        </n-button>
        <n-button
          size="tiny"
          quaternary
          :title="t('recording.history')"
          @click="openRecording()"
        >
          {{ t('recording.history') }}
        </n-button>
        <span
          v-if="refreshedAt"
          class="mon-updated"
        >{{ t('monitorBoard.refreshedAt', { time: refreshedAt }) }}</span>
        <button
          class="mon-btn"
          :title="t('monitorBoard.refreshTitle')"
          @click="refreshAll"
        >
          <n-icon
            size="14"
            :class="{ spinning: refreshing }"
          >
            <RefreshOutline />
          </n-icon>
        </button>
        <button
          class="mon-btn"
          :title="t('monitorBoard.back')"
          @click="router.push({ name: 'home' })"
        >
          <n-icon size="14">
            <ArrowBackOutline />
          </n-icon>
        </button>
      </div>
    </header>

    <!-- 「需注意」分诊条（P-20261005-164）：四类异常信号第一眼聚合，全零整行
         隐藏（组件内自判）；点击 chip 滚动定位到对应类目区，告警 chip 开通知
         中心（App 层单实例跨路由可用） -->
    <AttentionTriageBar @locate="locateAttentionTarget" />

    <main
      ref="wallRef"
      class="mon-wall"
      :aria-label="t('monitorBoard.title')"
    >
      <!-- 实例级四卡固定区（P-20261003-28/37/125/232）：实例级事实与机群此刻
           活动无关，isEmpty 守卫之外常显；固定区不参与类目排序/显隐（编辑模式
           仅标注，无操作件） -->
      <section
        class="mon-cat is-fixed"
        :class="{ 'is-editing': editing, 'is-carousel-focus': carouselFocusId === 'instance' }"
        data-testid="monitor-cat-instance"
      >
        <header
          v-if="editing"
          class="mon-cat-head is-static"
        >
          <span class="mon-cat-title">{{ t('monitorBoard.layout.catInstance') }}</span>
          <span class="mon-cat-note">{{ t('monitorBoard.layout.instanceFixedTip') }}</span>
        </header>
        <div class="mon-cat-grid">
          <!-- 实例健康卡（P-20261003-28）：metrics 自省四项（uptime/heap/goroutines/
               wsClients），自带 30s 轮询 + refreshAll 同步刷新；实例健康与机群活动
               无关，故置于 isEmpty 守卫之外——空闲空态时同样常显 -->
          <InstanceHealthCard ref="healthCardRef" />
          <!-- 实例活动热力图卡（P-20261003-37）：近一季度每日事实序列色阶（悬停
               显当日提交/会话/命令明细）；实例级序列与机群此刻活动无关，同样置于
               isEmpty 守卫之外常显 -->
          <ActivityHeatmapCard ref="activityCardRef" />
          <!-- 联邦活动热力卡（P-20261004-98）：多实例负载对比——各注册实例近
               14 天迷你热力行 + 活跃度汇总值，点击行沿实例切换链跳详情；单实例
               序列与机群此刻活动无关，同样置于 isEmpty 守卫之外常显 -->
          <FederationActivityCard ref="federationCardRef" />
          <!-- 跨实例通知卡（P-20261003-125）：值班大屏「通知区」——fleet 各实例
               未读/异常水位与离线标记速览，点击开聚合弹层看明细；实例级事实与
               机群此刻活动无关，同样置于 isEmpty 守卫之外常显 -->
          <FleetNotifyCard
            ref="fleetNotifyCardRef"
            @open="showFleetNotify = true"
          />
          <!-- 跨项目实时变更流卡（P-20261003-232）：「刚刚发生了什么」——file.changed
               跨项目聚合时间线（项目徽标+文件+相对时间，2s 窗去抖分批）；实例级
               事实与机群此刻活动无关，同样置于 isEmpty 守卫之外常显 -->
          <ChangeStreamCard ref="changeStreamCardRef" />
          <!-- agent 协作流卡（P-20261008-6）：「agent 间正在发生什么」——定向消息/
               接续链三事件的时间线 + 链健康侧栏（纯事件驱动零轮询，挂载回填链清单
               一次）；协作事实与机群此刻活动无关，同样置于 isEmpty 守卫之外常显 -->
          <AgentCollabStreamCard ref="collabCardRef" />
        </div>
      </section>
      <!-- 编辑模式提示条：操作方式 + 防漏看护栏语义一眼可知（可发现性） -->
      <div
        v-if="editing"
        class="mon-edit-hint"
        data-testid="monitor-edit-hint"
      >
        {{ t('monitorBoard.layout.editHint') }}
      </div>
      <!-- 活动卡类目区（P-20261004-18）：查看态只渲染常驻 + 临时置顶类目（类目
           头仅临时置顶块出现，日常观感同历史纯卡流）；编辑态全类目罗列（隐藏项
           占位可恢复）。机群空闲但编辑中同样渲染（空类目可排序/显隐） -->
      <template v-if="!isEmpty || editing">
        <section
          v-for="cat in renderedCats"
          :key="cat.id"
          class="mon-cat"
          :class="{
            'is-editing': editing,
            'is-hidden-cat': cat.hidden && editing,
            'is-temp': cat.temp,
            'is-drop-target': overCatId === cat.id && dragCatId !== cat.id,
            'is-attention-focus': attentionFocusCat === cat.id,
            'is-carousel-focus': carouselFocusId === cat.id,
          }"
          :data-testid="`monitor-cat-${cat.id}`"
          @dragover="onCatDragOver(cat.id, $event)"
          @dragleave="onCatDragLeave(cat.id)"
          @drop.prevent="onCatDrop(cat.id)"
        >
          <!-- 类目头：编辑模式 = 拖拽把柄 + 显隐开关（dragstart 只打在头上，卡面
               交互不受影响）；查看模式仅临时置顶块出现注记头（防漏看） -->
          <header
            v-if="editing || cat.temp"
            class="mon-cat-head"
            :class="{ 'is-draggable': editing, 'is-dragging': dragCatId === cat.id }"
            :draggable="editing"
            :data-testid="`monitor-cat-head-${cat.id}`"
            @dragstart="onCatDragStart(cat.id, $event)"
            @dragend="onCatDragEnd"
          >
            <n-icon
              v-if="editing"
              size="12"
              class="mon-cat-grip"
            >
              <ReorderTwoOutline />
            </n-icon>
            <span class="mon-cat-title">{{ t(cat.labelKey) }}</span>
            <span class="mon-cat-count">{{ t('monitorBoard.layout.catCount', { n: cat.count }) }}</span>
            <span
              v-if="cat.temp"
              class="mon-cat-flag is-temp"
            >{{ t('monitorBoard.layout.tempShown') }}</span>
            <span
              v-else-if="cat.hidden && editing"
              class="mon-cat-flag is-hidden"
            >{{ t('monitorBoard.layout.catHidden') }}</span>
            <button
              v-if="editing"
              class="mon-cat-eye"
              :data-testid="`monitor-cat-eye-${cat.id}`"
              :title="t(cat.hidden ? 'monitorBoard.layout.showCat' : 'monitorBoard.layout.hideCat')"
              @click="board.toggleCardHidden(cat.id)"
            >
              <n-icon size="13">
                <EyeOffOutline v-if="cat.hidden" />
                <EyeOutline v-else />
              </n-icon>
            </button>
          </header>
          <div class="mon-cat-grid">
            <template v-if="cat.id === 'fleet'">
              <!-- 编队聚合卡（P-20261005-145）：批量发起后的聚合盯盘面——批内 N/M/K
                   计数一屏可读，失败批红边高亮；点卡头展开成员行，行点击直达会话
                   （jumpToSession 既有链）。内置序在首位：编队是其它卡的分组视图，
                   先看整体再逐个处理 -->
              <article
                v-for="b in fleetBatchCards"
                :key="`fleet-${b.batchId}`"
                class="mon-card is-fleet"
                :class="{ 'is-failed': b.failed > 0, 'is-highlight': b.batchId === highlightFleetId }"
                :data-fleet-card="b.batchId"
                :data-testid="`fleet-card-${b.batchId}`"
                :title="t('monitorBoard.fleetExpandTip')"
                @click="toggleFleetExpand(b.batchId)"
              >
                <div class="mon-card-head">
                  <span
                    class="mon-dot"
                    :class="b.running > 0 ? 'is-running' : (b.failed > 0 ? 'is-failed' : 'is-idle')"
                  />
                  <span class="mon-card-kind">{{ t('monitorBoard.cardFleet') }}</span>
                  <span
                    class="mon-badge"
                    :title="b.name"
                  >{{ b.name }}</span>
                  <span
                    class="mon-status"
                    :class="{ 'is-failed': b.failed > 0 }"
                    data-testid="fleet-card-counts"
                  >{{ t('monitorBoard.fleetCounts', { done: b.done, failed: b.failed, running: b.running }) }}</span>
                </div>
                <!-- 成员行（展开态）：roster 全量（含已关闭成员，只读不可跳）；
                     行内状态点/状态字与任务卡同色语言 -->
                <ul
                  v-if="expandedFleets.has(b.batchId)"
                  class="mon-fleet-members"
                  data-testid="fleet-members"
                  @click.stop
                >
                  <li
                    v-for="m in b.members"
                    :key="m.id"
                    class="mon-fleet-member"
                    :class="{ 'is-failed': m.status === 'failed', 'is-gone': !m.live, 'is-clickable': m.live }"
                    :title="m.live ? m.id : t('monitorBoard.fleetMemberGone')"
                    @click="jumpFleetMember(m)"
                  >
                    <span
                      class="mon-dot"
                      :class="m.status === 'running' ? 'is-running' : (m.status === 'failed' ? 'is-failed' : 'is-idle')"
                    />
                    <span class="mon-fleet-member-name">{{ m.name || t('monitorBoard.unknownSession') }}</span>
                    <span class="mon-fleet-member-status">{{ taskStatusLabel(m.status) }}</span>
                  </li>
                </ul>
                <div
                  v-if="b.launchedAt && Number.isFinite(Date.parse(b.launchedAt))"
                  class="mon-task-meta"
                >
                  {{ relTime(Date.parse(b.launchedAt)) }}
                </div>
              </article>
            </template>
            <template v-else-if="cat.id === 'approvals'">
              <!-- 首触说明条（P-20261003-311）：与全局卡堆同款同标记键（共用
                   ApprovalGuideBar），大屏审批卡首触同三行说明；占满类目块整行 -->
              <ApprovalGuideBar
                v-if="approvalCards.length > 0"
                class="mon-guide"
              />
              <!-- 模式自学习建议条（P-20261006-28）：与全局卡堆同款同节流，
                   大屏裁决也是模式数据面；组件内部 v-if 兜底 -->
              <ApprovalRuleSuggestBar
                :suggestion="ruleSuggestion"
                class="mon-guide"
              />
              <!-- 审批卡：最急迫的裁决排最前（等最久的优先） -->
              <article
                v-for="a in approvalCards"
                :key="`aprv-${a.id}`"
                class="mon-card is-approval"
              >
                <div class="mon-card-head">
                  <span class="mon-dot is-approval" />
                  <span class="mon-card-kind">{{ t('agentTerminal.approvalTitle') }}</span>
                  <span
                    class="mon-badge"
                    :title="a.agent || ''"
                  >{{ agentLabel(a.agent) }}</span>
                  <span
                    v-if="approvalSessionName(a.sessionId)"
                    class="mon-badge"
                  >{{ approvalSessionName(a.sessionId) }}</span>
                  <!-- 合并审批「+N 同型待批」（P-20261006-26）：主卡挂起队列徽标
                       ——大屏一屏扫读不展开（裁决动作与全局卡堆同链，整批同效），
                       悬停 title 列全量 target 作细控核对出口 -->
                  <span
                    v-if="a.merged?.length"
                    class="mon-badge is-merged"
                    data-test="mon-aprv-merged"
                    :title="a.merged.map(m => maskApprovalSecrets(m.target ?? '')).join('\n')"
                  >+{{ a.merged.length }} {{ t('approval.merged.badge') }}</span>
                  <n-button
                    size="tiny"
                    quaternary
                    class="mon-approval-rec"
                    :title="t('recording.viewProcess')"
                    @click="openRecording(a.id)"
                  >
                    {{ t('recording.viewProcess') }}
                  </n-button>
                </div>
                <div class="mon-approval-op">
                  {{ a.op }}
                  <span
                    v-if="a.target"
                    class="mon-approval-target"
                    :title="maskApprovalSecrets(a.target)"
                  >{{ maskApprovalSecrets(a.target) }}</span>
                </div>
                <!-- impact 结构化徽标行（P-20261003-319）：与大屏审批卡同源速读（kind
                     徽标 + 一句话 summary + 文件计数）；detail 呈现保持原样——大屏以
                     一屏扫读为主，不引入折叠交互 -->
                <div
                  v-if="a.impact"
                  class="mon-approval-impact"
                  data-test="mon-approval-impact"
                >
                  <span class="mon-impact-kind">{{ t('approval.impact.kind.' + a.impact.kind) }}</span>
                  <span
                    class="mon-impact-summary"
                    :title="maskApprovalSecrets(a.impact.summary)"
                  >{{ maskApprovalSecrets(a.impact.summary) }}</span>
                  <span
                    v-if="a.impact.filesCount !== undefined"
                    class="mon-impact-count"
                  >{{ t('approval.impact.filesCount', { n: a.impact.filesCount }) }}</span>
                </div>
                <div
                  v-if="a.detail"
                  class="mon-approval-detail"
                >
                  {{ maskApprovalSecrets(a.detail) }}
                </div>
                <div class="mon-approval-actions">
                  <n-button
                    size="tiny"
                    quaternary
                    @click="decide(a.id, false)"
                  >
                    {{ t('agentTerminal.approvalDeny') }}
                  </n-button>
                  <!-- 放行时限三选一（P-20261003-316，P-20261002-126 升级）：与全局
                       卡片堆同链路同组件，档位弹层明示各自作用面（切全局审批档位落盘，
                       误触即静默放开安全面）。z-index 抬过审批卡堆锚点（3000，见
                       ApprovalCards 同处注释） -->
                  <approval-tier-popover @apply="(h) => decide(a.id, true, false, '', h)">
                    <n-button
                      size="tiny"
                      secondary
                      type="warning"
                    >
                      {{ t('agentTerminal.approvalAlways') }}
                    </n-button>
                  </approval-tier-popover>
                  <n-button
                    size="tiny"
                    type="primary"
                    @click="decide(a.id, true)"
                  >
                    {{ t('agentTerminal.approvalAllow') }}
                  </n-button>
                </div>
              </article>
            </template>
            <template v-else-if="cat.id === 'asks'">
              <!-- 提问卡：紧随审批卡（同为等待用户输入的即时项，等最久的优先） -->
              <article
                v-for="a in askCards"
                :key="`ask-${a.id}`"
                class="mon-card is-ask"
              >
                <div class="mon-card-head">
                  <span class="mon-dot is-ask" />
                  <span class="mon-card-kind">{{ t('ops.ask.title') }}</span>
                  <span
                    class="mon-badge"
                    :title="a.agent || ''"
                  >{{ askAgentLabel(a.agent) }}</span>
                  <span
                    v-if="askSessionName(a.terminalId)"
                    class="mon-badge"
                  >{{ askSessionName(a.terminalId) }}</span>
                </div>
                <div class="mon-ask-question">
                  {{ a.question }}
                </div>
                <!-- 选项形态：按钮即答案 -->
                <div
                  v-if="a.options && a.options.length > 0"
                  class="mon-ask-options"
                >
                  <n-button
                    v-for="opt in a.options"
                    :key="opt"
                    size="tiny"
                    type="primary"
                    secondary
                    @click="answerText(a.id, opt)"
                  >
                    {{ opt }}
                  </n-button>
                </div>
                <!-- 自由文本形态：输入 + 提交 -->
                <div
                  v-else
                  class="mon-ask-input-row"
                >
                  <n-input
                    v-model:value="askDrafts[a.id]"
                    size="small"
                    :placeholder="t('ops.ask.placeholder')"
                    @keydown.enter.prevent="submitAskDraft(a)"
                  />
                  <n-button
                    size="tiny"
                    type="primary"
                    :disabled="!(askDrafts[a.id] || '').trim()"
                    @click="submitAskDraft(a)"
                  >
                    {{ t('ops.ask.submit') }}
                  </n-button>
                </div>
              </article>
            </template>
            <template v-else-if="cat.id === 'tasks'">
              <!-- 任务进度卡：会话归属（bySession）+ 无归属全局兜底，最新在前 -->
              <article
                v-for="c in (globalTaskCard ? [globalTaskCard, ...taskCards] : taskCards)"
                :key="`task-${c.id}`"
                class="mon-card is-task"
                :class="[`is-${c.status}`, { 'is-invalid': c.invalid }]"
                :title="c.id === '__global__' ? '' : c.id"
              >
                <div class="mon-card-head">
                  <span
                    class="mon-dot"
                    :class="[c.status === 'failed' ? 'is-failed' : 'is-running', { 'is-stale': c.stale, 'is-invalid': c.invalid }]"
                  />
                  <span class="mon-card-kind">{{ t('monitorBoard.cardTasks') }}</span>
                  <span
                    v-if="c.id !== '__global__'"
                    class="mon-badge"
                    :title="c.sessionName || c.id"
                  >{{ c.sessionName || t('monitorBoard.unknownSession') }}</span>
                  <!-- 远程来源徽标（P-20261004-131）：联邦派发回流条目标实例名，来源一眼可辨 -->
                  <span
                    v-if="c.remoteInstance"
                    class="mon-badge is-remote-badge"
                    :title="t('monitorBoard.remoteTaskTip', { instance: c.remoteInstance })"
                  >{{ c.remoteInstance }}</span>
                  <!-- 失联弱预警（P-20261003-303）：running 超时无上报，弱化样式不弹窗 -->
                  <span
                    v-if="c.stale"
                    class="mon-badge is-stale-badge"
                    :title="t('monitorBoard.taskStaleTip')"
                  >{{ t('monitorBoard.taskStale') }}</span>
                  <!-- 已失效过渡（P-20261004-31）：归属会话已不在会话表，清账快照未达前置灰防误导 -->
                  <span
                    v-if="c.invalid"
                    class="mon-badge is-invalid-badge"
                    :title="t('monitorBoard.taskInvalidTip')"
                  >{{ t('monitorBoard.taskInvalid') }}</span>
                  <span
                    class="mon-status"
                    :class="[`is-${c.status}`, { 'is-stale': c.stale, 'is-invalid': c.invalid }]"
                  >{{ taskStatusLabel(c.status) }}</span>
                </div>
                <div
                  v-if="c.task"
                  class="mon-task-text"
                >
                  {{ c.task }}
                </div>
                <div
                  v-if="c.step"
                  class="mon-task-step"
                >
                  {{ c.step }}
                </div>
                <!-- 步骤清单（P-20261004-7）：完成项划线、当前项（step 指针对应）高亮；
                     高度封顶滚动防长计划撑爆卡片墙 -->
                <ul
                  v-if="c.steps.length > 0"
                  class="mon-task-steps"
                >
                  <li
                    v-for="(s, i) in c.steps"
                    :key="i"
                    class="mon-task-step-item"
                    :class="{ 'is-done': s.done, 'is-current': !s.done && s.name === c.step }"
                  >
                    <span class="mon-task-step-mark">{{ s.done ? '✓' : '○' }}</span>
                    <span class="mon-task-step-name">{{ s.name }}</span>
                  </li>
                </ul>
                <div class="mon-task-meta">
                  {{ relTime(c.updatedAt) }}<template v-if="c.steps.length > 0"> · {{ t('monitorBoard.taskSteps', { done: c.steps.filter(s => s.done).length, total: c.steps.length }) }}</template>
                </div>
              </article>
            </template>
            <template v-else-if="cat.id === 'sessions'">
              <!-- 终端会话卡：在线状态 + 最近活动一屏尽览；静默弱标 + 点击跳会话（P-20261003-53） -->
              <article
                v-for="s in sessionCards"
                :key="`sess-${s.id}`"
                class="mon-card is-session"
                :title="sessCardTitle(s)"
                @click="jumpSession(s)"
              >
                <div class="mon-card-head">
                  <span
                    class="mon-dot"
                    :class="s.running ? 'is-running' : 'is-idle'"
                  />
                  <span class="mon-card-kind">{{ t('monitorBoard.cardSessions') }}</span>
                  <span class="mon-badge">{{ s.kind === 'agent' ? t('monitorBoard.kindAgent') : t('monitorBoard.kindShell') }}</span>
                </div>
                <div class="mon-sess-name">
                  {{ s.name }}
                </div>
                <div
                  v-if="s.projectName"
                  class="mon-sess-proj"
                >
                  {{ s.projectName }}
                </div>
                <div class="mon-task-meta">
                  {{ s.running ? t('monitorBoard.statusRunning') : s.activityText }}
                  <span
                    v-if="s.badge.n > 0"
                    class="mon-sess-idle"
                    :class="{ 'is-stall': s.badge.stall }"
                    :title="t(s.badge.tip)"
                    @click="onSessBadgeClick(s, $event)"
                  >{{ t(s.badge.badge, { n: s.badge.n }) }}</span>
                </div>
              </article>
            </template>
          </div>
        </section>
      </template>
      <div
        v-if="isEmpty && !editing"
        class="mon-empty"
      >
        <n-icon
          size="28"
          class="mon-empty-icon"
        >
          <TvOutline />
        </n-icon>
        <span>{{ t('monitorBoard.allClear') }}</span>
      </div>
    </main>
    <!-- 审批过程实况浏览（P-20261001-15）：值班大屏的审批历史承载入口 -->
    <RecordingBrowser
      v-model:show="showRecording"
      :focus-approval-id="recordingApprovalId"
    />
    <!-- 值班交接包弹窗（P-20261005-148）：自包含弹层，本页只持开合 -->
    <HandoverPackageModal
      v-model:show="showHandover"
    />
    <!-- 跨实例通知聚合弹层（P-20261003-125）：通知卡/卡片联动入口，本页自宿主 -->
    <InstanceNotifyOverview
      :show="showFleetNotify"
      @update:show="(v: boolean) => showFleetNotify = v"
    />
  </div>
</template>

<style scoped>
.mon-root {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  color: var(--text-primary);
}

/* ============== 头部 ============== */
.mon-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-panel);
  flex-shrink: 0;
}
.mon-head-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mon-head-icon { color: var(--accent-blue); flex-shrink: 0; }
.mon-head-text {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}
.mon-head-sub { font-size: 12px; color: var(--text-muted); }
.mon-head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.mon-updated { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
.mon-btn {
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: 1px solid var(--border-default);
  border-radius: 6px; background: transparent; color: var(--text-secondary);
  cursor: pointer; padding: 0;
}
.mon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
/* 布局编辑开关激活态（P-20261004-18）：蓝描边常亮——开关态一眼可辨（用户
 * 需要随时知道自己是否还在编辑态） */
.mon-btn.is-active { color: var(--accent-blue); border-color: var(--accent-blue); }

/* 轮播间隔档位（P-20261005-166）：开关开启时出现的原生 select，mon-btn 同
   尺寸同描边语言（主题变量自适应）；10s/20s/60s 单位字符无 i18n 必要 */
.mon-carousel-interval {
  height: 26px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 0 2px;
  cursor: pointer;
}
.mon-carousel-interval:hover { color: var(--text-primary); }
/* 交互暂停注记（P-20261005-166）：橙调弱徽标——有人在操作、轮换已让位的
   状态反馈，色语言与「临时置顶」护栏同源（--accent-orange） */
.mon-carousel-paused {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 4px;
  line-height: 1.6;
  color: var(--accent-orange);
  border: 1px solid color-mix(in srgb, var(--accent-orange) 55%, transparent);
  white-space: nowrap;
}

/* ============== 卡片墙：类目块纵向堆叠（P-20261004-18），块内响应式
 * 两/三列（窄屏自动降为单列）。查看态类目块无饰边，卡流观感与历史一致 */
.mon-wall {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 24px 24px;
}
.mon-cat {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  /* 分诊条定位滚动（P-20261005-164）：sticky 分诊行约 40px，scrollIntoView
     落点预留其高度防目标类目区顶缘被盖住（分诊行缺席时仅多 48px 头部余量） */
  scroll-margin-top: 48px;
}
.mon-cat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
  align-content: start;
}
/* 编辑模式：类目块虚线框 + 内边距（把柄/开关的容器感），拖拽落点蓝框反馈 */
.mon-cat.is-editing {
  border: 1px dashed var(--border-default);
  border-radius: 10px;
  padding: 10px 12px;
}
.mon-cat.is-editing.is-drop-target { border-color: var(--accent-blue); }
.mon-cat.is-hidden-cat { opacity: 0.55; }
/* 定位/轮播高亮（P-20261005-164 分诊条定位 + P-20261005-166 轮播当前幕）：
   蓝描边一圈静态强调，同一视觉语言单源——「这里是要看的落点」；静态不闪动
   （prefers-reduced-motion 友好；与编队卡 is-highlight 同语言）。分诊定位
   1.6s 自愈，轮播高亮持续到下一幕、关停清除 */
.mon-cat.is-attention-focus,
.mon-cat.is-carousel-focus {
  border-radius: 10px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-blue) 35%, transparent);
}
/* 临时置顶块（P-20261004-18 防漏看护栏）：警示橙描边 + 浅底，静态高亮不闪动
   （prefers-reduced-motion 友好；持续到待处理项清账自然退场） */
.mon-cat.is-temp {
  border: 1px solid color-mix(in srgb, var(--accent-orange) 55%, transparent);
  border-left-width: 3px;
  border-radius: 10px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--accent-orange) 7%, transparent);
}
.mon-cat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}
.mon-cat-title { font-weight: 600; color: var(--text-primary); flex-shrink: 0; }
.mon-cat-count { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
.mon-cat-note { font-size: 11px; color: var(--text-muted); }
.mon-cat-grip { color: var(--text-muted); flex-shrink: 0; }
.mon-cat-head.is-static .mon-cat-title { color: var(--text-secondary); font-weight: 500; }
/* 拖拽把柄（整条类目头可拖）：grab 光标 + hover 反馈；拖动中源半透明
   （活动栏 rail-dragging 同款语言） */
.mon-cat-head.is-draggable {
  cursor: grab;
  padding: 2px 6px;
  margin: -2px -6px;
  border-radius: 6px;
  user-select: none;
}
.mon-cat-head.is-draggable:hover { background: var(--bg-hover); }
.mon-cat-head.is-dragging { opacity: 0.4; }
/* 临时置顶/已隐藏注记徽标（注记语义：为什么这块出现在这里 / 为什么是灰的） */
.mon-cat-flag {
  flex-shrink: 0;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 4px;
  line-height: 1.6;
}
.mon-cat-flag.is-temp {
  color: var(--accent-orange);
  border: 1px solid color-mix(in srgb, var(--accent-orange) 55%, transparent);
}
.mon-cat-flag.is-hidden {
  color: var(--text-muted);
  border: 1px solid var(--border-default);
}
.mon-cat-eye {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: auto;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
}
.mon-cat-eye:hover { background: var(--bg-hover); color: var(--text-primary); }
/* 编辑模式提示条：一句话讲清操作与护栏语义 */
.mon-edit-hint {
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-panel);
  border: 1px dashed var(--border-default);
  border-radius: 8px;
  padding: 8px 12px;
}
.mon-card {
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  box-shadow: var(--shadow-soft);
}
/* 首触说明条（P-20261003-311）：在类目块网格里占满整行（其余卡各占一格） */
.mon-guide { grid-column: 1 / -1; }
.mon-card.is-approval { border-color: var(--status-waiting); border-left-width: 3px; }
.mon-card.is-ask { border-color: var(--accent-blue); border-left-width: 3px; }
.mon-card.is-task.is-failed { border-color: var(--status-failed); border-left-width: 3px; }
.mon-card.is-task.is-done { opacity: 0.72; }

/* ============== 编队聚合卡（P-20261005-145） ============== */
/* 整卡可点展开/收起成员行；失败批红边高亮（与失败任务卡同色语言） */
.mon-card.is-fleet { cursor: pointer; transition: border-color var(--motion-base); }
.mon-card.is-fleet:hover { border-color: var(--accent-blue); }
.mon-card.is-fleet.is-failed { border-color: var(--status-failed); border-left-width: 3px; }
/* 通知直达定位高亮：描边脉冲一次的静态强调（持续高亮直到离开页面，
   值守回扫时定位语义仍在） */
.mon-card.is-fleet.is-highlight { border-color: var(--accent-blue); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-blue) 35%, transparent); }
.is-fleet .mon-badge { max-width: 45%; }
.is-fleet .mon-status.is-failed { color: var(--status-failed); }
.mon-fleet-members {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column; gap: 2px;
  max-height: 180px; overflow-y: auto; flex-shrink: 0;
}
.mon-fleet-member {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  font-size: 12px; padding: 2px 4px; border-radius: 4px;
}
.mon-fleet-member.is-clickable { cursor: pointer; }
.mon-fleet-member.is-clickable:hover { background: var(--bg-hover); }
.mon-fleet-member.is-failed .mon-fleet-member-name { color: var(--status-failed); }
/* 已关闭成员：整行弱化（事实仍在册，落点已消失） */
.mon-fleet-member.is-gone { opacity: 0.55; }
.mon-fleet-member-name {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-primary);
}
.mon-fleet-member-status { flex-shrink: 0; color: var(--text-secondary); }
.mon-fleet-member.is-failed .mon-fleet-member-status { color: var(--status-failed); }

/* ============== 卡片公共件 ============== */
.mon-card-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.mon-card-kind { font-size: 11px; font-weight: 600; color: var(--text-muted); flex-shrink: 0; }
.mon-badge {
  font-size: 11px; line-height: 1.5; color: var(--text-secondary);
  background: var(--bg-hover); border-radius: 4px; padding: 0 6px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.is-approval .mon-badge { color: var(--text-secondary); border: 1px solid var(--status-waiting); background: transparent; }
.is-ask .mon-badge { color: var(--text-secondary); border: 1px solid var(--accent-blue); background: transparent; }
/* 合并审批「+N 同型待批」徽标（P-20261006-26）：排队量是裁决知情面——等待色
 * 描边弱样式（stale-badge 同族语言），flex-shrink:0 防长 target 挤缩数字 */
.mon-badge.is-merged {
  color: var(--status-waiting);
  border: 1px solid color-mix(in srgb, var(--status-waiting) 55%, transparent);
  background: transparent;
  flex-shrink: 0;
}
.mon-status { margin-left: auto; flex-shrink: 0; font-size: 11px; color: var(--text-secondary); }
.mon-status.is-running { color: var(--status-running); }
.mon-status.is-failed { color: var(--status-failed); }
/* 失联弱预警（P-20261003-303）：运行中但超时无上报——运行色转警示黄、停呼吸
 * （呼吸环=「活着」的信号，失联态继续脉动即假阳性），徽标弱样式不弹窗 */
.mon-status.is-running.is-stale { color: var(--status-waiting); }
.mon-badge.is-stale-badge {
  color: var(--status-waiting);
  border: 1px solid color-mix(in srgb, var(--status-waiting) 55%, transparent);
  background: transparent;
  flex-shrink: 0;
}
/* 远程来源徽标（P-20261004-131）：联邦派发回流条目标实例名——来源标注区分
 * 本地/远程（实例名快照 + 蓝描边弱样式），hover 提示派发来源语义 */
.mon-badge.is-remote-badge {
  color: var(--accent-blue);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 45%, transparent);
  background: transparent;
  flex-shrink: 0;
  max-width: 40%;
}
/* 已失效过渡（P-20261004-31）：归属会话已关而清账快照未达——整卡置灰
 * （灰点停呼吸 + 状态字灰化 + 弱徽标），快照对账一到即随 prune 消失 */
.mon-card.is-task.is-invalid { opacity: 0.6; }
.mon-status.is-running.is-invalid { color: var(--text-muted); }
.mon-badge.is-invalid-badge {
  color: var(--text-muted);
  border: 1px solid var(--border-default);
  background: transparent;
  flex-shrink: 0;
}

.mon-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--text-muted);
}
.mon-dot.is-running { background: var(--status-running); animation: mon-pulse 1.6s ease-in-out infinite; }
.mon-dot.is-failed { background: var(--status-failed); }
.mon-dot.is-running.is-stale { background: var(--status-waiting); animation: none; opacity: 0.75; }
.mon-dot.is-running.is-invalid { background: var(--text-muted); animation: none; opacity: 0.5; }
.mon-dot.is-approval { background: var(--status-waiting); animation: mon-pulse 1.2s ease-in-out infinite; }
.mon-dot.is-ask { background: var(--accent-blue); animation: mon-pulse 1.2s ease-in-out infinite; }
.mon-dot.is-idle { background: var(--text-muted); }
@keyframes mon-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .mon-dot.is-running, .mon-dot.is-approval, .mon-dot.is-ask { animation: none; }
}

/* ============== 审批卡内容 ============== */
.mon-approval-op {
  font-size: 13px; color: var(--text-primary); font-family: var(--font-mono);
  word-break: break-all; display: flex; gap: 6px; align-items: baseline; min-width: 0;
}
.mon-approval-target {
  color: var(--text-muted); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mon-approval-detail { font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
/* impact 结构化徽标行（P-20261003-319）：kind 徽标描边与审批卡警示色同源，
   summary 单行省略（大屏卡片宽度有限，悬停看全文） */
.mon-approval-impact { margin-top: 2px; display: flex; align-items: center; gap: 6px; min-width: 0; }
.mon-impact-kind {
  flex-shrink: 0; font-size: 11px; color: var(--text-primary);
  border: 1px solid var(--status-waiting); border-radius: 4px; padding: 0 6px;
}
.mon-impact-summary {
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mon-impact-count {
  flex-shrink: 0; font-size: 11px; color: var(--text-secondary);
  border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0 6px;
}
.mon-approval-actions { margin-top: auto; display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }

/* ============== 提问卡内容 ============== */
.mon-ask-question {
  font-size: 13px; color: var(--text-primary); line-height: 1.5;
  word-break: break-word; white-space: pre-wrap;
}
.mon-ask-options {
  display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end;
  margin-top: auto; padding-top: 4px;
}
.mon-ask-input-row {
  display: flex; gap: 6px; align-items: center;
  margin-top: auto; padding-top: 4px;
}

/* ============== 任务卡内容 ============== */
.mon-task-text {
  font-size: 14px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mon-task-step {
  font-size: 12px; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 步骤清单（P-20261004-7）：完成项划线弱化、当前项进行中档强调（step 指针对应） */
.mon-task-steps {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column; gap: 2px;
  max-height: 140px; overflow-y: auto; flex-shrink: 0;
}
.mon-task-step-item {
  display: flex; align-items: baseline; gap: 6px; min-width: 0;
  font-size: 12px; color: var(--text-secondary);
}
.mon-task-step-item.is-done { color: var(--text-muted); }
.mon-task-step-item.is-done .mon-task-step-name { text-decoration: line-through; }
.mon-task-step-item.is-current { color: var(--status-running); }
.mon-task-step-mark { flex-shrink: 0; font-family: var(--font-mono); }
.mon-task-step-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-task-meta { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }

/* ============== 会话卡内容 ============== */
.mon-sess-name {
  font-size: 14px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mon-sess-proj { font-size: 12px; color: var(--text-tertiary); }
/* 会话静默弱标（P-20261003-53）：灰调小徽标不弹窗；整卡可点跳会话，hover 反馈。
   停滞强标档（P-20261004-37）：警示橙描边升级 + 指针可点开分诊卡（弱标保持
   卡片跳转语义不拦截） */
.mon-sess-idle {
  margin-left: 6px; font-size: 11px; padding: 0 4px; border-radius: 2px;
  background: color-mix(in srgb, var(--text-dim) 12%, transparent); color: var(--text-dim);
  white-space: nowrap;
}
.mon-sess-idle.is-stall {
  cursor: pointer;
  color: var(--status-waiting);
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--status-waiting) 55%, transparent);
}
.mon-sess-idle.is-stall:hover { background: color-mix(in srgb, var(--status-waiting) 12%, transparent); }
.mon-card.is-session { cursor: pointer; transition: border-color var(--motion-base); }
.mon-card.is-session:hover { border-color: var(--accent-blue); }

/* ============== 空态 ============== */
.mon-empty {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 80px 0; color: var(--text-muted); font-size: 13px;
}
.mon-empty-icon { color: var(--text-muted); opacity: 0.6; }
</style>
