<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, h } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useTerminalThemeStore } from '../../stores/terminal-theme'
import { useUiDensityStore } from '../../stores/ui-density'
import { useSessionContextStore } from '../../stores/sessionContext'
import { useAssistantTaskStore } from '../../stores/assistantTask'
import { useAgentQueueStore } from '../../stores/agentQueue'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useApprovalsStore } from '../../stores/approvals'
import type { ApprovalRecord } from '../../api/domains/opsconfirm'
import { useAsksStore } from '../../stores/asks'
import type { AskRecord } from '../../api/domains/opsask'
import { OPS_NOTIFY, OPS_NAVIGATE, OPS_SETTINGS_CHANGED, OPS_TASK_PROGRESS, OPS_APPROVAL_PENDING, OPS_APPROVAL_RESOLVED, OPS_INPUT_REQUEST, OPS_INPUT_RESOLVED, OPS_PREVIEW_PORT, OPS_QUEUE_CHANGED, OPS_CLIPBOARD_ARRIVED, OPS_TERMINAL_MESSAGE, OPS_TERMINAL_MESSAGE_READ, OPS_WATCH_INVITE, OPS_NOTIFY_PERSIST, OPS_FRONTEND_DOWNLOAD, OPS_FRONTEND_CLIPBOARD, OPS_FRONTEND_OPEN, type NavigateDetail, type PreviewPortDetail, type ClipArrivedDetail, type TerminalMessageDetail, type TerminalMessageReadDetail, type WatchInviteDetail, type NotifyPersistDetail, type FrontendDownloadDetail, type FrontendClipboardDetail, type FrontendOpenDetail } from '../../utils/opsEvents'
import { handleAgentTaskProgressNotify, type AgentTaskProgressPayload } from '../../utils/agentTaskNotify'
import { handlePreviewPortNotify } from '../../utils/previewPortNotify'
import { handleWatchInviteNotify } from '../../utils/watchInviteNotify'
import { handleFrontendDownload, handleFrontendClipboard, handleFrontendOpen } from '../../utils/frontendAtomActions'
import { isForeignArrival } from '../../utils/clipRelay'
import { playAlert, bindAudioUnlock } from '../../utils/alertSound'
import { useDndStore } from '../../stores/dnd'
import { useLockStore } from '../../stores/lock'
import { useUserPrefsStore } from '../../stores/userPrefs'
import { useI18n } from '../../composables/useI18n'
import { invalidatePastePrecheckCache } from '../../composables/useTerminalDangerGate'
import { invalidatePreviewCompat } from '../../composables/usePreviewSandbox'
import { useClipRelay } from '../../composables/useClipRelay'
import { useOpsChannelState } from '../../composables/useOpsChannel'
import { runReconnectRefetches } from '../../composables/reconnectRefetch'
import { useApprovalActions } from '../../composables/useApprovalActions'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { refreshCustomSensitivePatterns } from '../../composables/useCustomSensitivePatterns'

/**
 * 智能操作通道的界面桥（须挂在 NMessageProvider 内部才能使用 useMessage）：
 * - notify 事件 → toast（外部 Agent 经 /api/ops-notify 驱动界面反馈）
 * - settings.changed 事件 → 重新加载终端主题（设置变更前端实时跟随）+ 用户
 *   偏好漫游对账（P-20261007-1：userPrefs 单键他端/agent 改动整表应用）
 * - task.progress 事件 → AI 助手任务进度 store（收起后的迷你进度窗实时渲染）+ 终态通知链（done/failed → 通知中心 + 桌面通知）
 * - approval.pending / approval.resolved → 审批 store（全局确认卡片堆 + 角标）+ 等待音效（P-20261003-33，pending 到达时）；
 *   挂载时 seedPending 冷启动补账（P-20261003-130）——刷新/重启后既有 pending 卡不丢；
 *   task.progress 侧同款挂载补账（P-20261004-120）：seedActive 拉
 *   GET /api/ops-tasks/active（服务端 per-session 最近上报缓存）回填
 *   bySession/悬浮球/监控卡——刷新后进度即现，不等 agent 下一条上报；
 *   ops 通道重连成功经集中补拉注册表全表补账（P-20261001-19 + P-20261003-236）——断线窗口期不可回放的广播不再丢等待
 * - input.request / input.resolved → 提问 store（全局提问卡片堆，P-20261001-27）+ 等待音效（同上）
 * - preview.port 事件 → 预览端口直达链（P-20261002-70）：通知中心带动作条目 + 悬浮球快捷按钮
 * - watch.invite 事件 → 直播邀请通知链（P-20261005-165）：通知中心带 url 动作条目，
 *   点击新窗打开访客直播页（agent「请人来看」的 human-pull 原语）
 * - notify.persist 事件 → 通知入账原语实时弹面（P-20261007-10）：服务端已入账
 *   （通知中心/webhook 全链生效），此处仅 toast 注意力面；免打扰时段静默
 * - clipboard.arrived 事件 → 跨设备剪贴板中继（P-20261002-32）：他机到达 toast 可点击取走（本机回声静默）
 * - frontend.download/clipboard/open 事件 → frontend 动词族三原子（P-20261023-4）：
 *   浏览器即时效应（下载框/剪贴板直写/开标签）——校验/开关/限频/可见 toast/回落链
 *   在 utils/frontendAtomActions，桥仅委托一行
 * - terminal.message / terminal.message.read 事件 → 会话间定向消息（P-20261004-68）：
 *   接收会话 tab 未读徽标点亮 / 收件箱被拉取后熄灭
 * - navigate 事件 → 注意力引导四直达（P-20261005-223）：path 路由 / {file,line}
 *   文件深链 / {view:'diff'} 工作区 diff / {view:'changes'} 变更面板聚焦 /
 *   {terminalId} 会话聚焦——全形态复用既有直达链零新执行逻辑；自 App.vue 迁入
 *   本桥是因为 {terminalId} 的 jumpToSession 依赖 useMessage（须在 NMessageProvider 内）
 */
const message = useMessage()
const { t } = useI18n()
const router = useRouter()
const approvalActions = useApprovalActions()
const clipRelay = useClipRelay(message)
const terminalThemeStore = useTerminalThemeStore()
const uiDensityStore = useUiDensityStore()
const sessionContextStore = useSessionContextStore()
const assistantTask = useAssistantTaskStore()
const terminalSessionsStore = useTerminalSessionsStore()
const approvals = useApprovalsStore()
const asks = useAsksStore()

function onNotify(e: Event) {
  const p = (e as CustomEvent<{ message?: string; level?: string }>).detail || {}
  if (!p.message) return
  // 免打扰时段（P-20261002-40）：notify 类 toast 静默——外部 Agent 经
  // /api/ops-notify 的界面反馈在夜间挂机时段不弹层。审批确认卡走
  // approval.pending 独立分支（高危裁决不吞），不在本静默范围；ops-notify
  // 消息是自由文本无归属类别，不参与例外穿透（P-20261003-115：isSilenced
  // 无类别入参 = 维持整体静默）
  if (useDndStore().isSilenced()) return
  const fn = (p.level && (message as unknown as Record<string, (m: string) => void>)[p.level]) || message.info
  fn(String(p.message).slice(0, 200))
}

function onSettingsChanged() {
  void terminalThemeStore.load()
  // 界面密度跟随（P-20261003-322）：uidensity 落服务端 settings，本页与他端
  // （设置页/agent settings API）改档均经本广播到达，行高 token 多端一致
  void uiDensityStore.load()
  // 会话启动上下文跟随（P-20261006-47）：sessionContext 落服务端 settings，
  // 本页改档（经 update 广播回灌）与他端/agent settings API 改档均经本广播
  // 到达，ask 链与新建对话框的默认勾选多端一致
  void sessionContextStore.load()
  // 审批模式镜像跟随（P-20261002-126）：完全允许落盘 / 设置页改回均经本
  // 广播到达，放行徽标（ApprovalModeBadge）据此多标签页一致亮灭
  void approvals.refreshMode()
  // 高危命令粘贴预检开关跟随（P-20261005-191）：gate 模块缓存失效，下次
  // 粘贴/直达插入现拉生效（设置页保存路径另有本页失效，此处覆盖他端改档）
  invalidatePastePrecheckCache()
  // 预览沙箱姿态跟随（P-20261019-1）：previewCompatMode 落服务端 settings，
  // 设置页保存/他端/agent 改档均经本广播到达，镜像重拉后 PreviewPanel 按新
  // 姿态重建开着的预览
  invalidatePreviewCompat()
  // 自定义敏感模式跟随（P-20261006-11）：设置页保存 / 他端 / agent settings
  // API 改动均经本广播到达，遮蔽链模块态重注入（拉取失败静默保旧）
  void refreshCustomSensitivePatterns()
  // 用户偏好漫游跟随（P-20261007-1）：键位/通知三件/终端习性收编进 settings
  // 单键 userPrefs，他端或 agent 改动经本广播到达，整表应用（服务端 wins）；
  // 本端推送在途时内部守卫跳过，等自身 PUT 的广播回流对账
  void useUserPrefsStore().pull()
}

function onTaskProgress(e: Event) {
  const p = (e as CustomEvent<AgentTaskProgressPayload>).detail || {}
  if (p.status === 'done' || p.status === 'failed') {
    assistantTask.finish(p.status)
  } else {
    assistantTask.progress(p)
  }
  // 会话归属（P7）：agent 携带 CC_TERMINAL_ID 上报时写入 per-session 进度表，
  // 悬浮球/条的点击跳转据此直达该会话
  if (p.terminalId) {
    assistantTask.progressFor(String(p.terminalId), p)
    // 后台会话终态点亮未读点（P-20261003-310）：done/failed 到达且该会话不
    // 在任何宿主可见——与输出钩子互补（活动即时可见 + 失联终态有兜底）；
    // markUnread 内部跳过可见会话
    if (p.status === 'done' || p.status === 'failed') {
      terminalSessionsStore.markUnread(String(p.terminalId))
    }
  }
  // 任务终态通知链（P-20261002-15）：done/failed → 通知中心入账 + 桌面通知
  //（防重复/耗时起点记录均在纯函数模块内；非终态仅记起点）
  handleAgentTaskProgressNotify(p)
}

function onApprovalPending(e: Event) {
  const p = (e as CustomEvent<ApprovalRecord>).detail
  if (!p?.id) return
  // 等待音效（P-20261003-33）：仅「新等待」响（resolved 回流不响）——先判新
  // 再入账，同 id 重播不响。合并审批（P-20261006-26）每有一条同型请求入队就
  // 重播一次主卡 pending 载荷（卡面 +N 徽标原地更新的唯一通道），不判新会变
  // 成裁决轰炸的声音版。门控链（总开关/免打扰/锁定/自动播放未解锁）在合成器
  // 内部串联，只吞声音不吞卡。归属类别 approval（P-20261003-115）：默认在免
  // 打扰例外表，夜间挂机审批提醒穿透静默（agent 干等裁决不吞音）
  const isNew = !approvals.pending[p.id]
  approvals.upsert(p)
  if (p.status === 'pending' && isNew) playAlert('approval')
}

function onApprovalResolved(e: Event) {
  const p = (e as CustomEvent<{ id?: string; status?: string }>).detail
  if (p?.id) approvals.markResolved(p.id, p.status)
}

function onInputRequest(e: Event) {
  const p = (e as CustomEvent<AskRecord>).detail
  if (!p?.id) return
  asks.upsert(p)
  // 等待音效（P-20261003-33）：同审批卡——回答回流（input.resolved）走独立
  // 事件不经过这里，此处到达即新等待。归属类别 ask：不在免打扰例外默认表，
  // 时段内照旧静默（例外多选可纳管，提案未点名不默认放）
  if (p.status === 'pending') playAlert('ask')
}

function onInputResolved(e: Event) {
  const p = (e as CustomEvent<{ id?: string; status?: string }>).detail
  if (p?.id) asks.markResolved(p.id, p.status)
}

// 预览端口直达（P-20261002-70）：校验/去重/登记/入账都在纯函数链内
function onPreviewPort(e: Event) {
  handlePreviewPortNotify(((e as CustomEvent<PreviewPortDetail>).detail || {}) as PreviewPortDetail)
}

// 直播邀请（P-20261005-165）：agent 开完终端直播后把人拉到访客页——校验/去重/
// 拼访客短链/入账都在纯函数链内（异步：拼链需查分享子服务状态，不阻塞桥）
function onWatchInvite(e: Event) {
  void handleWatchInviteNotify(((e as CustomEvent<WatchInviteDetail>).detail || {}) as WatchInviteDetail)
}

// 通知入账原语（P-20261007-10）：服务端已直调通知中心入账（条目经
// /ws/notifications 实时进中心、error/warning 的桌面提醒由中心既有 watch 承担），
// 本分支仅做实时弹面 toast——徽标之外的「用户在看屏幕」注意力面。免打扰时段
// 静默同 notify toast（P-20261002-40；error 级勿扰穿透在桌面链不在此重复）；
// 服务端已校验载荷，此处仅防其它来源。归类静音（任务子开关关）时服务端不广播
// 本事件，弹面与入账同偏好过滤
function onNotifyPersist(e: Event) {
  const p = (e as CustomEvent<NotifyPersistDetail>).detail || {}
  if (!p.title) return
  if (useDndStore().isSilenced()) return
  const fn = (p.level && (message as unknown as Record<string, (m: string) => void>)[p.level]) || message.info
  fn(String(p.title).slice(0, 200))
}

// frontend 动词族三原子（P-20261023-4）：浏览器即时效应的消费委托——校验/
// 开关门控/效应面限频/可见 toast/回落链（中继槽/通知条目）都在
// utils/frontendAtomActions 纯函数链内（previewPortNotify 同构）；桥只解包
// detail 并注入 message 面
function onFrontendDownload(e: Event) {
  handleFrontendDownload(((e as CustomEvent<FrontendDownloadDetail>).detail || {}) as FrontendDownloadDetail, message)
}
function onFrontendClipboard(e: Event) {
  void handleFrontendClipboard(((e as CustomEvent<FrontendClipboardDetail>).detail || {}) as FrontendClipboardDetail, message)
}
function onFrontendOpen(e: Event) {
  handleFrontendOpen(((e as CustomEvent<FrontendOpenDetail>).detail || {}) as FrontendOpenDetail, message)
}

// 排队指令队列已变（P-20261003-248）：回执引擎弹队首后广播，前端拉全量对账
// （徽标/面板的唯一实时感知通道；store 未加载过 = 无消费面板，刷新自会跳过）
function onQueueChanged() {
  void useAgentQueueStore().onQueueChanged()
}

// 跨设备剪贴板到达（P-20261002-32）：他机 POST /api/clip 成功的广播。本机设备
// （同浏览器的所有 tab，origin 过滤）不弹——那是发送方自己的回声；toast 内容
// 可点击即取（GET 读取即焚 + copyText 落本地剪贴板），8s 自动消失（瞬态语义，
// 未点到即错过——槽内内容仍会被取走或 TTL 到点消亡，无积压）
function onClipArrived(e: Event) {
  const detail = (e as CustomEvent<ClipArrivedDetail>).detail
  if (!isForeignArrival(detail)) return
  message.info(() => h('span', {
    style: 'cursor:pointer;text-decoration:underline;text-underline-offset:3px;',
    'data-testid': 'clip-arrive-toast',
    onClick: () => { void clipRelay.takeArrived() },
  }, t('clip.arrivedToast')), { duration: 8000 })
}

// 会话间定向消息到达（P-20261004-68）：接收会话 tab 点亮未读点（P-310 同款
// 一次性布尔；markUnread 内部跳过当前可见会话——正在看的会话不需要徽标）。
// 消息全文不进前端面（广播只带首行摘要，正文在目标会话的 agent 侧收件箱）
function onTerminalMessage(e: Event) {
  const detail = (e as CustomEvent<TerminalMessageDetail>).detail || {}
  if (detail.to) terminalSessionsStore.markUnread(String(detail.to))
}

// 收件箱已读（P-20261004-68）：拉取方会话的未读点熄灭——「读取后徽标消」
// 的唯一感知通道（拉取是 agent 侧动作，前端不轮询收件箱）
function onTerminalMessageRead(e: Event) {
  const detail = (e as CustomEvent<TerminalMessageReadDetail>).detail || {}
  if (detail.sessionId) terminalSessionsStore.clearUnread(String(detail.sessionId))
}

/** navigate {file}/{view:'diff'} 共用的文件深链 query（withLine=false 供 diff
 *  形态——对比视图无行定位语义，URL 不携带噪声参数） */
function fileDeeplinkQuery(d: NavigateDetail, withLine = true): Record<string, string> {
  const query: Record<string, string> = { file: String(d.file) }
  if (typeof d.project === 'string' && d.project) query.project = d.project
  if (withLine && typeof d.line === 'number' && Number.isInteger(d.line) && d.line >= 1) query.line = String(d.line)
  return query
}

// navigate 事件注意力引导（P-20261005-223）：四目标形态按字段首命中分发，
// 全部复用既有直达链（文件深链 / diff 直达 / 面板聚焦 / 会话跳转），零新执行逻辑。
// 多端广播同跳语义与既有 path 形态一致（各端各自落位，接受）
async function onOpsNavigate(e: Event) {
  const d = (e as CustomEvent<NavigateDetail>).detail
  if (!d) return
  // ① path 路由深链（既有形态，向后兼容——行为与迁移前 App.vue 一致）
  if (typeof d.path === 'string' && d.path.startsWith('/')) {
    void router.push(d.path)
    return
  }
  // ② {view:'diff', file}：diff=1 深链变体（同链消费，开 vs HEAD 工作区 diff——
  //    审批卡 target 预览「直开差异视图」同参）。须先于纯 {file} 形态判定：
  //    diff 载荷同样携带 file 字段，首命中按 view 判别（无 view 的 file 才是打开形态）
  if (d.view === 'diff' && typeof d.file === 'string' && d.file) {
    void router.push({ path: '/project', query: { ...fileDeeplinkQuery(d, false), diff: '1' } })
    return
  }
  // ③ {file, line?} 文件直达（不带 view）：落成文件深链 query（既有链全套时序：
  //    SPA 再入即时消费 / 冷启动等 bootstrap 后消费 / 锁定挂起解锁接力 /
  //    project= 先切项目）
  if (typeof d.file === 'string' && d.file) {
    void router.push({ path: '/project', query: fileDeeplinkQuery(d) })
    return
  }
  // ④ {view:'changes'}：变更面板聚焦——ensure-open（注意力引导无「收起」半程，
  //    与 panel 事件的 toggle 语义刻意区分）。跳转意图无条件先打标再落位：
  //    事件可能落在「已进项目页但 bootstrap 布局恢复未跑完」的窗口里，只做
  //    即时落位会被 restoreLayoutOnly 用上次保存值覆盖——pendingSideView 由
  //    恢复消费一次即闭环（pendingBottomTab「查看发起会话」同款时序与代价）
  if (d.view === 'changes') {
    const layout = usePanelLayout()
    layout.pendingSideView.value = 'changes'
    if (router.currentRoute.value.name !== 'project') {
      // 他页/冷启动进入：路由落定后 Layout 挂载、bootstrap 恢复消费打标
      await router.push({ path: '/project' })
      return
    }
    // 已在项目页：即时落位（bootstrap 已跑完时即刻生效；未跑完由上方打标兜底）
    layout.focusPanel('changes')
    return
  }
  // ⑤ {terminalId}：会话聚焦——审批卡「查看发起会话」同一跳转链（会话对账/
  //   已结束 toast 降级/切项目/开底部终端面板/激活 tab 全在其内闭环）
  if (typeof d.terminalId === 'string' && d.terminalId) {
    await approvalActions.jumpToSession(d.terminalId)
    return
  }
  // 未知形态宽容忽略（开放词表同哲学）：debug 留痕不报错不 toast
  console.debug('[ops-channel] navigate: 未识别的载荷形态，已忽略', d)
}

// pending 审批冷启动补账（P-20261003-130）：锁定引导期挂起、解锁落定即拉。
// isLocked 默认 true（checkStatus 探测前），挂载即拉在锁定部署下必 423 空手
// 而归且无人重拉——与值班大屏冷启动补账同款时序（MonitorView coldSeedPending）。
// task.progress 重启恢复补账（P-20261004-120）同款时序同行挂起：解锁落定
// seedActive 回填 bySession/悬浮球/监控卡
const lockStore = useLockStore()
let approvalSeedDeferred = false
// 用户偏好漫游首拉同样受锁定门禁（LockMiddleware 对 /api/settings 返 423）：
// 锁定部署下挂载即拉必空手，解锁落定补拉一次——否则 B 机解锁后仍是旧镜像，
// 要等下一次 settings.changed（他端改设置）才跟随，违背「打开即跟随」
let userPrefsSeedDeferred = false
let taskSeedDeferred = false
watch(() => lockStore.isLocked, (locked) => {
  if (!locked) {
    if (approvalSeedDeferred) {
      approvalSeedDeferred = false
      void approvals.seedPending()
    }
    if (taskSeedDeferred) {
      taskSeedDeferred = false
      void assistantTask.seedActive()
    }
  }
  if (!locked && userPrefsSeedDeferred) {
    userPrefsSeedDeferred = false
    void useUserPrefsStore().pull()
  }
})

// ops 通道重连触发（P-20261001-19，P-20261003-236 起改走集中注册表）：断线
// 窗口期的 approval.pending / input.request / terminals.changed 等广播不可回放，
// 重连成功即 runReconnectRefetches 全表补拉（approvals/asks/项目状态/通知/
// 终端列表/任务进度六域，域注册分散在各域主模块——grep registerReconnectRefetch
// 即全量清单）。首连与挂载时补账重叠无害（各域 fn 幂等）；锁定→解锁后的首次
// 连上也补一次——锁定期间落下的等待不缺席
const { connected: opsConnected } = useOpsChannelState()
watch(opsConnected, (now, prev) => {
  if (now && prev === false) runReconnectRefetches()
})

onMounted(() => {
  window.addEventListener(OPS_NOTIFY, onNotify)
  window.addEventListener(OPS_NAVIGATE, onOpsNavigate)
  window.addEventListener(OPS_SETTINGS_CHANGED, onSettingsChanged)
  window.addEventListener(OPS_TASK_PROGRESS, onTaskProgress)
  window.addEventListener(OPS_APPROVAL_PENDING, onApprovalPending)
  window.addEventListener(OPS_APPROVAL_RESOLVED, onApprovalResolved)
  window.addEventListener(OPS_INPUT_REQUEST, onInputRequest)
  window.addEventListener(OPS_INPUT_RESOLVED, onInputResolved)
  window.addEventListener(OPS_PREVIEW_PORT, onPreviewPort)
  window.addEventListener(OPS_WATCH_INVITE, onWatchInvite)
  window.addEventListener(OPS_NOTIFY_PERSIST, onNotifyPersist)
  window.addEventListener(OPS_QUEUE_CHANGED, onQueueChanged)
  window.addEventListener(OPS_CLIPBOARD_ARRIVED, onClipArrived)
  window.addEventListener(OPS_TERMINAL_MESSAGE, onTerminalMessage)
  window.addEventListener(OPS_TERMINAL_MESSAGE_READ, onTerminalMessageRead)
  window.addEventListener(OPS_FRONTEND_DOWNLOAD, onFrontendDownload)
  window.addEventListener(OPS_FRONTEND_CLIPBOARD, onFrontendClipboard)
  window.addEventListener(OPS_FRONTEND_OPEN, onFrontendOpen)
  // 等待音效自动播放解锁（P-20261003-33）：工作台长驻形态首次点击/按键即
  // 解锁 AudioContext（浏览器自动播放策略；未解锁态播不出则静默跳过）
  bindAudioUnlock()
  // 审批模式镜像首查（P-20261002-126）：跨页面刷新（非本页设置改动）落在
  // 本页生命周期之外，徽标初始态必须主动对齐服务端（失败静默保 ask）
  void approvals.refreshMode()
  // 自定义敏感模式首拉（P-20261006-11）：遮蔽链模块态启动对齐服务端配置
  //（与审批模式镜像同款生命周期外的主动对齐；失败静默回落纯通用表现状）
  void refreshCustomSensitivePatterns()
  // 用户偏好漫游首拉（P-20261007-1）：启动期服务端真值 wins（键位/通知三件/
  // 终端习性整表应用），服务端无偏好且本机有旧值则播种上传——订阅写路径
  // 脏标记也在 init 内一并装上
  useUserPrefsStore().init()
  // 冷启动补账：未锁引导直接拉；锁定/未判定期挂起给解锁 watcher（上方）。
  // userPrefs 首拉同样挂起：锁定态 init 内的首拉被 423 拒绝，解锁后补拉
  if (lockStore.isLocked) {
    approvalSeedDeferred = true
    userPrefsSeedDeferred = true
    taskSeedDeferred = true
  } else {
    void approvals.seedPending()
    // task.progress 重启恢复补账（P-20261004-120）：刷新/重启后悬浮球/进度卡/
    // 监控卡即现（无需等 agent 下一条 progress 上报——慢步骤可达数分钟）
    void assistantTask.seedActive()
  }
})
onBeforeUnmount(() => {
  window.removeEventListener(OPS_NOTIFY, onNotify)
  window.removeEventListener(OPS_NAVIGATE, onOpsNavigate)
  window.removeEventListener(OPS_SETTINGS_CHANGED, onSettingsChanged)
  window.removeEventListener(OPS_TASK_PROGRESS, onTaskProgress)
  window.removeEventListener(OPS_APPROVAL_PENDING, onApprovalPending)
  window.removeEventListener(OPS_APPROVAL_RESOLVED, onApprovalResolved)
  window.removeEventListener(OPS_INPUT_REQUEST, onInputRequest)
  window.removeEventListener(OPS_INPUT_RESOLVED, onInputResolved)
  window.removeEventListener(OPS_PREVIEW_PORT, onPreviewPort)
  window.removeEventListener(OPS_WATCH_INVITE, onWatchInvite)
  window.removeEventListener(OPS_NOTIFY_PERSIST, onNotifyPersist)
  window.removeEventListener(OPS_QUEUE_CHANGED, onQueueChanged)
  window.removeEventListener(OPS_CLIPBOARD_ARRIVED, onClipArrived)
  window.removeEventListener(OPS_TERMINAL_MESSAGE, onTerminalMessage)
  window.removeEventListener(OPS_TERMINAL_MESSAGE_READ, onTerminalMessageRead)
  window.removeEventListener(OPS_FRONTEND_DOWNLOAD, onFrontendDownload)
  window.removeEventListener(OPS_FRONTEND_CLIPBOARD, onFrontendClipboard)
  window.removeEventListener(OPS_FRONTEND_OPEN, onFrontendOpen)
})
</script>

<template>
  <!-- 无模板：仅挂载事件监听 -->
  <span style="display: none" />
</template>
