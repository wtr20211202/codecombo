<script setup lang="ts">
/**
 * 定时任务管理（设置 → 定时任务分区，P-20261002-43）：
 * 周期性 agent 任务（每日 HH:MM + 周几集合）到点由服务端经 agent 终端通道
 * 自动发起会话。本组件承载 CRUD + 启停 + 下次运行预览（服务端计算，与调度
 * 判定同一实现）+ 立即试跑 + 运行历史迷你列表（行内展开，P-20261002-143）；
 * 依赖链（P-20261003-124）：触发方式可切换定时 / 前序完成触发（选父任务 +
 * 两档），成环客户端预检 + 服务端保存口校验双层兜底。
 * 运行时变量注入（P-20261003-167）：prompt 支持 {date}/{time}/{weekday}
 * 占位符，发起时由服务端展开为槽点实际值（前端只做占位符提示，不预展开）；
 * 500 字节配额按模板原文计，展开增量有界。
 * 自动接力（P-20261005-207）：relayFrom 三形态（不接力/项目最近已结束会话/
 * 显式会话 id）触发时由服务端注入上次结论作任务前言——行内接力标记 + 最近
 * 一次接力结果（lastRelayNote relayed/skipped:<原因>，降级任务照常发起）。
 * 指标抽取（P-20261005-237）：extract 规则（正则命名组 / json: 路径）在任务
 * 完成时从输出尾窗取数值入时序——行内迷你趋势 + 最近值悬停明细 + 波动点标记
 * （判定在 utils/cronTrend 纯函数，阈值粗放起步）。
 * 错过槽可视化（P-20261006-22）：missedHistory 与运行历史同一展开区按时间混排
 * （灰 = 未开补偿跳过 / 绿 = 补跑发起成功 / 红 = 补跑发起失败），补偿机制从
 * 黑盒变可查。
 * 评估时区（P-20261005-217）：任务可选 IANA 时区，空 = 按服务器时区评估——
 * 表单标注服务器时区与当前时刻（列表 API server 段）供跨时区部署对表；非默认
 * 时区的任务行内徽标标注。客户端 Intl 预校验，服务端 LoadLocation 是事实源。
 * 变更即时生效，无保存按钮（即时操作分区）。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  NButton, NCheckbox, NEmpty, NForm, NFormItem, NInput, NList, NListItem,
  NModal, NSelect, NSwitch, NTag, NThing, useMessage,
} from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { agentCronApi, type AgentCron, type AgentCronItem, type AgentCronMissedEntry, type AgentCronServerTZ } from '../../api/domains/agentcron'
import { terminalApi } from '../../api/domains/terminal'
import { formatDateTime } from '../../utils/git'
import { confirmDialog } from '../../composables/useDialog'
import { anomalyFlags, formatTrendValue, latestIsAnomaly, sparklinePoints } from '../../utils/cronTrend'
import { COMMON_TIMEZONES, formatUTCOffset, isValidTimeZone, parseUTCOffset, wallClockOf, zoneClockIn, zoneOffsetLabel } from '../../utils/cronTimezone'
import { OPS_AGENT_CRONS_CHANGED } from '../../utils/opsEvents'

const { t } = useI18n()
const message = useMessage()

// 与服务端 launchArgs 字节上限同口径的前端预检（服务端仍是事实源）
const PROMPT_MAX_BYTES = 500

const crons = ref<AgentCronItem[]>([])
/** 服务器时区快照（列表 API server 段，P-20261005-217）：面板级对表标注与
 *  表单「按服务器时区」提示的展示数据面 */
const serverTZ = ref<AgentCronServerTZ | null>(null)
const showModal = ref(false)
const saving = ref(false)
const running = ref('')
/** 正在编辑的任务 ID（空 = 新增） */
const editingId = ref('')

const form = ref({
  name: '',
  hour: 2,
  minute: 0,
  weekdays: [] as number[],
  // 评估时区（P-20261005-217）：空 = 按服务器时区；IANA 名，客户端 Intl 预校验
  timezone: '',
  runtime: '',
  prompt: '',
  dir: '',
  enabled: true,
  missCatchUp: false,
  // 依赖链（P-20261003-124）：schedule = 定时（既有语义）；after = 前序完成触发
  trigger: 'schedule',
  afterCronId: '',
  afterMode: 'success',
  // 自动接力（P-20261005-207）：off = 不接力；latest = 项目最近已结束会话动态
  // 解析；session = 显式会话 id（relayFrom 存储态为单字符串，表单双字段拆形态）
  relayMode: 'off' as 'off' | 'latest' | 'session',
  relaySessionId: '',
  // 指标抽取规则（P-20261005-237）：空 = 关闭；存储态即单字符串，无形态拆分
  extract: '',
})

// 时刻下拉：00–23 / 00–59（整点整分语义，无秒）
const hourOptions = Array.from({ length: 24 }, (_, h) => ({
  label: String(h).padStart(2, '0'),
  value: h,
}))
const minuteOptions = Array.from({ length: 60 }, (_, m) => ({
  label: String(m).padStart(2, '0'),
  value: m,
}))

// 周几集合（0=周日…6=周六，与后端 Weekdays 数组同序）；computed 包一层保证
// 语言切换后标签跟随
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]
const weekdayOptions = computed(() =>
  WEEKDAYS.map(d => ({ value: d, label: t(`agentcron.weekday.${d}`) })),
)

// 运行时下拉：auto / shell 一等选项 + 服务端注册运行时（探测不可用不禁用，
// 与会话创建对话框口径一致）；标签同样经 computed 跟随语言
const runtimeItems = ref<Array<{ name: string; displayName?: string }>>([])
const runtimeOptions = computed(() => [
  { label: t('agentcron.runtimeAuto'), value: '' },
  { label: t('agentcron.runtimeShell'), value: 'shell' },
  ...runtimeItems.value
    .filter(rt => rt.name !== 'shell')
    .map(rt => ({ label: rt.displayName || rt.name, value: rt.name })),
])
async function loadRuntimes() {
  try {
    const res: any = await terminalApi.listAgentRuntimes()
    runtimeItems.value = res?.data || []
  } catch { /* 保留 auto/shell 兜底项 */ }
}

// ---- 评估时区（P-20261005-217）：候选/预校验/对表标注 ----
// 服务端 LoadLocation 是事实源（保存口 400 拒绝非法名），Intl 预校验只省一次
// 无效往返；选择器 tag 模式允许候选表之外的任意合法 IANA 名

const timezoneOptions = computed(() => [
  { label: t('agentcron.timezone.serverDefault'), value: '' },
  ...COMMON_TIMEZONES.map(tz => {
    const offset = zoneOffsetLabel(tz)
    return { label: offset ? `${tz}（${offset}）` : tz, value: tz }
  }),
])

/** 表单标注：评估时区与当前时刻（对表用）。服务器档取列表 API 的 server 快照
 * （now 的壁钟即服务器本地时刻，纯切片不换算；偏移从 RFC3339 尾部解析）；
 * 显式时区档由客户端 Intl 现算 */
const evalZoneHint = computed(() => {
  const tz = form.value.timezone.trim()
  if (!tz) {
    if (!serverTZ.value) return t('agentcron.timezone.hintEmpty')
    const minutes = parseUTCOffset(serverTZ.value.now)
    return t('agentcron.timezone.formServer', {
      name: serverTZ.value.name,
      offset: minutes === null ? serverTZ.value.utcOffset : formatUTCOffset(minutes),
      time: wallClockOf(serverTZ.value.now),
    })
  }
  return t('agentcron.timezone.formZone', {
    tz,
    offset: zoneOffsetLabel(tz) || t('agentcron.timezone.unknownOffset'),
    time: zoneClockIn(tz),
  })
})

// ---- 依赖链（P-20261003-124）：触发类型 / 父任务 / 档位 ----

const triggerOptions = computed(() => [
  { label: t('agentcron.triggerSchedule'), value: 'schedule' },
  { label: t('agentcron.triggerAfter'), value: 'after' },
])

const afterModeOptions = computed(() => [
  { label: t('agentcron.afterModeSuccess'), value: 'success' },
  { label: t('agentcron.afterModeAlways'), value: 'always' },
])

// ---- 自动接力（P-20261005-207）：形态下拉与 relayFrom 存储态互转 ----

const relayModeOptions = computed(() => [
  { label: t('agentcron.relay.off'), value: 'off' },
  { label: t('agentcron.relay.latest'), value: 'latest' },
  { label: t('agentcron.relay.session'), value: 'session' },
])

/** 表单形态 → relayFrom 存储态（单字符串：'' / 'latest' / 会话 id） */
function relayFromOfForm(): string {
  if (form.value.relayMode === 'latest') return 'latest'
  if (form.value.relayMode === 'session') return form.value.relaySessionId.trim()
  return ''
}

/** relayFrom 存储态 → 表单形态（未知非空值 = 显式会话 id） */
function formOfRelayFrom(relayFrom?: string): { mode: 'off' | 'latest' | 'session'; sessionId: string } {
  if (!relayFrom) return { mode: 'off', sessionId: '' }
  if (relayFrom === 'latest') return { mode: 'latest', sessionId: '' }
  return { mode: 'session', sessionId: relayFrom }
}

/** 行内接力形态描述（标记 tooltip） */
function relayModeText(item: Pick<AgentCron, 'relayFrom'>): string {
  return item.relayFrom === 'latest'
    ? t('agentcron.relay.latest')
    : t('agentcron.relay.sessionShort')
}

/** 最近一次接力结果文案（lastRelayNote：relayed / skipped:<原因>） */
function relayResultText(item: AgentCronItem): string {
  if (!item.lastRelayNote) return '—'
  if (item.lastRelayNote === 'relayed') return t('agentcron.relay.relayed')
  return t('agentcron.relay.skipped') + item.lastRelayNote.slice('skipped:'.length)
}

// ---- 评估时区展示（P-20261005-217）----

/** 面板级服务器时区标注（对表行）：跨时区部署「服务器说的几点」一眼可查；
 * 列表未拉到（旧后端/瞬态失败）不渲染，不硬凑 */
const serverTZLine = computed(() => {
  const s = serverTZ.value
  if (!s) return ''
  const minutes = parseUTCOffset(s.now)
  return t('agentcron.timezone.serverLine', {
    name: s.name,
    offset: minutes === null ? s.utcOffset : formatUTCOffset(minutes),
    time: wallClockOf(s.now),
  })
})

/** 行内时区徽标文案：显式指定评估时区的任务标注（空 = 服务器默认档不标——
 * 徽标语义是「该任务不按服务器时区评估」，避免全列表噪声） */
function timezoneBadge(item: AgentCron): string {
  const tz = item.timezone || ''
  if (!tz) return ''
  const offset = zoneOffsetLabel(tz)
  return offset ? `${tz} · ${offset}` : tz
}

/** 父任务候选：排除自身（自依赖=一阶环），附计划描述辅助辨认 */
const parentOptions = computed(() =>
  crons.value
    .filter(c => c.id !== editingId.value)
    .map(c => ({ label: `${c.name}（${cronPlanText(c)}）`, value: c.id })),
)

function parentNameOf(id: string): string {
  return crons.value.find(c => c.id === id)?.name ?? id
}

/** 行内计划描述：定时 = 时刻/周几；after = 前序依赖 + 档位 */
function cronPlanText(item: AgentCronItem): string {
  if (item.trigger === 'after') {
    const mode = item.afterMode === 'always' ? t('agentcron.afterModeAlways') : t('agentcron.afterModeSuccess')
    return `${t('agentcron.listAfterPrefix')}${parentNameOf(item.afterCronId || '')} · ${mode}`
  }
  return scheduleText(item)
}

async function fetchCrons() {
  try {
    const res: any = await agentCronApi.list()
    crons.value = res?.data ?? []
    serverTZ.value = res?.server ?? null
  } catch { /* 拦截器统一处理 */ }
}

/** 任务面板刷新联动（P-20261006-14）：通知中心 cron-retry 一键重试成功后广播
 *  OPS_AGENT_CRONS_CHANGED——挂载中的分区即重拉（lastRunAt/lastResult 运行期
 *  事实刚被重试翻写）；未挂载时无人监听，下次打开 fetchCrons 自然读到新值
 *  （OPS_WORKTREES_CHANGED 同纪律，不信任事件载荷、收到即拉全量） */
function onCronsExternalChange(): void {
  void fetchCrons()
}

onMounted(() => {
  void fetchCrons()
  void loadRuntimes()
  window.addEventListener(OPS_AGENT_CRONS_CHANGED, onCronsExternalChange)
})

onBeforeUnmount(() => {
  window.removeEventListener(OPS_AGENT_CRONS_CHANGED, onCronsExternalChange)
})

function openAdd() {
  editingId.value = ''
  form.value = { name: '', hour: 2, minute: 0, weekdays: [], timezone: '', runtime: '', prompt: '', dir: '', enabled: true, missCatchUp: false, trigger: 'schedule', afterCronId: '', afterMode: 'success', relayMode: 'off', relaySessionId: '', extract: '' }
  showModal.value = true
}

function edit(item: AgentCron) {
  editingId.value = item.id
  const relay = formOfRelayFrom(item.relayFrom)
  form.value = {
    name: item.name,
    hour: item.hour,
    minute: item.minute,
    weekdays: [...(item.weekdays ?? [])],
    timezone: item.timezone || '',
    runtime: item.runtime || '',
    prompt: item.prompt,
    dir: item.dir || '',
    enabled: item.enabled,
    missCatchUp: !!item.missCatchUp,
    trigger: item.trigger === 'after' ? 'after' : 'schedule',
    afterCronId: item.afterCronId || '',
    afterMode: item.afterMode === 'always' ? 'always' : 'success',
    relayMode: relay.mode,
    relaySessionId: relay.sessionId,
    extract: item.extract || '',
  }
  showModal.value = true
}

const promptBytes = computed(() => new TextEncoder().encode(form.value.prompt).length)

/** 依赖环客户端预检：从所选父任务沿 afterCronId 上溯，命中正在编辑的任务即成环
 *  （服务端保存口是事实源，此处提前拦截给出本地化提示） */
function chainCycle(): boolean {
  if (form.value.trigger !== 'after' || !form.value.afterCronId) return false
  const byId = new Map(crons.value.map(c => [c.id, c]))
  let cur: string | undefined = form.value.afterCronId
  const seen = new Set<string>()
  while (cur) {
    if (cur === editingId.value || seen.has(cur)) return true
    seen.add(cur)
    const next = byId.get(cur)
    if (!next || next.trigger !== 'after') return false
    cur = next.afterCronId || ''
  }
  return false
}

function validate(): string | null {
  if (!form.value.name.trim()) return t('agentcron.nameRequired')
  if (form.value.name.trim().length > 120) return t('agentcron.nameTooLong')
  if (promptBytes.value === 0) return t('agentcron.promptRequired')
  if (promptBytes.value > PROMPT_MAX_BYTES) return t('agentcron.promptTooLong')
  // 评估时区客户端预校验（P-20261005-217）：与服务端 LoadLocation 同判
  // 「能不能用」，非法名在这里拦截省一次无效往返；服务端保存口仍是事实源
  if (form.value.timezone.trim() && !isValidTimeZone(form.value.timezone.trim())) {
    return t('agentcron.timezone.invalid')
  }
  if (form.value.trigger === 'after' && !form.value.afterCronId) return t('agentcron.parentRequired')
  if (chainCycle()) return t('agentcron.cycleDetected')
  // 接力形态：指定会话模式下 id 必填（服务端按长度兜底，这里拦空值给出本地化提示）
  if (form.value.relayMode === 'session' && !form.value.relaySessionId.trim()) return t('agentcron.relay.sessionRequired')
  return null
}

async function save() {
  const err = validate()
  if (err) {
    message.warning(err)
    return
  }
  saving.value = true
  try {
    const payload = {
      name: form.value.name.trim(),
      hour: form.value.hour,
      minute: form.value.minute,
      weekdays: form.value.weekdays,
      timezone: form.value.timezone.trim(),
      runtime: form.value.runtime,
      prompt: form.value.prompt.trim(),
      dir: form.value.dir.trim(),
      enabled: form.value.enabled,
      missCatchUp: form.value.missCatchUp,
      trigger: form.value.trigger,
      afterCronId: form.value.trigger === 'after' ? form.value.afterCronId : '',
      afterMode: form.value.trigger === 'after' ? form.value.afterMode : '',
      relayFrom: relayFromOfForm(),
      extract: form.value.extract.trim(),
    }
    const res: any = editingId.value
      ? await agentCronApi.update(editingId.value, payload)
      : await agentCronApi.create(payload)
    if (res?.data) {
      await fetchCrons()
    }
    message.success(t('common.saved'))
    showModal.value = false
  } catch (e: any) {
    message.error(e?.userMessage || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function toggle(item: AgentCronItem, enabled: boolean) {
  try {
    await agentCronApi.update(item.id, {
      name: item.name,
      hour: item.hour,
      minute: item.minute,
      weekdays: item.weekdays ?? [],
      timezone: item.timezone || '',
      runtime: item.runtime || '',
      prompt: item.prompt,
      dir: item.dir || '',
      enabled,
      missCatchUp: !!item.missCatchUp,
      // 全量替换语义：依赖字段不携带会被清掉（服务端 applyEditable）
      trigger: item.trigger === 'after' ? 'after' : 'schedule',
      afterCronId: item.afterCronId || '',
      afterMode: item.afterMode === 'always' ? 'always' : 'success',
      relayFrom: item.relayFrom || '',
      extract: item.extract || '',
    })
    await fetchCrons()
  } catch (e: any) {
    message.error(e?.userMessage || t('common.saveFailed'))
  }
}

async function remove(item: AgentCronItem) {
  const ok = await confirmDialog({
    title: t('agentcron.deleteConfirm', { name: item.name }),
    type: 'warning',
    confirmText: t('common.delete'),
  })
  if (!ok) return
  try {
    await agentCronApi.remove(item.id)
    await fetchCrons()
    message.success(t('agentcron.deleted'))
  } catch (e: any) {
    message.error(e?.userMessage || t('agentcron.deleteFailed'))
  }
}

/** 立即试跑：与到期触发同一服务端执行链，成功后刷新会话列表并跳到该会话看现场
 *  （activeId 直设 + 面板打开，与 ClaudeSessionPicker 创建后跳转同款） */
async function runNow(item: AgentCronItem) {
  if (running.value) return
  running.value = item.id
  try {
    const res: any = await agentCronApi.run(item.id)
    if (res?.data?.id) {
      const { useAgentTerminal } = await import('../../composables/useAgentTerminal')
      const at = useAgentTerminal()
      await at.refresh()
      at.activeId.value = String(res.data.id)
      at.open()
      message.success(t('agentcron.runStarted'))
    }
    await fetchCrons()
  } catch (e: any) {
    message.error(e?.userMessage || t('agentcron.runFailed'))
  } finally {
    running.value = ''
  }
}

/** 计划描述：每日 HH:MM / 周几集合 HH:MM */
function scheduleText(item: Pick<AgentCron, 'hour' | 'minute' | 'weekdays'>): string {
  const time = `${String(item.hour).padStart(2, '0')}:${String(item.minute).padStart(2, '0')}`
  const days = (item.weekdays ?? []).length === 0
    ? t('agentcron.everyday')
    : [...item.weekdays!].sort().map(d => t(`agentcron.weekday.${d}`)).join(' ')
  return `${days} ${time}`
}

/** 结果文案（lastResult / 历史条目同词汇：launched / done / failed / skipped / error:<msg>） */
function resultTextOf(result: string): string {
  if (!result) return '—'
  if (result.startsWith('error:')) {
    return t('agentcron.result.error') + result.slice('error'.length)
  }
  return t(`agentcron.result.${result}`)
}

function resultText(item: AgentCronItem): string {
  return resultTextOf(item.lastResult ?? '')
}

// ---- 运行历史迷你列表（P-20261002-143）：行内展开，同分区唯一挂载点 ----
// 错过槽条目（P-20261006-22）并入同一列表按时间混排——「任务为什么没跑」的
// 运维答案与运行事实同屏可读；三态色标：灰 = 未开补偿跳过、绿 = 补跑发起
// 成功、红 = 补跑发起失败

/** 当前展开历史的任务 ID（空 = 全部收起；同屏至多展开一个） */
const historyOpenId = ref('')

function toggleHistory(item: AgentCronItem) {
  historyOpenId.value = historyOpenId.value === item.id ? '' : item.id
}

/** 折叠开关计数：运行 + 错过合并口径（与展开后的行数一致） */
function historyRowCount(item: AgentCronItem): number {
  return (item.history?.length ?? 0) + (item.missedHistory?.length ?? 0)
}

/** 历史展示行：运行条目与错过条目的统一渲染形状（错过条目凭文案里的
 *  「错过 ·」前缀与运行条目区分，色标共用同一 is-* 族） */
interface HistoryDisplayRow {
  key: string
  at: string
  text: string
  cls: string
  err?: string
}

/** 展示序：运行 + 错过合并按时间倒序（服务端两账各自最新在尾） */
function historyRows(item: AgentCronItem): HistoryDisplayRow[] {
  const runs: HistoryDisplayRow[] = (item.history ?? []).map((run, i) => ({
    key: `run-${run.at}-${i}`,
    at: run.at,
    text: resultTextOf(run.result),
    cls: run.result === 'done' ? 'is-ok'
      : run.result === 'launched' ? 'is-run'
        : run.result === 'skipped' ? 'is-muted'
          : 'is-bad', // failed / error:*
    err: run.errSummary || '',
  }))
  const missed: HistoryDisplayRow[] = (item.missedHistory ?? []).map((m, i) => ({
    key: `missed-${m.slot}-${i}`,
    at: m.slot,
    text: missedText(m),
    cls: m.action === 'caught-up' ? 'is-ok' : m.action === 'failed' ? 'is-bad' : 'is-muted',
    err: m.errSummary || '',
  }))
  return [...runs, ...missed].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

/** 错过条目文案（action 与服务端 missedSkipped 等词汇同源；slot 时刻已由
 *  行首时间列承载，文案只说处置结论） */
function missedText(m: AgentCronMissedEntry): string {
  if (m.action === 'caught-up') return t('agentcron.missed.caughtUp')
  if (m.action === 'failed') return t('agentcron.missed.failed')
  return t('agentcron.missed.skipped')
}

// ---- 行内迷你趋势（P-20261005-237）：最近值 + sparkline + 悬停明细 ----
// 判定/坐标/格式全在 utils/cronTrend 纯函数（伴随单测），组件只做装配

function metricValues(item: AgentCronItem): number[] {
  return (item.metric?.points ?? []).map(p => p.value)
}

/** 悬停明细：指标名 + 点数 + 最近 10 点（旧→新，波动点带标记） */
function metricTitle(item: AgentCronItem): string {
  const m = item.metric
  if (!m || m.points.length === 0) return ''
  const values = metricValues(item)
  const flags = anomalyFlags(values)
  const lines = [t('agentcron.extract.trend', { name: m.name, n: m.points.length })]
  const start = Math.max(0, m.points.length - 10)
  if (start > 0) lines.push(t('agentcron.extract.older', { n: start }))
  for (let i = start; i < m.points.length; i++) {
    const p = m.points[i]!
    const mark = flags[i] ? ` ⚠ ${t('agentcron.extract.anomaly')}` : ''
    lines.push(`${formatDateTime(p.at)}  ${formatTrendValue(p.value)}${mark}`)
  }
  return lines.join('\n')
}
</script>

<template>
  <div
    class="agent-cron-manager"
    data-testid="agentcron-manager"
  >
    <div class="header">
      <h4>{{ t('agentcron.title') }}</h4>
      <NButton
        size="tiny"
        data-testid="agentcron-add"
        @click="openAdd"
      >
        {{ t('agentcron.add') }}
      </NButton>
    </div>
    <p class="hint">
      {{ t('agentcron.hint') }}
    </p>
    <!-- 服务器时区对表行（P-20261005-217）：跨时区部署「服务器说的几点」显式可查 -->
    <p
      v-if="serverTZLine"
      class="hint"
      data-testid="agentcron-server-tz"
    >
      {{ serverTZLine }}
    </p>

    <NList
      v-if="crons.length > 0"
      bordered
      class="cron-list"
      data-testid="agentcron-list"
    >
      <NListItem
        v-for="item in crons"
        :key="item.id"
        :data-testid="`agentcron-item-${item.name}`"
      >
        <NThing>
          <template #header>
            <span class="cron-name">{{ item.name }}</span>
            <NTag
              size="tiny"
              :type="item.enabled ? 'success' : 'default'"
              class="state-tag"
            >
              {{ item.enabled ? t('agentcron.enabled') : t('agentcron.disabled') }}
            </NTag>
            <NTag
              v-if="item.timezone"
              size="tiny"
              type="warning"
              class="state-tag"
              :title="t('agentcron.timezone.badgeTitle', { tz: item.timezone })"
              data-testid="agentcron-timezone-tag"
            >
              {{ timezoneBadge(item) }}
            </NTag>
            <NTag
              v-if="item.relayFrom"
              size="tiny"
              type="info"
              class="state-tag"
              :title="relayModeText(item)"
              data-testid="agentcron-relay-tag"
            >
              {{ t('agentcron.relay.tag') }}
            </NTag>
          </template>
          <template #description>
            <div class="meta">
              <span
                class="schedule"
                data-testid="agentcron-schedule"
              >{{ cronPlanText(item) }}</span>
              <span
                v-if="item.runtime"
                class="runtime"
              >{{ item.runtime }}</span>
              <span class="next">{{ t('agentcron.nextRun') }}{{ item.nextRunAt ? formatDateTime(item.nextRunAt) : '—' }}</span>
              <span
                v-if="item.lastRunAt"
                class="last"
                :title="item.lastResult"
              >{{ t('agentcron.lastRun') }}{{ formatDateTime(item.lastRunAt) }} · {{ resultText(item) }}</span>
              <span
                v-if="item.relayFrom && item.lastRelayAt"
                class="relay-result"
                :class="{ 'is-skipped': item.lastRelayNote !== 'relayed' }"
                :title="item.lastRelayNote"
                data-testid="agentcron-relay-result"
              >{{ t('agentcron.relay.last') }}{{ formatDateTime(item.lastRelayAt) }} · {{ relayResultText(item) }}</span>
              <!-- 指标趋势（P-20261005-237）：行内迷你趋势 + 最近值；无数据不渲染（不硬凑） -->
              <span
                v-if="item.metric && item.metric.points.length > 0"
                class="metric"
                :class="{ 'is-anomaly': latestIsAnomaly(metricValues(item)) }"
                :title="metricTitle(item)"
                data-testid="agentcron-metric"
              >
                <svg
                  v-if="item.metric.points.length >= 2"
                  class="metric-spark"
                  viewBox="0 0 60 16"
                  aria-hidden="true"
                >
                  <polyline :points="sparklinePoints(metricValues(item), 60, 16)" />
                </svg>
                <span class="metric-value">{{ item.metric.name }} {{ formatTrendValue(item.metric.points[item.metric.points.length - 1]!.value) }}</span>
              </span>
            </div>
            <div
              v-if="item.prompt"
              class="prompt"
              :title="item.prompt"
            >
              {{ item.prompt }}
            </div>
            <div
              v-if="historyRowCount(item) > 0"
              class="history"
            >
              <button
                class="history-toggle"
                data-testid="agentcron-history-toggle"
                :aria-expanded="historyOpenId === item.id"
                @click="toggleHistory(item)"
              >
                {{ t('agentcron.history.toggle', { n: historyRowCount(item) }) }}
              </button>
              <ol
                v-if="historyOpenId === item.id"
                class="history-list"
                data-testid="agentcron-history-list"
              >
                <li
                  v-for="row in historyRows(item)"
                  :key="row.key"
                  class="history-row"
                >
                  <span class="history-time">{{ formatDateTime(row.at) }}</span>
                  <span
                    class="history-result"
                    :class="row.cls"
                  >{{ row.text }}</span>
                  <span
                    v-if="row.err"
                    class="history-err"
                    :title="row.err"
                  >{{ row.err }}</span>
                </li>
              </ol>
            </div>
          </template>
          <template #action>
            <span class="actions">
              <NButton
                size="tiny"
                quaternary
                type="primary"
                :loading="running === item.id"
                data-testid="agentcron-run"
                @click="runNow(item)"
              >
                {{ t('agentcron.runNow') }}
              </NButton>
              <NButton
                size="tiny"
                quaternary
                @click="edit(item)"
              >
                {{ t('common.edit') }}
              </NButton>
              <NButton
                size="tiny"
                quaternary
                type="error"
                data-testid="agentcron-delete"
                @click="remove(item)"
              >
                {{ t('common.delete') }}
              </NButton>
              <NSwitch
                size="small"
                :value="item.enabled"
                :data-testid="`agentcron-toggle-${item.name}`"
                @update:value="(v: boolean) => toggle(item, v)"
              />
            </span>
          </template>
        </NThing>
      </NListItem>
    </NList>
    <NEmpty
      v-else
      size="small"
      :description="t('agentcron.empty')"
    />

    <!-- 新增 / 编辑弹窗：名称 / 时刻 / 周几 / 运行时 / 工作目录 / 指令 / 启停 -->
    <NModal
      v-model:show="showModal"
      preset="card"
      style="width: var(--modal-w-md); max-width: 94vw"
    >
      <template #header>
        {{ editingId ? t('agentcron.editTitle') : t('agentcron.addTitle') }}
      </template>
      <NForm label-placement="top">
        <NFormItem :label="t('agentcron.fieldName')">
          <NInput
            v-model:value="form.name"
            :placeholder="t('agentcron.fieldNamePlaceholder')"
            :maxlength="120"
            data-testid="agentcron-form-name"
          />
        </NFormItem>
        <NFormItem :label="t('agentcron.trigger')">
          <NSelect
            v-model:value="form.trigger"
            :options="triggerOptions"
            size="small"
            data-testid="agentcron-form-trigger"
          />
        </NFormItem>
        <NFormItem
          v-if="form.trigger === 'schedule'"
          :label="t('agentcron.fieldSchedule')"
        >
          <div class="schedule-row">
            <NSelect
              v-model:value="form.hour"
              :options="hourOptions"
              size="small"
              style="width: 76px"
              data-testid="agentcron-form-hour"
            />
            <span class="colon">:</span>
            <NSelect
              v-model:value="form.minute"
              :options="minuteOptions"
              size="small"
              style="width: 76px"
              data-testid="agentcron-form-minute"
            />
            <NCheckbox
              :checked="form.weekdays.length === 0"
              @update:checked="(v: boolean) => { form.weekdays = v ? [] : [1, 2, 3, 4, 5] }"
            >
              {{ t('agentcron.everyday') }}
            </NCheckbox>
          </div>
          <div class="weekday-row">
            <NCheckbox
              v-for="d in weekdayOptions"
              :key="d.value"
              :checked="form.weekdays.includes(d.value)"
              @update:checked="(v: boolean) => {
                form.weekdays = v
                  ? [...form.weekdays, d.value]
                  : form.weekdays.filter(x => x !== d.value)
              }"
            >
              {{ d.label }}
            </NCheckbox>
          </div>
        </NFormItem>
        <!-- 评估时区（P-20261005-217）：tag 模式允许候选表之外的任意合法 IANA 名 -->
        <NFormItem
          v-if="form.trigger === 'schedule'"
          :label="t('agentcron.timezone.field')"
        >
          <NSelect
            v-model:value="form.timezone"
            :options="timezoneOptions"
            size="small"
            filterable
            tag
            :placeholder="t('agentcron.timezone.placeholder')"
            data-testid="agentcron-form-timezone"
          />
          <div
            class="field-hint"
            data-testid="agentcron-form-timezone-hint"
          >
            {{ evalZoneHint }}
          </div>
        </NFormItem>
        <template v-else>
          <NFormItem :label="t('agentcron.fieldAfterCron')">
            <NSelect
              v-model:value="form.afterCronId"
              :options="parentOptions"
              size="small"
              filterable
              :placeholder="t('agentcron.parentPlaceholder')"
              data-testid="agentcron-form-parent"
            />
          </NFormItem>
          <NFormItem :label="t('agentcron.fieldAfterMode')">
            <NSelect
              v-model:value="form.afterMode"
              :options="afterModeOptions"
              size="small"
              data-testid="agentcron-form-after-mode"
            />
          </NFormItem>
        </template>
        <NFormItem :label="t('agentcron.fieldRuntime')">
          <NSelect
            v-model:value="form.runtime"
            :options="runtimeOptions"
            size="small"
          />
        </NFormItem>
        <NFormItem :label="t('agentcron.fieldDir')">
          <NInput
            v-model:value="form.dir"
            :placeholder="t('agentcron.fieldDirPlaceholder')"
          />
        </NFormItem>
        <NFormItem :label="t('agentcron.fieldPrompt')">
          <NInput
            v-model:value="form.prompt"
            type="textarea"
            :rows="3"
            :placeholder="t('agentcron.fieldPromptPlaceholder')"
            data-testid="agentcron-form-prompt"
          />
          <div
            class="field-hint"
            data-testid="agentcron-form-prompt-vars-hint"
          >
            {{ t('agentcron.promptVarsHint') }}
          </div>
          <span
            class="byte-count"
            :title="t('agentcron.promptVarsQuota')"
            :class="{ over: promptBytes > PROMPT_MAX_BYTES }"
          >{{ promptBytes }}/500</span>
        </NFormItem>
        <NFormItem :label="t('agentcron.relay.field')">
          <NSelect
            v-model:value="form.relayMode"
            :options="relayModeOptions"
            size="small"
            data-testid="agentcron-form-relay-mode"
          />
          <NInput
            v-if="form.relayMode === 'session'"
            v-model:value="form.relaySessionId"
            :placeholder="t('agentcron.relay.sessionPlaceholder')"
            :maxlength="128"
            data-testid="agentcron-form-relay-session"
          />
          <div class="field-hint">
            {{ t('agentcron.relay.hint') }}
          </div>
        </NFormItem>
        <NFormItem :label="t('agentcron.extract.field')">
          <NInput
            v-model:value="form.extract"
            :placeholder="t('agentcron.extract.placeholder')"
            :maxlength="256"
            data-testid="agentcron-form-extract"
          />
          <div class="field-hint">
            {{ t('agentcron.extract.hint') }}
          </div>
        </NFormItem>
        <NFormItem>
          <div class="switch-row">
            <NCheckbox v-model:checked="form.enabled">
              {{ t('agentcron.fieldEnabled') }}
            </NCheckbox>
            <NCheckbox v-model:checked="form.missCatchUp">
              {{ t('agentcron.fieldMissCatchUp') }}
            </NCheckbox>
          </div>
        </NFormItem>
        <p class="form-hint">
          {{ form.trigger === 'after' ? t('agentcron.formHintAfter') : t('agentcron.formHint') }}
        </p>
      </NForm>
      <template #action>
        <div class="modal-actions">
          <NButton
            size="small"
            quaternary
            @click="showModal = false"
          >
            {{ t('common.cancel') }}
          </NButton>
          <NButton
            size="small"
            type="primary"
            :loading="saving"
            data-testid="agentcron-form-save"
            @click="save"
          >
            {{ t('common.save') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.agent-cron-manager {
  margin-top: var(--space-3);
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-1);
}

.header h4 {
  margin: 0;
  font-size: 13px;
  font-weight: var(--fw-semibold);
}

.hint {
  color: var(--text-color-3);
  font-size: 12px;
  margin: 0 0 var(--space-2);
}

.cron-list {
  margin-bottom: var(--space-2);
}

.cron-name {
  font-weight: var(--fw-semibold);
}

.state-tag {
  margin-left: var(--space-2);
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--text-color-3);
}

.schedule { color: var(--text-color-2); font-family: monospace; }
.runtime { font-family: monospace; }
.relay-result { font-family: monospace; }
/* skipped = 接力降级（任务照常跑成的弱警示），黄档弱于失败红 */
.relay-result.is-skipped { color: var(--accent-yellow); }
/* 指标趋势（P-20261005-237）：行内迷你趋势 + 最近值；最新点波动警示黄
 * （P-18 卡片诊断徽标同族的行内 meta 形态，折线走主题强调色零硬编码） */
.metric { display: inline-flex; align-items: center; gap: var(--space-1); font-family: monospace; cursor: default; }
.metric-spark { width: 60px; height: 16px; flex-shrink: 0; }
.metric-spark polyline { fill: none; stroke: var(--brand-accent); stroke-width: 1.2; }
.metric.is-anomaly .metric-value { color: var(--accent-yellow); }
.prompt {
  margin-top: var(--space-1);
  font-size: 12px;
  color: var(--text-color-3);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history {
  margin-top: 6px;
  min-width: 0;
}

.history-toggle {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--text-color-3);
  cursor: pointer;
}
.history-toggle:hover { color: var(--text-color-2); }

.history-list {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
}

.history-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
  line-height: 18px;
  min-width: 0;
}

.history-time {
  color: var(--text-color-3);
  font-family: monospace;
  white-space: nowrap;
}
.history-result { white-space: nowrap; }
.history-result.is-ok { color: var(--accent-green); }
.history-result.is-run { color: var(--text-color-2); }
.history-result.is-muted { color: var(--text-color-3); }
.history-result.is-bad { color: var(--accent-red); }
.history-err {
  flex: 1;
  min-width: 0;
  color: var(--text-color-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.schedule-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.colon { color: var(--text-color-3); }
.weekday-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: var(--space-2);
}

.byte-count {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-color-3);
  align-self: flex-end;
}
.byte-count.over { color: var(--accent-red); }

/* 变量占位符提示（P-20261003-167）：与表单底部 form-hint 同词汇体系，
 * 更小字号贴字段；颜色走主题变量，零硬编码 */
.field-hint {
  width: 100%;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-color-3);
  margin-top: var(--space-1);
}

.switch-row {
  display: flex;
  gap: 18px;
}

.form-hint {
  color: var(--text-color-3);
  font-size: 12px;
  margin: 0;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
