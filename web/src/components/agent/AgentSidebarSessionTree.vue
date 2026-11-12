<script setup lang="ts">
import { computed, onMounted, provide, ref } from 'vue'
import { NDropdown, NIcon, NInput } from 'naive-ui'
import { ChatboxEllipsesOutline, ChevronDownOutline, ChevronForwardOutline, FolderOutline, LockClosedOutline, PulseOutline, TerminalOutline, WarningOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { agentLabelOf } from '../../composables/useApprovalActions'
import BrandIcon from '../common/BrandIcon.vue'
import type { AgentTermSession } from '../../composables/useAgentTerminal'
import { relativeTimeParts } from '../../utils/relative-time'
import { sessionBadgeDecision } from '../../utils/session-idle'
import { formatSessionActivityShort, formatSessionCreatedAt, isNewAgentSession } from '../../utils/sessionIdentity'
import { sessionShellIntDetected } from '../../utils/session-shellint'
import { isSessionInLockedProject } from '../../utils/projectLockedSession'
import { useAgentSidebarDnd } from '../../composables/useAgentSidebarDnd'
import type { ProjectGroupItem } from '../../composables/useAgentSidebarDnd'
import { useAgentQueueStore } from '../../stores/agentQueue'
import { useAssistantTaskStore } from '../../stores/assistantTask'
import { useStallTriageStore } from '../../stores/stallTriage'
import { sessionWorkingDir } from '../../stores/terminal-sessions'
import { useApprovalsStore } from '../../stores/approvals'
import { useProjectStore } from '../../stores/project'
import AgentSidebarProjectTree from './AgentSidebarProjectTree.vue'
import AgentSidebarBatchBar from './AgentSidebarBatchBar.vue'
import AgentSessionQueuePanel from './AgentSessionQueuePanel.vue'
import { sidebarTreeSharedKey } from './agentSidebarTreeShared'

/**
 * 智能体侧栏会话树（P-20261001-20 从 AgentTerminalSidebar 拆出）：
 * 项目分组树（AgentSidebarProjectTree 子组件）/ 未分组会话 / 自定义分组三个
 * 列表区 + 右键菜单 + 双击内联重命名 + 多选批操作栏。
 * 列表数据（筛选结果）由宿主传入；折叠/顺序等持久化语义经事件上抛；
 * 跨列表区共享的拖拽/内联重命名状态经 provide/inject 下发给项目树子组件。
 * 按 runtime 分组视图（P-20261003-238）：runtimeGroups 非空时改渲染运行时组段
 * （替换未分组+自定义分组两区；项目树照常——项目维度与运行时维度不双渲染）。
 */
const props = defineProps<{
  /** 系统会话全量（重命名路由与多选有效性按它判定） */
  sessions: AgentTermSession[]
  /** 自定义分组（原始数据：组内会话寻址 / 移动目标 / 组名回显） */
  groups: { id: string; name: string; sessionIds: string[] }[]
  /** 项目分组树（原始，拖拽落点计算用） */
  projectGroups: ProjectGroupItem[]
  /** 筛选后的三个列表区（即时筛选在宿主） */
  filteredProjectGroups: ProjectGroupItem[]
  filteredRootSessions: AgentTermSession[]
  filteredNamedGroups: { id: string; name: string; sessionIds: string[] }[]
  /** runtime 分组视图开关（宿主持有；true = 渲染运行时组段，平铺两区让位——
   *  显式开关而非以 runtimeGroups 非空推断：过滤清空全部会话时组段归零但
   *  视图仍在，回落平铺结构会闪出自定义分组框架） */
  runtimeView?: boolean
  /** runtime 分组投影（宿主已按筛选收窄；与 runtimeView 配套） */
  runtimeGroups?: { key: string; sessions: AgentTermSession[] }[]
  activeId: string
  /** 当前右侧渲染中的会话 id（agent 或被接管的项目会话） */
  selectedId?: string
  /** 会话粒度运行态（OSC 133，统一 store 写入） */
  runningMap?: Record<string, boolean>
  /** 会话未读新输出（P-20261003-310，统一 store 写入）：会话行名字前小圆点 */
  unreadMap?: Record<string, boolean>
  /** 会话最近活动时间戳（OSC 133，tooltip 展示用） */
  activityMap?: Record<string, number>
  /** 项目分组折叠集合（透传项目树子组件） */
  collapsedProjects?: Set<string>
  /** 自定义分组折叠集合（P-20261111-1-S1，宿主持有并持久化；缺省 = 全展开） */
  collapsedGroups?: Set<string>
  /** 会话 id → 项目相对 dir（「在文件树中定位」可用性；无条目 = 不可定位置灰） */
  locateDirs?: Record<string, string>
  /** 直通输入持权中的会话 id → 持权投影（P-20261024-1，宿主投影自
   *  useDirectInputShares 15s 轮询）：会话行橙点徽标 + 右键「收回访客输入」
   *  项的数据面——「谁在输入」的 owner 侧常驻可见性 */
  directHolds?: Record<string, { nick?: string; visitorTail?: string }>
  /** 直播中会话 id → 徽标 title（P-20261106-7，宿主投影自
   *  useTerminalShareActions.liveTitles——与底部终端 tab 红点同数据源同文案）：
   *  会话行红点呼吸徽标 + 右键「直播分享/结束直播」文案翻转的数据面；缺条目
   *  = 未直播。有效期过滤在投影侧已做，这里只读在否 */
  liveTitles?: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  /** 接管项目会话到管理页 */
  (e: 'attach-project', id: string): void
  /** 项目分组折叠切换 */
  (e: 'toggle-project', projectId: string): void
  /** 自定义分组折叠切换（P-20261111-1-S1，持久化语义在宿主） */
  (e: 'toggle-group', groupId: string): void
  /** 共存提示行点击切回平铺视图（P-20261111-1-S3）：视图开关在宿主，本组件
   *  只上抛意图（宿主 emit update:groupMode 'flat'） */
  (e: 'exit-runtime-view'): void
  /** 项目分组右键菜单：新建项目会话 / 打开项目 */
  (e: 'project-action', payload: { projectId: string; key: 'create-session' | 'open' }): void
  /** 项目会话右键菜单：在文件树中定位 / 结束会话（确认由宿主承担） */
  (e: 'project-session-action', payload: { sessionId: string; key: 'destroy' | 'locate-tree' }): void
  /** 会话行「在文件树中定位」（解析与派发在宿主，P-20261002-125） */
  (e: 'locate-tree', sessionId: string): void
  /** 会话行「交叉审查」（源会话选定与弹层在宿主，P-20261003-6） */
  (e: 'cross-review', sessionId: string): void
  /** 会话行「完成后接续…」（链定义弹层在宿主，P-20261004-38） */
  (e: 'chain-continue', sessionId: string): void
  /** 会话行「标记审阅基线」（API 调用与反馈在宿主，P-20261003-217） */
  (e: 'review-mark', sessionId: string): void
  /** 会话行「标记/取消敏感」（API 调用与反馈在宿主，P-20261003-155） */
  (e: 'toggle-sensitive', sessionId: string): void
  /** 会话行「收回访客输入」（P-20261024-1）：直通持权在场才出菜单项，
   *  API 调用与反馈在宿主（本组件只上抛会话 id） */
  (e: 'direct-revoke', sessionId: string): void
  /** 会话行能力四件（P-20261106-7 双入口纪律）：直播分享/冻结分享/分享回放/
   *  导出输出——动作实现收口 useTerminalShareActions（与底部终端 tab 右键
   *  同一实现），本组件只上抛会话 id 与能力键；项目树行的同族项经本事件合流 */
  (e: 'capability-action', payload: { sessionId: string; key: 'liveShare' | 'frozenShare' | 'replayShare' | 'exportOutput' }): void
  /** 会话行「重新发起」（P-20261003-146）：宿主解析源会话并以 initialPrompt
   *  预填新建对话框（预填组装在宿主 openNewDialog，本组件只上抛 id） */
  (e: 'relaunch', sessionId: string): void
  /** 会话行「复盘报告」（P-20261004-60）：宿主写 postmortem store 打开 App 层
   *  复盘弹层（本组件只上抛 id） */
  (e: 'postmortem', sessionId: string): void
  /** name 直传 = 双击内联重命名；缺省 = 宿主走输入对话框。
   *  kill = 显式终结外部接管会话（P-20261005-189，仅外部会话出此菜单项，
   *  二次确认由宿主承担） */
  (e: 'session-action', payload: { sessionId: string; key: 'rename' | 'destroy' | 'kill' | `move:${string}` | 'move:__root__'; name?: string }): void
  /** 项目会话重命名（双击内联；项目会话不经 session-action 的分组语义） */
  (e: 'rename-project', payload: { sessionId: string; name: string }): void
  (e: 'group-action', payload: { key: 'create' | `rename:${string}` | `delete:${string}`; name?: string }): void
  /** 拖拽语义（顺序由宿主写入 uiState 持久化） */
  (e: 'reorder-groups', orderedIds: string[]): void
  (e: 'reorder-group-sessions', payload: { groupId: string; orderedIds: string[] }): void
  (e: 'move-session', payload: { sessionId: string; toGroupId: string | '__root__' }): void
  /** 项目分组拖拽：组序 / 组内会话序 */
  (e: 'reorder-project-groups', orderedIds: string[]): void
  (e: 'reorder-project-sessions', payload: { projectId: string; orderedIds: string[] }): void
  /** 多选批操作 */
  (e: 'batch-move', payload: { sessionIds: string[]; toGroupId: string | '__root__' }): void
  (e: 'batch-destroy', sessionIds: string[]): void
}>()

const { t } = useI18n()

// ============== 排队指令（P-20261003-248）：会话行入口 + 内联面板 ==============
// 数据面在 agentQueue store（服务端为事实源，回执驱动自动发送）；这里只管
// 行内入口的展开/收起（手风琴：同时至多展开一个面板）与首次挂载拉取
const queueStore = useAgentQueueStore()
// pending 审批归属（P-20261003-198）：静默标特化「等待裁决」的判定源（直接读
// 全局 store——与排队 store 同款组件内直用，不经 props 逐层下发）
const approvals = useApprovalsStore()
// 停滞判据的任务侧数据源（P-20261004-37：bySession 归属状态+上报时刻）与
// 分诊卡打开入口（卡本体挂 App 层，这里只写目标会话 id）
const taskStore = useAssistantTaskStore()
const stallTriage = useStallTriageStore()
// 项目硬锁徽标（P-20261004-143）的判定数据面：agent 会话免项目绑定，dir 是否
// 落锁内项目按会话工作目录包含判定（isSessionInLockedProject 收口）；锁态由
// project store 的 projects.changed 订阅保鲜（锁定即现、解锁即摘）。
// queue/approvals/task 同款组件内直用 store，不经 props 逐层下发
const projectStore = useProjectStore()
function isLockedSession(s: AgentTermSession): boolean {
  return isSessionInLockedProject(s, projectStore.projects)
}
const queueOpenId = ref('')
function toggleQueue(id: string): void {
  queueOpenId.value = queueOpenId.value === id ? '' : id
}
function queueCount(id: string): number {
  return queueStore.countFor(id)
}
onMounted(() => {
  if (!queueStore.loaded) void queueStore.refreshAll()
})

// ============== 拖拽排序/移动（useAgentSidebarDnd，顺序上抛宿主持久化） ==============
const {
  dragOverKey,
  startDrag,
  onDragOverGroupHead, onDragOverRootHead, onDragOverSessionItem,
  onDragOverGroupSection, onDragOverRootSection,
  onDragOverProjectGroupHead, onDragOverProjectGroupSection, onDragOverProjectSessionItem,
  onDropGroupHead, onDropRootHead, onDropSessionItem,
  onDropProjectGroupHead, onDropProjectSessionItem,
  onDragEnd,
} = useAgentSidebarDnd(props, emit)

// ============== 会话双击内联重命名（系统 + 项目会话，与分组双击同款交互） ==============
const renamingSessionId = ref('')
const renamingSessionName = ref('')
function startRenameSession(id: string, current: string) {
  renamingSessionId.value = id
  renamingSessionName.value = current
}
function confirmRenameSession() {
  const id = renamingSessionId.value
  const name = renamingSessionName.value.trim()
  renamingSessionId.value = ''
  if (!id || !name) return
  if (props.sessions.some(ss => ss.id === id)) {
    emit('session-action', { sessionId: id, key: 'rename', name })
  } else {
    emit('rename-project', { sessionId: id, name })
  }
}

/** 行标档位决策（P-20261004-37 共用纯函数）：停滞强标 / 弱标 / pending 特化
 *  三档判据与文案键同源。读 taskStore.nowTick 登记心跳依赖——停滞分钟数随
 *  30s 心跳随时间重算（agent 死后无人再写 store，无 tick 标永不点亮） */
function badgeDecision(id: string) {
  void taskStore.nowTick
  const p = taskStore.bySession[id]
  return sessionBadgeDecision({
    taskRunning: p?.status === 'running',
    running: props.runningMap?.[id],
    lastActivity: props.activityMap?.[id],
    lastReportAt: p?.updatedAt,
    hasPendingApproval: approvals.pendingSessionIds.has(id),
  })
}
/** 行标文案（空串 = 不显示；停滞强标/弱标共用行内同一位） */
function idleBadge(id: string): string {
  const d = badgeDecision(id)
  return d.n > 0 ? t(d.badge, { n: d.n }) : ''
}
/** 行标 hover 提示文案（经共享上下文下发项目树行同款展示） */
function idleTip(id: string): string {
  return t(badgeDecision(id).tip)
}
/** 停滞强标在否（警示档样式 + 可点的判定位） */
function isStallBadge(id: string): boolean {
  return badgeDecision(id).stall
}
/** 行标点击：停滞强标开分诊卡（截停不让行选中）；弱标不拦截冒泡——
 *  与既有「点击行选中」行为一致 */
function onIdleBadgeClick(id: string, e: MouseEvent): void {
  if (!isStallBadge(id)) return
  e.stopPropagation()
  stallTriage.openSession(id)
}

/** runtime 分组视图在否（宿主显式开关） */
const rtView = computed(() => props.runtimeView === true)
/** 平铺呈现的自定义分组区（runtime 视图下置空让位，v-for 与视图开关不解耦） */
const flatNamedGroups = computed(() => (rtView.value ? [] : props.filteredNamedGroups))

/** 自定义分组折叠在否（P-20261111-1-S1）：集合由宿主持有并持久化（collapsedProjects
 *  同款读写上抛形态），本组件只读投影 */
function isGroupCollapsed(groupId: string): boolean {
  return props.collapsedGroups?.has(groupId) ?? false
}

/** 行 tooltip：基础提示 + 会话 ID + 创建时间 + 运行时版本 + shell 集成检测行
 *  + 最近活动相对时间（有活动记录时）+ 静默 hover 提示。ID 行（P-20261004-123）：
 *  terminalId 已是协作协议的地址（agent 收件箱/接续链/ui.snapshot 归属/任务
 *  进度跳转全用它），悬停可见是核对「这个 ID 是谁」的最轻出口（复制出口在
 *  终端 tab 右键）。创建时间行（P-20261023-3）：同名会话（含派生步进名「·2」）
 *  谁新谁旧的第一判据。版本（P-20261003-134）是预检顺取的 --version 输出
 *  首行原文（如「2.1.3 (Claude Code)」），本身自描述、locale 无关，故不套
 *  t()；旧会话/纯 shell/自定义命令豁免链无值 → 不追加（空显不虚构）。shell
 *  集成行（P-20261004-90）恒显：命令历史/空闲提示/退出码装饰/git 面板自刷新
 *  整族功能依赖 OSC 133，「这个会话有没有集成」一行可诊断（判定滞后=诚实
 *  呈现，见 sessionShellIntDetected） */
function itemTitle(id: string, base: string, runtimeVersion?: string): string {
  let title = base
  title += `\n${t('agentTerminal.sessionId')}: ${id}`
  const created = props.sessions.find(ss => ss.id === id)?.createdAt
  if (created) {
    const d = new Date(created)
    if (!Number.isNaN(d.getTime())) title += `\n${t('agentTerminal.createdAt')}: ${d.toLocaleString()}`
  }
  if (runtimeVersion) title += `\n${runtimeVersion}`
  title += `\n${t(shellIntDetected(id) ? 'agentTerminal.shellIntOn' : 'agentTerminal.shellIntOff')}`
  const ts = props.activityMap?.[id]
  if (ts) {
    const p = relativeTimeParts(ts)
    title += `\n${t('agentTerminal.lastActivity')}: ${t(`agentTerminal.${p.key}`, { n: p.n })}`
  }
  if (badgeDecision(id).n > 0) title += `\n${t(badgeDecision(id).tip)}`
  return title
}

// ============== 会话身份行内面（P-20261023-3）：时间弱灰字 + 新/接续徽标 ==============
// 同名消歧的呈现侧：派生链服务端步进（「·2」）给了不同名，行内创建时间给
// 「谁新谁旧」第二维度，「新/接续」徽标给「新建 ≠ 复用」的界面承诺。
// 判据/格式收口 utils/sessionIdentity 纯函数（单测守门），此处只装配
/** 行内创建时间短格式（今日 HH:mm / 今年 MM-DD / 跨年全量）；不可解析不渲染 */
function createdText(s: AgentTermSession): string {
  return formatSessionCreatedAt(s.createdAt)
}
/** 行内创建时间完整值（tooltip 用，本地时区全量） */
function createdFull(s: AgentTermSession): string {
  if (!s.createdAt) return ''
  const d = new Date(s.createdAt)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}
/** 行内最近活动短段（「3分/2时」）：运行态不显示（脉冲点 + 静默/停滞徽标族
 *  已覆盖活跃呈现，「3分」对正在跑的会话是噪音）；「刚刚」不占行宽 */
function activityShort(id: string): string {
  if (props.runningMap?.[id] === true) return ''
  return formatSessionActivityShort(props.activityMap?.[id])
}
/** 「新」徽标：24h 内创建且尚无 OSC 命令活动（判据细节见 sessionIdentity） */
function isNewSession(s: AgentTermSession): boolean {
  return isNewAgentSession({
    createdAt: s.createdAt,
    resumed: s.resumed,
    hasActivity: props.activityMap?.[s.id] !== undefined,
  })
}
/** 「接续」徽标：恢复旗标（--resume）创建——继承槽位旧名的会话，与新会话
 *  同名歧义的第二区分维度（与「新」互斥不叠加） */
function isResumedSession(s: AgentTermSession): boolean {
  return s.resumed === true
}

// 跨列表区共享状态下发项目树子组件（同一次拖拽会话 / 同一编辑态）
provide(sidebarTreeSharedKey, {
  dragOverKey,
  startDrag,
  onDragOverProjectGroupHead, onDragOverProjectGroupSection, onDragOverProjectSessionItem,
  onDropProjectGroupHead, onDropProjectSessionItem,
  onDragEnd,
  renamingSessionId, renamingSessionName,
  startRenameSession, confirmRenameSession,
  itemTitle, idleBadge, idleTip, isStallBadge, onIdleBadgeClick,
})

// 会话运行指示：统一 store 的运行态（OSC 133 由持有连接的宿主写入）
function isRunning(s: AgentTermSession): boolean {
  return props.runningMap?.[s.id] === true
}

/** shell 集成检测（P-20261004-90）：tooltip 检测行与未检测弱灰图标共用同一位。
 *  判定即数据（utils/session-shellint 纯函数，两 map 查键）——行渲染随 C/D/E
 *  写入重算，量级 = 会话行数 × 两次查键，无额外订阅 */
function shellIntDetected(id: string): boolean {
  return sessionShellIntDetected(props.runningMap, props.activityMap, id)
}

/** cwd 归属标签（B2）：会话工作目录的尾段目录名（多为 worktree 目录名），
 *  多会话并行/多 worktree 场景下区分会话归属；空目录与用户主目录不显示。
 *  按实时 cwd（P-20261004-59 OSC 7 追踪 currentDir，无帧回落创建 dir）——
 *  agent cd 进子目录后标签跟随，与 worktree 驻留徽标同口径不错挂 */
function cwdTag(s: AgentTermSession): string {
  const p = sessionWorkingDir(s).split('\\').join('/')
  if (!p) return ''
  const segs = p.split('/').filter(Boolean)
  return segs[segs.length - 1] ?? ''
}

function sessionsOf(groupId: string): AgentTermSession[] {
  const g = props.groups.find(gg => gg.id === groupId)
  if (!g) return []
  const byId = new Map(props.sessions.map(s => [s.id, s]))
  return g.sessionIds.map(id => byId.get(id)).filter((s): s is AgentTermSession => !!s)
}

// ============== runtime 分组视图（P-20261003-238）：组头标签与品牌图标 ==============
// 标签走 agentLabelOf 既有运行时显示名映射（审批卡/提问卡/通知 runtime chips
// 同一口径，品牌名不随 locale 翻译——「i18n 双语」对本面 = 与全应用同源而非
// 另造翻译表）；图标只认 BrandIcon 登记键（claude/dsh/custom），shell 用
// 未分组区同款终端图标，其余（codex/自定义/未登记）走 custom 兜底图形不告警
function runtimeLabel(key: string): string {
  return agentLabelOf(key, key)
}
function runtimeBrand(key: string): 'claude' | 'dsh' | 'custom' | null {
  if (key === 'claude' || key === 'dsh') return key
  if (key === 'shell') return null
  return 'custom'
}

// ============== 会话右键菜单（系统会话） ==============
const menuSessionId = ref('')
const menuX = ref(0)
const menuY = ref(0)
function openSessionMenu(s: AgentTermSession, e: MouseEvent) {
  menuSessionId.value = s.id
  menuX.value = e.clientX
  menuY.value = e.clientY
}
const menuOptions = computed(() => {
  const moveTargets = props.groups.map(g => ({
    label: `${t('agentTerminal.moveToGroup')}「${g.name}」`,
    key: `move:${g.id}`,
  }))
  const inGroup = props.groups.some(g => g.sessionIds.includes(menuSessionId.value))
  // 敏感标记态（P-20261003-155）：菜单文案按当前值翻转（标记/取消）
  const menuSensitive = props.sessions.find(s => s.id === menuSessionId.value)?.sensitive === true
  const opts: Array<{ label: string; key: string; disabled?: boolean } | { type: 'divider'; key: string }> = [
    { label: t('agentTerminal.rename'), key: 'rename' },
    // 在文件树中定位（P-20261002-125）：会话 dir 不在当前项目内（含无当前项目）
    // 时无解析值 → 置灰
    { label: t('terminal.locate.inTree'), key: 'locate-tree', disabled: props.locateDirs?.[menuSessionId.value] === undefined },
    // 重新发起（P-20261003-146）：取创建时 initialPrompt 预填新建对话框——
    // 长会话跑废/上下文用尽后带着原任务指令再起一条。无记录（无 prompt 创建/
    // 旧会话）同样可用：预填退化为 dir/runtime，指令留空
    { label: t('agentTerminal.relaunch'), key: 'relaunch' },
    // 复盘报告（P-20261004-60）：聚合退出码/末命令/输出尾部的只读弹层——
    // 异常退出会话的「为什么挂」就地可查，活会话同样可查（产出快照语义）
    { label: t('agentTerminal.postmortem'), key: 'postmortem' },
    // 交叉审查（P-20261003-6）：产出交另一 runtime 审查；无产出也可发起
    // （审查会话自行核查工作区，组合式按无清单组装 prompt）
    { label: t('review.cross.action'), key: 'cross-review' },
    // 完成后接续（P-20261004-38）：本会话终态命中时自动拉起下一棒（事件触发的
    // 串行接力；链定义在弹层填写，服务端三道节制闸把关）
    { label: t('agentchain.menuAction'), key: 'chain-continue' },
    // 标记审阅基线（P-20261003-217）：本轮改动审完打标记，产出视图可切换
    // diff 范围到该标记，下轮审阅从新基线算
    { label: t('agentTerminal.markBaseline'), key: 'review-mark' },
    // 能力四件（P-20261106-7 双入口纪律）：与底部终端 tab 右键同款同序——直播
    // 分享（按锚点态翻转「结束直播」）/ 分享输出快照 / 分享回放 / 导出输出。
    // 本列表只收 manager 存活会话（退出即摘行），故不设禁用态；能力锚定
    // TerminalID（会话级），agent/tmux 持久会话 detached 态四项同样可用
    // ——导出走服务端会话层 CaptureScrollback 链，不依赖本页 pane 挂载
    { label: t(props.liveTitles?.[menuSessionId.value] ? 'terminal.endLiveShare' : 'terminal.liveShare'), key: 'liveShare' },
    { label: t('terminal.frozenShare'), key: 'frozenShare' },
    { label: t('terminal.shareReplay'), key: 'replayShare' },
    { label: t('terminal.exportOutput'), key: 'exportOutput' },
    // 敏感标记（P-20261003-155）：人工策展的安全标注，导出/分享出域命中时
    // 要求二次确认——文案按当前标记态翻转
    { label: t(menuSensitive ? 'terminal.unmarkSensitive' : 'terminal.markSensitive'), key: 'mark-sensitive' },
    // 收回访客输入（P-20261024-1）：直通持权在场才出（菜单项与暴露面一致，
    // 无持权不出现空收回）——「谁在输入」的即时回收位
    ...(props.directHolds?.[menuSessionId.value]
      ? [{ label: t('terminal.revokeDirectInput'), key: 'direct-revoke' }]
      : []),
    ...moveTargets,
  ]
  if (inGroup) opts.push({ label: t('agentTerminal.moveToRoot'), key: 'move:__root__' })
  opts.push({ type: 'divider', key: 'd1' })
  // close 语义分流（P-20261005-189）：外部接管会话「结束」=解除接管（文案
  // 区分），并追加显式 kill 入口——不可逆动作单独成项，二次确认在宿主
  const menuExternal = props.sessions.find(ss => ss.id === menuSessionId.value)?.origin === 'external'
  if (menuExternal) {
    opts.push({ label: t('agentTerminal.external.release'), key: 'destroy' })
    opts.push({ label: t('agentTerminal.external.kill'), key: 'kill' })
  } else {
    opts.push({ label: t('agentTerminal.destroy'), key: 'destroy' })
  }
  return opts
})
function onSessionMenu(key: string) {
  const id = menuSessionId.value
  menuSessionId.value = ''
  if (key === 'locate-tree') {
    emit('locate-tree', id)
    return
  }
  if (key === 'relaunch') {
    emit('relaunch', id)
    return
  }
  if (key === 'postmortem') {
    emit('postmortem', id)
    return
  }
  if (key === 'cross-review') {
    emit('cross-review', id)
    return
  }
  if (key === 'chain-continue') {
    emit('chain-continue', id)
    return
  }
  if (key === 'review-mark') {
    emit('review-mark', id)
    return
  }
  if (key === 'mark-sensitive') {
    emit('toggle-sensitive', id)
    return
  }
  if (key === 'direct-revoke') {
    emit('direct-revoke', id)
    return
  }
  // 能力四件（P-20261106-7）：动作键与底部终端 tab 菜单同词汇表，宿主接线
  // useTerminalShareActions
  if (key === 'liveShare' || key === 'frozenShare' || key === 'replayShare' || key === 'exportOutput') {
    emit('capability-action', { sessionId: id, key })
    return
  }
  emit('session-action', {
    sessionId: id,
    key: key as 'rename' | 'destroy' | 'kill' | `move:${string}` | 'move:__root__',
  })
}

// ============== 分组重命名（内联输入） ==============
const renamingGroupId = ref('')
const renamingName = ref('')
function startRenameGroup(groupId: string, current: string) {
  renamingGroupId.value = groupId
  renamingName.value = current
}
function confirmRenameGroup() {
  if (renamingGroupId.value && renamingName.value.trim()) {
    emit('group-action', { key: `rename:${renamingGroupId.value}`, name: renamingName.value.trim() })
  }
  renamingGroupId.value = ''
}
const groupMenuOptions = [
  { label: t('common.edit'), key: 'rename' },
  { label: t('common.delete'), key: 'delete' },
]
function onGroupMenu(groupId: string, key: string) {
  if (key === 'rename') {
    const g = props.groups.find(gg => gg.id === groupId)
    startRenameGroup(groupId, g?.name || '')
  } else {
    emit('group-action', { key: `delete:${groupId}` as `delete:${string}` })
  }
}

// ============== 多选批操作（仅系统会话；Ctrl/Cmd+点选切换，普通点击清空） ==============
const selectedIds = ref(new Set<string>())
/** 过滤已消亡的会话（外部销毁后不参与计数与操作） */
const validSelectedIds = computed(() =>
  [...selectedIds.value].filter(id => props.sessions.some(ss => ss.id === id)))
function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}
function onAgentItemClick(s: AgentTermSession, e: MouseEvent) {
  if (e.ctrlKey || e.metaKey) {
    toggleSelect(s.id)
    return
  }
  if (selectedIds.value.size) selectedIds.value = new Set()
  emit('select', s.id)
}
function clearSelection() {
  selectedIds.value = new Set()
}
function emitBatchMove(toGroupId: string | '__root__') {
  const ids = validSelectedIds.value
  if (!ids.length) return
  emit('batch-move', { sessionIds: ids, toGroupId })
  clearSelection()
}
function emitBatchDestroy() {
  const ids = validSelectedIds.value
  if (!ids.length) return
  emit('batch-destroy', ids)
  clearSelection()
}
</script>

<template>
  <!-- 项目分组树（子组件：可折叠；组头右键/拖拽排序；拖拽/重命名状态共享） -->
  <AgentSidebarProjectTree
    :project-groups="filteredProjectGroups"
    :selected-id="selectedId"
    :collapsed-projects="collapsedProjects"
    :locate-dirs="locateDirs"
    :live-titles="liveTitles"
    @attach-project="(id) => emit('attach-project', id)"
    @toggle-project="(projectId) => emit('toggle-project', projectId)"
    @project-action="(payload) => emit('project-action', payload)"
    @project-session-action="(payload) => emit('project-session-action', payload)"
    @capability-action="(payload) => emit('capability-action', payload)"
  />

  <!-- 按 runtime 分组视图（P-20261003-238）：组段替换未分组+自定义分组两区
       （项目树照常在上——项目维度与运行时维度互斥呈现，会话行不双渲染）。
       组头 = 运行时显示名 + 计数徽标，展示投影无重命名/菜单/拖拽语义（「会话
       归属哪类」由运行时决定，拖移无从谈起）；组内行交互与未分组区同款
       （点选/多选/内联重命名/右键/排队面板），仅去掉拖拽（本视图无合法落点）。
       行模板块与未分组区有意保持同构——抽行组件需跨 provide/inject 与拖拽
       上下文重接线，收口留给行组件专项重构 -->
  <template v-if="rtView">
    <!-- 共存提示（P-20261111-1-S3）：runtime 视图下自定义分组整区让位
         （flatNamedGroups 置空），有分组的用户难辨「组空了」还是「组没了」——
         弱提示行只计数不渲染组内容（不引入双渲染红线），点击切回平铺。
         计数取 filteredNamedGroups（宿主按名称/时间/runtime 筛选收窄后的
         平铺可见集）=「切回去你会看到几个组」，与过滤语义一致不虚报 -->
    <button
      v-if="filteredNamedGroups.length > 0"
      type="button"
      class="ats-rt-groups-hint"
      data-test="session-runtime-groups-hint"
      @click.stop="emit('exit-runtime-view')"
    >
      {{ t('agentTerminal.runtimeGroupsHidden', { n: filteredNamedGroups.length }) }}
    </button>
    <div
      v-for="g in runtimeGroups"
      :key="`rt:${g.key}`"
      class="ats-section"
      data-test="session-runtime-group"
    >
      <div
        class="ats-group-head"
        data-test="session-runtime-group-head"
        :data-runtime="g.key"
      >
        <BrandIcon
          v-if="runtimeBrand(g.key)"
          :name="runtimeBrand(g.key)!"
          :size="12"
        />
        <n-icon
          v-else
          size="12"
        >
          <TerminalOutline />
        </n-icon>
        <span class="ats-group-name">{{ runtimeLabel(g.key) }}</span>
        <span
          class="ats-rt-count"
          data-test="session-runtime-group-count"
        >{{ g.sessions.length }}</span>
      </div>
      <!-- template v-for：行 + 排队面板同循环作用域（同未分组区） -->
      <template
        v-for="s in g.sessions"
        :key="s.id"
      >
        <div
          class="ats-item"
          :class="{ active: s.id === (selectedId || activeId), 'multi-selected': selectedIds.has(s.id) }"
          :title="itemTitle(s.id, s.name, s.runtimeVersion)"
          :data-sc-selection-drop="`session:${s.id}`"
          @click="onAgentItemClick(s, $event)"
          @dblclick.stop="startRenameSession(s.id, s.name)"
          @contextmenu.prevent="openSessionMenu(s, $event)"
        >
          <n-input
            v-if="renamingSessionId === s.id"
            v-model:value="renamingSessionName"
            size="tiny"
            autofocus
            @keyup.enter="confirmRenameSession"
            @blur="confirmRenameSession"
            @click.stop
          />
          <template v-else>
            <span
              v-if="props.unreadMap?.[s.id]"
              class="ats-item-unread"
              :title="t('terminal.tabUnread')"
            />
            <!-- 直通输入徽标（P-20261024-1）：访客持权向该会话输入中——橙点
                 呼吸「谁在输入」常驻可见，右键「收回访客输入」一键回收 -->
            <span
              v-if="props.directHolds?.[s.id]"
              class="ats-item-direct"
              :title="t('terminal.directInputBadgeTitle', { nick: props.directHolds![s.id]!.nick || props.directHolds![s.id]!.visitorTail || '' })"
              data-test="session-direct-badge"
            />
            <!-- 项目硬锁徽标（P-20261004-143）：agent 会话 dir 落锁内项目——
                 API 写族已 403 但本会话 shell 命令不受锁约束（诚实边界提示） -->
            <n-icon
              v-if="isLockedSession(s)"
              class="ats-item-locked"
              size="11"
              :title="t('project.locked.terminalBadgeTitle')"
              data-test="session-locked-badge"
            >
              <LockClosedOutline />
            </n-icon>
            <n-icon
              v-if="s.sensitive"
              class="ats-item-sensitive"
              size="11"
              :title="t('terminal.sensitiveBadgeTip')"
              data-test="session-sensitive-badge"
            >
              <WarningOutline />
            </n-icon>
            <!-- 直播中徽标（P-20261106-7 双入口）：会话有活跃 kind=terminal 锚定
                 即亮红点（与底部终端 tab 徽标同数据源同视觉语），title 携剩余
                 时长/观看数；右键同位「结束直播」一键撤销 -->
            <span
              v-if="props.liveTitles?.[s.id]"
              class="ats-item-live"
              :title="props.liveTitles[s.id]"
              data-test="session-live-badge"
            />
            <span
              class="ats-item-title"
              :title="s.name"
            >{{ s.name }}</span>
          </template>
          <!-- 接续徽标（P-20261023-3）：恢复旗标创建（继承槽位旧名），与「新」
               互斥——「新建 ≠ 复用」的界面承诺 -->
          <span
            v-if="isResumedSession(s)"
            class="ats-item-resumed"
            :title="t('agentTerminal.resumeBadgeTip')"
            data-test="session-resumed-badge"
          >{{ t('agentTerminal.resumeBadge') }}</span>
          <!-- 新徽标（P-20261023-3）：24h 内创建且尚无命令活动 -->
          <span
            v-else-if="isNewSession(s)"
            class="ats-item-new"
            :title="t('agentTerminal.newBadgeTip')"
            data-test="session-new-badge"
          >{{ t('agentTerminal.newBadge') }}</span>
          <!-- 行内时间（P-20261023-3）：创建 + 最近活动弱灰字——同名会话的
               第二区分维度（tooltip 时间升行内可见） -->
          <span
            v-if="createdText(s)"
            class="ats-item-time"
            :title="t('agentTerminal.createdAtTip', { time: createdFull(s) })"
            data-test="session-created-time"
          >{{ createdText(s) }}<template v-if="activityShort(s.id)"> · {{ activityShort(s.id) }}</template></span>
          <!-- shell 集成未检测弱标（P-20261004-90）：弱灰小图标常驻——不弹窗
               不打扰的诚实降级语义，tooltip 交代缺失后果与常见原因；判定滞后
               （新会话未渲染提示符/本浏览器未附着）同判未检测，附着后首个
               OSC 133 帧即消失（判定即数据，零额外改动） -->
          <n-icon
            v-if="!shellIntDetected(s.id)"
            class="ats-item-shellint"
            size="11"
            :title="t('agentTerminal.shellIntOffTip')"
            data-test="session-shellint-missing"
          >
            <PulseOutline />
          </n-icon>
          <span
            v-if="cwdTag(s)"
            class="ats-item-cwd"
            :title="t('agentTerminal.cwdTip', { dir: cwdTag(s) })"
          >{{ cwdTag(s) }}</span>
          <span
            v-if="idleBadge(s.id)"
            class="ats-item-idle"
            :class="{ 'is-stall': isStallBadge(s.id) }"
            :title="idleTip(s.id)"
            @click="onIdleBadgeClick(s.id, $event)"
          >{{ idleBadge(s.id) }}</span>
          <button
            class="ats-item-queue"
            :class="{ 'has-items': queueCount(s.id) > 0 }"
            :title="t('agentTerminal.queue.toggle')"
            data-testid="session-queue-toggle"
            @click.stop="toggleQueue(s.id)"
          >
            <n-icon size="11">
              <ChatboxEllipsesOutline />
            </n-icon>
            <span
              v-if="queueCount(s.id) > 0"
              class="ats-item-queue-count"
            >{{ queueCount(s.id) }}</span>
          </button>
          <span
            v-if="isRunning(s)"
            class="ats-item-dot running"
          />
        </div>
        <AgentSessionQueuePanel
          v-if="queueOpenId === s.id"
          :session-id="s.id"
        />
      </template>
    </div>
  </template>

  <!-- 未分组会话（平铺呈现；runtime 分组视图下让位）。整区落点（P-20261111-1-S2）：
       dragover/drop 挂组段容器——未分组行不是组内插入落点（行层恒拒绝），整区
       承接即全部落点，拖会话归根不再要求精确命中组头窄行；高亮同键挂组段 -->
  <div
    v-if="!rtView && filteredRootSessions.length > 0"
    class="ats-section"
    :class="{ 'ats-drag-over': dragOverKey === '__root__' }"
    @dragover="onDragOverRootSection"
    @drop.prevent="onDropRootHead"
  >
    <div
      class="ats-group-head"
      @dragover="onDragOverRootHead"
      @drop.prevent="onDropRootHead"
    >
      <n-icon size="12">
        <TerminalOutline />
      </n-icon>
      <span>{{ t('agentTerminal.ungrouped') }}</span>
    </div>
    <!-- template v-for：行 + 排队面板（P-20261003-248）同循环作用域——面板是行的
         展开附件，需要在 `s` 可见的兄弟位渲染 -->
    <template
      v-for="s in filteredRootSessions"
      :key="s.id"
    >
      <div
        class="ats-item"
        :class="{ active: s.id === (selectedId || activeId), 'multi-selected': selectedIds.has(s.id) }"
        :title="itemTitle(s.id, s.name, s.runtimeVersion)"
        :data-sc-selection-drop="`session:${s.id}`"
        draggable="true"
        @dragstart="startDrag({ kind: 'session', sessionId: s.id, fromGroupId: '__root__' }, $event)"
        @dragend="onDragEnd"
        @click="onAgentItemClick(s, $event)"
        @dblclick.stop="startRenameSession(s.id, s.name)"
        @contextmenu.prevent="openSessionMenu(s, $event)"
      >
        <n-input
          v-if="renamingSessionId === s.id"
          v-model:value="renamingSessionName"
          size="tiny"
          autofocus
          @keyup.enter="confirmRenameSession"
          @blur="confirmRenameSession"
          @click.stop
        />
        <template v-else>
          <!-- 未读活动点（P-20261003-310）：后台会话有新输出/终态，名字前小圆点，
             点选会话即清（清账在宿主可见登记收口） -->
          <span
            v-if="props.unreadMap?.[s.id]"
            class="ats-item-unread"
            :title="t('terminal.tabUnread')"
          />
          <!-- 直通输入徽标（P-20261024-1）：同 runtime 视图行 -->
          <span
            v-if="props.directHolds?.[s.id]"
            class="ats-item-direct"
            :title="t('terminal.directInputBadgeTitle', { nick: props.directHolds![s.id]!.nick || props.directHolds![s.id]!.visitorTail || '' })"
            data-test="session-direct-badge"
          />
          <!-- 项目硬锁徽标（P-20261004-143）：同 runtime 视图行 -->
          <n-icon
            v-if="isLockedSession(s)"
            class="ats-item-locked"
            size="11"
            :title="t('project.locked.terminalBadgeTitle')"
            data-test="session-locked-badge"
          >
            <LockClosedOutline />
          </n-icon>
          <!-- 敏感角标（P-20261003-155）：同 runtime 视图行 -->
          <n-icon
            v-if="s.sensitive"
            class="ats-item-sensitive"
            size="11"
            :title="t('terminal.sensitiveBadgeTip')"
            data-test="session-sensitive-badge"
          >
            <WarningOutline />
          </n-icon>
          <!-- 直播中徽标（P-20261106-7）：同 runtime 视图行 -->
          <span
            v-if="props.liveTitles?.[s.id]"
            class="ats-item-live"
            :title="props.liveTitles[s.id]"
            data-test="session-live-badge"
          />
          <span
            class="ats-item-title"
            :title="s.name"
          >{{ s.name }}</span>
        </template>
        <!-- 接续/新徽标 + 行内时间（P-20261023-3）：同 runtime 视图行 -->
        <span
          v-if="isResumedSession(s)"
          class="ats-item-resumed"
          :title="t('agentTerminal.resumeBadgeTip')"
          data-test="session-resumed-badge"
        >{{ t('agentTerminal.resumeBadge') }}</span>
        <span
          v-else-if="isNewSession(s)"
          class="ats-item-new"
          :title="t('agentTerminal.newBadgeTip')"
          data-test="session-new-badge"
        >{{ t('agentTerminal.newBadge') }}</span>
        <span
          v-if="createdText(s)"
          class="ats-item-time"
          :title="t('agentTerminal.createdAtTip', { time: createdFull(s) })"
          data-test="session-created-time"
        >{{ createdText(s) }}<template v-if="activityShort(s.id)"> · {{ activityShort(s.id) }}</template></span>
        <!-- shell 集成未检测弱标（P-20261004-90）：同 runtime 视图行 -->
        <n-icon
          v-if="!shellIntDetected(s.id)"
          class="ats-item-shellint"
          size="11"
          :title="t('agentTerminal.shellIntOffTip')"
          data-test="session-shellint-missing"
        >
          <PulseOutline />
        </n-icon>
        <span
          v-if="cwdTag(s)"
          class="ats-item-cwd"
          :title="t('agentTerminal.cwdTip', { dir: cwdTag(s) })"
        >{{ cwdTag(s) }}</span>
        <span
          v-if="idleBadge(s.id)"
          class="ats-item-idle"
          :class="{ 'is-stall': isStallBadge(s.id) }"
          :title="idleTip(s.id)"
          @click="onIdleBadgeClick(s.id, $event)"
        >{{ idleBadge(s.id) }}</span>
        <!-- 排队指令入口（P-20261003-248）：有排队常显计数，无排队 hover 显图标 -->
        <button
          class="ats-item-queue"
          :class="{ 'has-items': queueCount(s.id) > 0 }"
          :title="t('agentTerminal.queue.toggle')"
          data-testid="session-queue-toggle"
          @click.stop="toggleQueue(s.id)"
        >
          <n-icon size="11">
            <ChatboxEllipsesOutline />
          </n-icon>
          <span
            v-if="queueCount(s.id) > 0"
            class="ats-item-queue-count"
          >{{ queueCount(s.id) }}</span>
        </button>
        <span
          v-if="isRunning(s)"
          class="ats-item-dot running"
        />
      </div>
      <!-- 排队指令面板（手风琴，同时至多展开一个） -->
      <AgentSessionQueuePanel
        v-if="queueOpenId === s.id"
        :session-id="s.id"
      />
    </template>
  </div>

  <!-- 分组（平铺呈现；runtime 分组视图下让位——组内会话已按运行时归组展示）。
       整区落点（P-20261111-1-S2）：dragover/drop 上提到组段容器——组头/组内行/
       行间空白都认（内层行 dragover 认领时让位，组源掠过会话行由组段兜底承接
       重排序），体感「无法拖动自由排序」的组头窄行死区消灭；高亮同键挂组段
       （整段组区虚线框，与会话行插入态的行级高亮互斥） -->
  <div
    v-for="g in flatNamedGroups"
    :key="g.id"
    class="ats-section"
    :class="{ 'ats-drag-over': dragOverKey === `group:${g.id}` }"
    @dragover="onDragOverGroupSection(g.id, $event)"
    @drop.prevent="onDropGroupHead(g.id)"
  >
    <div
      class="ats-group-head is-group"
      draggable="true"
      @dragstart="startDrag({ kind: 'group', groupId: g.id }, $event)"
      @dragover="onDragOverGroupHead(g.id, $event)"
      @drop.prevent="onDropGroupHead(g.id)"
      @dragend="onDragEnd"
      @click="emit('toggle-group', g.id)"
      @dblclick="startRenameGroup(g.id, g.name)"
    >
      <!-- 折叠箭头（P-20261111-1-S1）：项目分组组头同款视觉语——组头整行即
           点击目标，箭头只作折叠态指示；双击重命名与单击折叠并存（双击先
           触发两次 click 净零态变化再进重命名，无副作用） -->
      <n-icon
        size="11"
        class="ats-fold"
      >
        <component :is="isGroupCollapsed(g.id) ? ChevronForwardOutline : ChevronDownOutline" />
      </n-icon>
      <n-icon size="12">
        <FolderOutline />
      </n-icon>
      <template v-if="renamingGroupId === g.id">
        <n-input
          v-model:value="renamingName"
          size="tiny"
          autofocus
          @keyup.enter="confirmRenameGroup"
          @blur="confirmRenameGroup"
          @click.stop
        />
      </template>
      <span
        v-else
        class="ats-group-name"
      >{{ g.name }}</span>
      <!-- 会话计数徽标（P-20261111-1-S1）：项目分组组头同款——组里有几条会话
           一眼可辨（「像空组」的呈现修复）；恒显不随折叠，计数与会话行同源
           （sessionsOf 过滤幽灵会话），折叠语义与项目树同款（计数恒显、折叠只藏行） -->
      <span class="ats-group-count">{{ sessionsOf(g.id).length }}</span>
      <n-dropdown
        trigger="click"
        :options="groupMenuOptions"
        placement="bottom-end"
        @select="(key: string) => onGroupMenu(g.id, key)"
      >
        <button
          class="ats-group-more"
          :title="t('agentTerminal.groupManage')"
          @click.stop
        >
          ⋯
        </button>
      </n-dropdown>
    </div>
    <!-- template v-for：行 + 排队面板同循环作用域（同未分组区）；折叠（P-20261111-1-S1）
         只藏行不藏组头——计数恒显语义随项目分组同款 -->
    <template v-if="!isGroupCollapsed(g.id)">
      <template
        v-for="s in sessionsOf(g.id)"
        :key="s.id"
      >
        <div
          class="ats-item"
          :class="{ active: s.id === (selectedId || activeId), 'ats-drag-over': dragOverKey === `session:${s.id}`, 'multi-selected': selectedIds.has(s.id) }"
          :title="itemTitle(s.id, s.name, s.runtimeVersion)"
          :data-sc-selection-drop="`session:${s.id}`"
          draggable="true"
          @dragstart="startDrag({ kind: 'session', sessionId: s.id, fromGroupId: g.id }, $event)"
          @dragover="onDragOverSessionItem(s, $event)"
          @drop.prevent="onDropSessionItem(s)"
          @dragend="onDragEnd"
          @click="onAgentItemClick(s, $event)"
          @dblclick.stop="startRenameSession(s.id, s.name)"
          @contextmenu.prevent="openSessionMenu(s, $event)"
        >
          <n-input
            v-if="renamingSessionId === s.id"
            v-model:value="renamingSessionName"
            size="tiny"
            autofocus
            @keyup.enter="confirmRenameSession"
            @blur="confirmRenameSession"
            @click.stop
          />
          <template v-else>
            <!-- 未读活动点（P-20261003-310）：同未分组行 -->
            <span
              v-if="props.unreadMap?.[s.id]"
              class="ats-item-unread"
              :title="t('terminal.tabUnread')"
            />
            <!-- 直通输入徽标（P-20261024-1）：同未分组行 -->
            <span
              v-if="props.directHolds?.[s.id]"
              class="ats-item-direct"
              :title="t('terminal.directInputBadgeTitle', { nick: props.directHolds![s.id]!.nick || props.directHolds![s.id]!.visitorTail || '' })"
              data-test="session-direct-badge"
            />
            <!-- 项目硬锁徽标（P-20261004-143）：同未分组行 -->
            <n-icon
              v-if="isLockedSession(s)"
              class="ats-item-locked"
              size="11"
              :title="t('project.locked.terminalBadgeTitle')"
              data-test="session-locked-badge"
            >
              <LockClosedOutline />
            </n-icon>
            <!-- 敏感角标（P-20261003-155）：同未分组行 -->
            <n-icon
              v-if="s.sensitive"
              class="ats-item-sensitive"
              size="11"
              :title="t('terminal.sensitiveBadgeTip')"
              data-test="session-sensitive-badge"
            >
              <WarningOutline />
            </n-icon>
            <!-- 直播中徽标（P-20261106-7）：同未分组行 -->
            <span
              v-if="props.liveTitles?.[s.id]"
              class="ats-item-live"
              :title="props.liveTitles[s.id]"
              data-test="session-live-badge"
            />
            <span
              class="ats-item-title"
              :title="s.name"
            >{{ s.name }}</span>
          </template>
          <!-- 接续/新徽标 + 行内时间（P-20261023-3）：同未分组行（本区无 cwd 徽标，
               位次紧邻 idle 徽标前的尾区一致） -->
          <span
            v-if="isResumedSession(s)"
            class="ats-item-resumed"
            :title="t('agentTerminal.resumeBadgeTip')"
            data-test="session-resumed-badge"
          >{{ t('agentTerminal.resumeBadge') }}</span>
          <span
            v-else-if="isNewSession(s)"
            class="ats-item-new"
            :title="t('agentTerminal.newBadgeTip')"
            data-test="session-new-badge"
          >{{ t('agentTerminal.newBadge') }}</span>
          <span
            v-if="createdText(s)"
            class="ats-item-time"
            :title="t('agentTerminal.createdAtTip', { time: createdFull(s) })"
            data-test="session-created-time"
          >{{ createdText(s) }}<template v-if="activityShort(s.id)"> · {{ activityShort(s.id) }}</template></span>
          <n-icon
            v-if="!shellIntDetected(s.id)"
            class="ats-item-shellint"
            size="11"
            :title="t('agentTerminal.shellIntOffTip')"
            data-test="session-shellint-missing"
          >
            <PulseOutline />
          </n-icon>
          <span
            v-if="idleBadge(s.id)"
            class="ats-item-idle"
            :class="{ 'is-stall': isStallBadge(s.id) }"
            :title="idleTip(s.id)"
            @click="onIdleBadgeClick(s.id, $event)"
          >{{ idleBadge(s.id) }}</span>
          <!-- 排队指令入口（P-20261003-248）：同未分组行 -->
          <button
            class="ats-item-queue"
            :class="{ 'has-items': queueCount(s.id) > 0 }"
            :title="t('agentTerminal.queue.toggle')"
            data-testid="session-queue-toggle"
            @click.stop="toggleQueue(s.id)"
          >
            <n-icon size="11">
              <ChatboxEllipsesOutline />
            </n-icon>
            <span
              v-if="queueCount(s.id) > 0"
              class="ats-item-queue-count"
            >{{ queueCount(s.id) }}</span>
          </button>
          <span
            v-if="isRunning(s)"
            class="ats-item-dot running"
          />
        </div>
        <!-- 排队指令面板（同未分组行，手风琴共享 queueOpenId） -->
        <AgentSessionQueuePanel
          v-if="queueOpenId === s.id"
          :session-id="s.id"
        />
      </template>
    </template>
  </div>

  <!-- 多选批操作栏（Ctrl/Cmd+点选系统会话后出现） -->
  <AgentSidebarBatchBar
    v-if="validSelectedIds.length > 0"
    :count="validSelectedIds.length"
    :groups="groups"
    @move="emitBatchMove"
    @destroy="emitBatchDestroy"
    @clear="clearSelection"
  />

  <!-- 系统会话右键菜单 -->
  <n-dropdown
    trigger="manual"
    :show="!!menuSessionId"
    :options="menuOptions"
    placement="bottom-start"
    :x="menuX"
    :y="menuY"
    @select="onSessionMenu"
    @clickoutside="menuSessionId = ''"
  />
</template>

<style scoped>
.ats-section { display: flex; flex-direction: column; gap: 2px; }
.ats-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 4px 6px;
  border-radius: 4px;
  user-select: none;
}
.ats-group-head.is-group { cursor: pointer; }
.ats-group-head.is-group:hover { background: var(--bg-hover); color: var(--text-secondary); }
.ats-group-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 自定义分组折叠箭头 + 计数徽标（P-20261111-1-S1）：项目分组组头同款视觉语
   （AgentSidebarProjectTree 的 scoped 样式不出组件，此处同款复刻——两处形态
   刻意一致，「自定义分组 = 项目分组」同一心智） */
.ats-fold { flex-shrink: 0; color: var(--text-dim); }
.ats-group-count {
  font-size: 10px;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  border-radius: 8px;
  padding: 0 6px;
  line-height: 15px;
}
/* runtime 组头计数（P-20261003-238）：弱样徽标——组头是导航不是状态，计数只作概览 */
.ats-rt-count {
  flex-shrink: 0;
  font-size: 0.72em;
  font-weight: 600;
  padding: 0 5px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--text-dim) 14%, transparent);
  color: var(--text-dim);
}
/* runtime 视图共存提示（P-20261111-1-S3）：弱化整行按钮——提示是辅助信息
   （只计数不渲染组内容），hover/焦点态才升为可交互观感；button 语义自带
   键盘可达（Enter/Space 触发），免手写 role/tabindex */
.ats-rt-groups-hint {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  font-size: 11px;
  line-height: 1.5;
  padding: 3px 6px;
  border-radius: 4px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
  transition: color var(--motion-base), background var(--motion-base);
}
.ats-rt-groups-hint:hover,
.ats-rt-groups-hint:focus-visible {
  color: var(--text-secondary);
  background: var(--bg-hover);
}
.ats-rt-groups-hint:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--text-dim) 50%, transparent);
}
.ats-group-more {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0 4px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.ats-group-head:hover .ats-group-more { opacity: 1; }
.ats-group-more:hover { color: var(--text-primary); background: var(--bg-hover); }
.ats-item {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 行高密度档（P-20261003-322）：--row-pad-y 仅紧凑档注入（3px）；舒适档回落
     6px = 历史值，零回归（内容自适应行无虚拟列表对齐约束，走 padding 基准） */
  padding: var(--row-pad-y, 6px) 10px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-body);
  font-size: 12px;
  transition: background var(--motion-base);
}
.ats-item:hover { background: var(--bg-hover); }
.ats-item.active { background: var(--bg-active); color: var(--text-primary); font-weight: 500; }
.ats-item-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ats-item-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--status-running);
}
/* shell 集成未检测弱标（P-20261004-90）：弱灰小图标——诊断语义非告警（不走
   语义橙/红），常驻不随 hover（缺失状态一眼可辨），tooltip 交代后果与原因 */
.ats-item-shellint {
  flex-shrink: 0;
  color: var(--text-dim);
}
/* 未读活动点（P-20261003-310）：后台会话有新输出/终态——进行中蓝档语义色，
   一次性布尔无频闪，点选会话即清 */
.ats-item-unread {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--status-running);
}

/* 直通输入徽标（P-20261024-1）：橙点呼吸——「谁在输入」的 owner 侧常驻
 * 可见（与未读灰点同位异色，锁/敏感角标同区）；色走 token 随主题联动，
 * 收回即摘（宿主 bump 对账） */
.ats-item-direct {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--accent-orange);
  animation: ats-direct-pulse 1.6s ease-in-out infinite;
}
@keyframes ats-direct-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
/* 敏感角标（P-20261003-155）：警示档语义色小图标，常显（安全标注不 hover 才见
   ——出域前一眼可辨），tooltip 交代后果 */
.ats-item-sensitive {
  flex-shrink: 0;
  color: var(--accent-orange);
}
/* 直播中徽标（P-20261106-7）：红点呼吸，与底部终端 tab 的 .term-tab-live 同视觉语
 * （缩放呼吸 + 语义红档 --status-failed，访客页「直播中」同源）；与未读灰点/
 * 直通橙点各自独立判定可并列（三者语义正交：有新输出 / 访客在输入 / 正在直播）。
 * TTL 到界/撤销由宿主投影摘除，本组件纯指示 */
.ats-item-live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--status-failed);
  animation: ats-live-pulse 1.6s ease-in-out infinite;
}
@keyframes ats-live-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}
/* 项目硬锁徽标（P-20261004-143）：小锁中性呈现（锁是状态不是错误，不走语义红；
 * 首页 .project-locked-badge 同款 accent-orange 语义），敏感角标同色系——
 * 一个提示「所在项目已锁」，一个提示「会话内容敏感」，并列不混义 */
.ats-item-locked {
  flex-shrink: 0;
  color: var(--accent-orange);
}
.ats-item-dot.running { animation: ats-pulse 1.6s ease-in-out infinite; }
@keyframes ats-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-running) 45%, transparent); }
  50% { box-shadow: 0 0 0 4px transparent; }
}
.ats-item-cwd {
  flex-shrink: 0; font-size: 0.72em; padding: 0 4px; border-radius: 2px;
  background: color-mix(in srgb, var(--accent-purple) 16%, transparent); color: var(--accent-purple);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70px;
}
/* 会话身份行内时间（P-20261023-3）：创建 + 最近活动弱灰字——同名会话（含
   派生步进名「·2」）的第二区分维度，tooltip 的时间升行内可见；弱灰不与行标
   （静默/停滞）争语义 */
.ats-item-time {
  flex-shrink: 0;
  font-size: 0.72em;
  color: var(--text-dim);
  white-space: nowrap;
}
/* 「新」徽标（P-20261023-3）：24h 内创建且尚无命令活动——「新建 ≠ 复用」
   的界面承诺；蓝档与未读点/排队计数同源（新事物语义非告警） */
.ats-item-new {
  flex-shrink: 0; font-size: 0.72em; padding: 0 4px; border-radius: 2px;
  background: color-mix(in srgb, var(--accent-blue) 14%, transparent); color: var(--accent-blue);
  white-space: nowrap;
}
/* 「接续」徽标（P-20261023-3）：恢复旗标创建、继承槽位旧名——与「新」互斥
   的第二身份；紫档与 cwd 徽标同源（来源语境语义） */
.ats-item-resumed {
  flex-shrink: 0; font-size: 0.72em; padding: 0 4px; border-radius: 2px;
  background: color-mix(in srgb, var(--accent-purple) 16%, transparent); color: var(--accent-purple);
  white-space: nowrap;
}
/* 会话静默弱标（P-20261003-53）：灰调小徽标，弱样式不弹窗不打断。
   停滞强标档（P-20261004-37）：警示橙描边升级 + 指针可点开分诊卡（弱标保持
   不可点语义——点击仍走行选中） */
.ats-item-idle {
  flex-shrink: 0; font-size: 0.72em; padding: 0 4px; border-radius: 2px;
  background: color-mix(in srgb, var(--text-dim) 12%, transparent); color: var(--text-dim);
  white-space: nowrap;
}
.ats-item-idle.is-stall {
  cursor: pointer;
  color: var(--status-waiting);
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--status-waiting) 55%, transparent);
}
.ats-item-idle.is-stall:hover { background: color-mix(in srgb, var(--status-waiting) 12%, transparent); }
/* 排队指令入口（P-20261003-248）：行尾小图标钮，有排队常显计数（蓝档语义色
   与未读点同源），无排队 hover 显形——可发现但不占静息密度 */
.ats-item-queue {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  border: none;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0 3px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.ats-item:hover .ats-item-queue,
.ats-item-queue.has-items { opacity: 1; }
.ats-item-queue:hover { color: var(--text-primary); background: var(--bg-hover); }
.ats-item-queue.has-items { color: var(--accent-blue); }
.ats-item-queue-count { font-size: 0.72em; font-weight: 600; }

/* 拖拽落点指示（组段整区 / 组内会话条目行级插入态；S2 起组区高亮挂 .ats-section
   整段，组头行不再单独描框——落点区与反馈面一致） */
.ats-drag-over {
  outline: 1px dashed var(--accent-blue);
  outline-offset: -1px;
  border-radius: 4px;
}
/* 多选批操作栏已抽至 AgentSidebarBatchBar；此处仅保留多选选中态 */
.ats-item.multi-selected { background: color-mix(in srgb, var(--accent-blue) 14%, transparent); }
</style>
