<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NDropdown, NEmpty, NIcon, NInput, NModal, NPopover, NSpin, useMessage } from 'naive-ui'
import { ArrowRedoOutline, ChatbubbleEllipsesOutline, Checkmark, CloseOutline, CopyOutline, CreateOutline, DocumentTextOutline, EyeOffOutline, EyeOutline, FolderOpenOutline, GitNetworkOutline, PlayOutline, Star, StarOutline, StatsChartOutline, TerminalOutline, TimeOutline } from '@vicons/ionicons5'
import BrandIcon from '../common/BrandIcon.vue'
import InstanceRelayDialog from './InstanceRelayDialog.vue'
import SessionTimeline from './SessionTimeline.vue'
import { useI18n } from '../../composables/useI18n'
import { promptDialog } from '../../composables/useDialog'
import { fetchWithEgressGate } from '../../composables/useEgressGate'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { copyText } from '../../utils/clipboard'
import { createDownloadProgressTracker } from '../../utils/downloadProgress'
import { exportFileName } from '../../utils/exportFileName'
import { isWeakExportPassphrase } from '../../utils/passStrength'
import { claudeApi, type ClaudeSessionInfo, type ClaudeSessionSearchHit } from '../../api/domains/claude'
import { maskSensitive } from '../../utils/sensitiveMask'
import { isLowRemaining } from '../../utils/sessionRelay'
import { fmtLedgerDurationShort, formatLedgerLine, hasLedgerData } from '../../utils/sessionLedger'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { useClaudeRelay } from '../../composables/useClaudeRelay'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useProjectStore } from '../../stores/project'
import { useContextWarnStore } from '../../stores/contextWarn'

/**
 * Claude 会话选择器（P5）：读取 ~/.claude/projects 的本地会话列表，支持
 * id/内容搜索与一键恢复（新开终端注入 `claude --resume <id>`），并提供
 * 键盘导航（↑↓ 选择、Enter 恢复，搜索框内同样生效）。
 *
 * - scope=global：管理页侧栏（首页形态默认全部项目，可筛选）；scope=project：
 *   底部终端浮层（锁定当前项目）
 * - 排序：最后活动时间倒序（最近的永远在第一屏）；星标置顶（P-20261003-67：
 *   服务端分页前重排 + 前端独立「★ 星标」分组）；时间分段「今天/最近 7 天/
 *   最近 30 天/更早」做软分页，服务端 limit=50 + 「加载更多」追加
 * - 人工策展（P-20261003-67）：行内星标切换（乐观更新）+ 备注弹层编辑
 *   （≤200，服务端钳制），备注是全文搜索的额外命中源（命中带「备注」标识）
 * - 恢复 = 新建 agent 会话（dir=会话 cwd，launchArgs=--resume <id>）并
 *   自动打开终端会话管理页接管渲染
 * - 接力（P-20261003-114）：行内「接力」取该会话 timeline 尾部最后一条
 *   assistant 结论注入新会话 launchArgs 前言（跨天任务知识接力，useClaudeRelay）
 * - 从实例接力（P-20261003-218）：工具条入口弹层选来源实例+会话，跨实例只读
 *   拉 timeline 摘要注入本实例新会话（useInstanceRelay 复用接力链，写回零）
 * - 多选批量导出（P-20261003-165）：Ctrl/Cmd+点选 / Shift 范围 / Ctrl+A 全选
 *   可见行，底部操作条「导出选中」→ 服务端流式 zip 归档（每会话一 md/JSONL）；
 *   口令加密可选档（P-20261003-166）：开关开启时归档经口令信封封装下载
 *   （P-29 EncryptWithPassphrase，强度警示复用 P-101），明文缺省不变。
 *   多选仅默认视图可用（P-20261003-237）：隐藏会话不进批量导出面——默认列表
 *   服务端已剔除隐藏行（选择集天然不含），管理视图（hidden=1）不可多选且切换
 *   视图即清选择集；服务端批量端点同口径兜底剔除，显式 id 单导不受限
 */
const props = withDefaults(
  defineProps<{
    scope?: 'global' | 'project'
    /** scope=project 时必传（锁定项目范围） */
    projectId?: string
    /** 浮层形态：显示标题栏与关闭按钮（底部终端工具栏入口用） */
    closable?: boolean
  }>(),
  { scope: 'global', closable: false },
)

const emit = defineEmits<{
  (e: 'close'): void
  /** 恢复/接力成功：携带新建终端会话 id（宿主切回终端会话页签并选中） */
  (e: 'resumed', sessionId: string): void
}>()

const { t } = useI18n()
const message = useMessage()
const sessionsStore = useTerminalSessionsStore()
const projectStore = useProjectStore()
// 上下文警示阈值（P-20261006-33）：低余量判定与警示 tip 文案共用同一档位源
const contextWarn = useContextWarnStore()
const { activeId } = useAgentTerminal()

// ============== 查询状态 ==============
const searchInput = ref('')
const q = ref('')
const filterProjectId = ref('')
const rows = ref<ClaudeSessionInfo[]>([])
const total = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const loaded = ref(false)
const LIMIT = 50

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let querySeq = 0

async function fetchPage(offset: number, append: boolean, opts?: { fresh?: boolean }) {
  const seq = ++querySeq
  if (append) loadingMore.value = true
  else loading.value = true
  try {
    const res = (await claudeApi.sessions({
      projectId: props.scope === 'project' ? props.projectId : filterProjectId.value || undefined,
      q: q.value || undefined,
      limit: LIMIT,
      offset,
      // 压力按需估算（P-20261002-58）：服务端只对活跃会话做尾部 usage 扫描，
      // 非活跃行零额外 IO（管理视图行无需压力徽标，不发）
      withPressure: !hiddenMode.value,
      // 管理视图（P-20261003-112）：hidden=1 只回已隐藏会话（默认视图恒排除）
      hidden: hiddenMode.value || undefined,
    }, opts?.fresh ? { skipInflightDedupe: true } : undefined)) as unknown as { data?: { sessions?: ClaudeSessionInfo[]; total?: number } }
    if (seq !== querySeq) return // 竞态丢弃：已有更新请求在途
    const list = res?.data?.sessions ?? []
    total.value = res?.data?.total ?? 0
    rows.value = append ? [...rows.value, ...list] : list
    // 全量刷新后键盘定位首行（与搜索结果/大纲导航惯例一致）；追加页保持原位
    if (!append) {
      activeIdx.value = list.length > 0 ? 0 : -1
      // 选择集对账（P-135 日报多选先例）：整页刷新（检索/切项目/隐藏视图切换）
      // 后剔除已不在列表的会话，操作条计数不显示陈旧选择；追加页不清
      if (selectedIds.value.size > 0) {
        const alive = new Set(list.map(s => s.id))
        selectedIds.value = new Set([...selectedIds.value].filter(id => alive.has(id)))
      }
      lastSelectIdx.value = -1
    }
    loaded.value = true
  } catch {
    if (seq === querySeq) loaded.value = true // 失败静默：保留现有列表
  } finally {
    if (seq === querySeq) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

function onSearchInput(v: string) {
  if (hiddenMode.value) return // 管理视图不支持内容检索（已隐藏会话不参与检索面）
  searchInput.value = v
  if (!v.trim()) {
    // 清空即时收起全文命中区（防抖尾随的空查询在 runSearch 里同样收口）
    searchHits.value = []
    searchTruncated.value = false
  }
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    q.value = v.trim()
    void fetchPage(0, false)
    void runSearch()
  }, 300)
}

// ============== 全文搜索（P-20261003-19）：跨 transcripts 命中带上下文 ==============
// 列表 q 过滤回答「哪些会话提到」，全文命中区回答「提到时的原文是什么」——
// 结果行点击直达回放弹层并定位到命中时刻（focusAt，P-82 定位高亮），回放内
// 的续聊出口（P-96）承接行动。服务端护栏（单文件 5MB 跳过/会话上限 200/总
// 时限 5s）超限以 truncated 如实提示；命中上下文服务端已做敏感遮蔽
const searchHits = ref<ClaudeSessionSearchHit[]>([])
const searchTruncated = ref(false)
const searchPending = ref(false)
let searchSeq = 0

/** 命中摘要行前端兜底再遮蔽（P-20261004-14）：服务端 search.go 已对上下文/
 * 标题套 P-108，此处按 recording parseCast 的「前端兜底」先例双保险——服务端
 * 遮蔽幂等，重复遮蔽不变形；旧实例/回归路径漏遮也不回显原文。
 * 【实现约定】命中行若加高亮，必须以本函数返回的遮蔽串为高亮输入（先遮蔽
 * 后高亮），不得回退到 l.text 原文 */
function maskedHitLine(text: string): string {
  return maskSensitive(text)
}

async function runSearch() {
  const seq = ++searchSeq
  if (!q.value) {
    searchHits.value = []
    searchTruncated.value = false
    return
  }
  searchPending.value = true
  try {
    const res = (await claudeApi.search({ q: q.value })) as unknown as {
      data?: { hits?: ClaudeSessionSearchHit[]; truncated?: boolean }
    }
    if (seq !== searchSeq) return // 竞态丢弃：已有更新请求在途
    searchHits.value = res?.data?.hits ?? []
    searchTruncated.value = !!res?.data?.truncated
  } catch {
    if (seq === searchSeq) {
      searchHits.value = [] // 失败静默：收起命中区（列表过滤仍可用）
      searchTruncated.value = false
    }
  } finally {
    if (seq === searchSeq) searchPending.value = false
  }
}

/** 命中行 → 回放弹层：会话元数据从命中条目组装（回放只读，不参与恢复守卫
 * 之外的列表语义），focusAt 取首条命中消息时刻——打开即滚动定位到命中处 */
function onHitReplay(h: ClaudeSessionSearchHit) {
  replayFocusAt.value = h.lines[0]?.at ?? ''
  replaySession.value = {
    id: h.sessionId,
    title: h.title,
    cwd: h.cwd ?? '',
    messageCount: 0,
    firstAt: h.lastAt,
    lastAt: h.lastAt,
    sizeBytes: 0,
    active: h.active,
  }
}

function onFilterProject(pid: string) {
  filterProjectId.value = pid
  void fetchPage(0, false)
}

function loadMore() {
  if (rows.value.length < total.value) void fetchPage(rows.value.length, true)
}

function refreshList() {
  // fresh：写后重取豁免 in-flight 合并——紧邻的 curation POST 之后的重取若并入
  // 一个写前发起、仍在途的同键 GET，会拿到写前快照把乐观态回退（fulle2e run7
  // 实测：星标重取并入在途检索 GET，行回退未星标，下一次取消被算成重星标）
  void fetchPage(0, false, { fresh: true })
}

onMounted(() => void fetchPage(0, false))
onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})

// ============== 人工策展层（P-20261003-67）：星标置顶 + 一句人话备注 ==============
// 服务端已做分页前置顶（后页星标也能进第一屏）；前端再把星标行归入独立的
// 「★ 星标」分组（时间分段按 lastAt 归桶会吞掉置顶语义，必须在展示层再分一次）。
// 备注行内弹层编辑（≤200，服务端钳制兜底），保存走部分更新语义（只带 note
// 不动星标）；星标乐观切换 + 失败回滚，成功后重取列表拿服务端置顶排序

// ============== 隐藏/恢复（P-20261003-112）：索引层清理，transcript 文件零触碰 ==============
// 默认视图行「隐藏」（列表/检索/日报随之消失，transcript 文件不动，随时可恢复）；
// 「显示已隐藏」管理开关切到 hidden=1 管理视图（服务端只回隐藏行），行内「恢复」
// 回到默认列表。隐藏/恢复成功后重取列表以服务端为准（total/分页含剔除语义）
const hiddenMode = ref(false)
function toggleHiddenMode() {
  hiddenMode.value = !hiddenMode.value
  // 多选态不跨视图存活（P-20261003-237）：管理视图不可多选，默认视图的选择集
  // 切走即清（批量条随之收起；与检索态同款「视图切换即退出」口径）
  clearSelection()
  // 视图切换即退出检索态（管理视图不支持内容检索，输入框禁用兜底）
  searchInput.value = ''
  q.value = ''
  searchHits.value = []
  searchTruncated.value = false
  void fetchPage(0, false)
}

/** 隐藏/恢复（非乐观：成功后重取，行从默认列表消失/回到管理视图由服务端裁决） */
const hidingId = ref('')
async function setSessionHidden(s: ClaudeSessionInfo, hide: boolean) {
  if (hidingId.value) return
  hidingId.value = s.id
  try {
    await claudeApi.setCuration({ sessionId: s.id, hidden: hide })
    message.success(t(hide ? 'claudeSessions.hide.hideOk' : 'claudeSessions.hide.restoreOk'))
    refreshList()
  } catch {
    message.error(t(hide ? 'claudeSessions.hide.hideFail' : 'claudeSessions.hide.restoreFail'))
  } finally {
    hidingId.value = ''
  }
}

/** 单会话星标切换（乐观更新：立即反馈；失败回滚并提示） */
const starringId = ref('')
async function toggleStar(s: ClaudeSessionInfo) {
  if (starringId.value) return
  starringId.value = s.id
  const prev = !!s.starred
  s.starred = !prev
  try {
    await claudeApi.setCuration({ sessionId: s.id, starred: !prev })
    refreshList() // 服务端置顶排序以服务端为准（分页头部归位）
  } catch {
    s.starred = prev
    message.error(t('claudeSessions.curation.starFail'))
  } finally {
    starringId.value = ''
  }
}

// ============== 多选批量导出（P-20261003-165） ==============
// 文件树多选同款交互（P-20261002-20）：Ctrl/Cmd+点击增删、Shift+点击自锚点
// 范围选中、Ctrl+A 全选可见行；选择集按 id 存储防列表重排漂移（聚合折叠/
// 分页追加不影响已选）。选中 ≥1 时底部操作条出现：计数 + 格式分段（md 渲染
// 文档 / jsonl 原文件本体）+ 口令加密开关（P-20261003-166）+「导出选中」→
// 服务端 zip 归档（每会话一文件 + MANIFEST 清单）。上限 50/批与服务端同值
// 预检（超出禁用导出并批注，服务端 400 兜底）；导出成功清空选择集（归档动作闭环）。
// 多选仅默认视图可用（P-20261003-237 批量导出排除隐藏）：默认列表服务端已剔除
// 隐藏行，选择集天然不含隐藏会话（列表层排除则导出继承）；管理视图（hidden=1）
// 列出的恰是隐藏行，恢复是唯一动作（行点击本就不可恢复）——多选入口一并关闭，
// 批量条不在管理视图出现；切换视图即清选择集，批量态不跨视图存活
const BATCH_LIMIT = 50
const selectedIds = ref(new Set<string>())
/** Shift 范围选择的锚点（展平行号，-1 = 无锚点） */
const lastSelectIdx = ref(-1)
const selectedCount = computed(() => selectedIds.value.size)
const overLimit = computed(() => selectedCount.value > BATCH_LIMIT)
const exportFormat = ref<'md' | 'jsonl'>('md')
// 口令信封档（P-20261003-166）：明文 zip 是缺省档位（简单归档零变化），开关
// 只改本次导出形态、不持久化（归档敏感面逐次显式选择，无「忘记自己开过加密」
// 的静默降级面——每次导出的档位在操作条上恒可见）
const exportEncrypted = ref(false)

function toggleRowSelect(r: RenderRow) {
  const next = new Set(selectedIds.value)
  if (next.has(r.s.id)) next.delete(r.s.id)
  else next.add(r.s.id)
  selectedIds.value = next
  lastSelectIdx.value = r.idx
}

function selectRange(from: number, to: number) {
  const rows = flatRows.value
  const next = new Set(selectedIds.value)
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    const r = rows[i]
    if (r) next.add(r.s.id)
  }
  selectedIds.value = next
}

function clearSelection() {
  selectedIds.value = new Set()
  lastSelectIdx.value = -1
}

/** 行点击分流：Ctrl/Cmd=切换选中、Shift=自锚点范围选中（P-20261002-20 同款）；
 *  选中态下的普通点击只退出多选、不恢复会话——批量操作中途误开新终端是
 *  反直觉副作用，再点一次同行即正常恢复（假设：提案未定夺选中态与行点击
 *  恢复的互斥语义，取「退出批量态优先」）。
 *  管理视图（hidden=1）整行分流直接让位：多选是默认视图能力（P-20261003-237
 *  批量导出排除隐藏），普通点击恢复也早已不可用——隐藏行唯一动作是行内「恢复」 */
function onRowClick(r: RenderRow, e: MouseEvent) {
  if (hiddenMode.value) return
  if (e.ctrlKey || e.metaKey) {
    toggleRowSelect(r)
    return
  }
  if (e.shiftKey && lastSelectIdx.value >= 0) {
    selectRange(lastSelectIdx.value, r.idx)
    return
  }
  if (selectedCount.value > 0) {
    clearSelection()
    return
  }
  void onResume(r.s)
}

const exportingBatch = ref(false)
async function exportSelected() {
  const ids = [...selectedIds.value]
  if (ids.length === 0 || ids.length > BATCH_LIMIT || exportingBatch.value) return
  // 口令信封档（P-20261003-166）：口令两次输入防手误（useRemoteHostTransfer
  // 导出同款链——validate ≥8 把关 + P-101 强度 liveHint 实时警示不阻断），
  // 任一步取消即整体中止不发请求
  let passphrase: string | undefined
  if (exportEncrypted.value) {
    const pass = await promptDialog({
      title: t('claudeSessions.batch.passTitle'),
      label: t('claudeSessions.batch.passHint'),
      placeholder: t('claudeSessions.batch.passPlaceholder'),
      inputType: 'password',
      validate: (v) => (v.length >= 8 ? null : t('claudeSessions.batch.passTooShort')),
      liveHint: (v) => (isWeakExportPassphrase(v) ? { text: t('claudeSessions.batch.weakHint'), type: 'warning' } : null),
    })
    if (pass === null) return
    const pass2 = await promptDialog({
      title: t('claudeSessions.batch.passTitle'),
      label: t('claudeSessions.batch.passConfirmHint'),
      placeholder: t('claudeSessions.batch.passConfirmPlaceholder'),
      inputType: 'password',
      validate: (v) => (v === pass ? null : t('claudeSessions.batch.passMismatch')),
    })
    if (pass2 === null) return
    passphrase = pass
  }
  exportingBatch.value = true
  try {
    // 内容敏感闸（P-20261003-225）：批量此前完全绕过单会话导出的出域闸——
    // 命中且未确认时服务端回 JSON warnings，统一经 fetchWithEgressGate 弹
    // 确认（类型 + 计数），确认后 confirm=1 重试；取消返回 null（零下载、
    // 零成功提示、选择集保留可重试）。口令信封档的响应本身就是合法 JSON
    // 载荷（P-29 信封），allowJsonPayload 放行非闸门 JSON——闸门分流语义
    // 收口仍在 useEgressGate 单处实现。
    // 下载进度驻留 toast（P-20261030-2）：blob 不可直链（POST + 信封/闸门
    // 前置计算），进度经 onDownloadProgress 可见化。每跳自包含一条（确认
    // 重试重新起跳，该跳请求 settle 即收，闸门确认等待期间不挂过期进度条）；
    // 终态提示归下方既有 success/拦截器文案
    const blob = await fetchWithEgressGate(
      confirm => {
        const progress = createDownloadProgressTracker(message, t('claudeSessions.batch.exportProgress'))
        return claudeApi.exportArchive({ ids, format: exportFormat.value, passphrase }, confirm, {
          onDownloadProgress: progress.onProgress,
        }).finally(() => progress.settle()) as unknown as Promise<Blob>
      },
      '',
      { allowJsonPayload: !!passphrase },
    )
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // 下载名客户端合成（claude-sessions-<日期>.zip，拦截器不透 Content-Disposition）；
    // 加密档后缀 .enc.json 与服务端附件名同族（信封是 JSON，明示「加密的 zip」）
    a.download = exportFileName('sessions', new Date(), 'zip') + (passphrase ? '.enc.json' : '')
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    message.success(passphrase
      ? t('claudeSessions.batch.exportOkEnc', { n: ids.length })
      : t('claudeSessions.batch.exportOk', { n: ids.length }))
    clearSelection()
  } catch { /* 拦截器处理 */ }
  finally { exportingBatch.value = false }
}

/** 备注行内弹层：一次只开一行（noteEditingId 定位），草稿共享单份 */
const noteEditingId = ref('')
const noteDraft = ref('')
const noteSaving = ref(false)
function openNoteEditor(s: ClaudeSessionInfo) {
  noteEditingId.value = s.id
  noteDraft.value = s.note ?? ''
}
async function saveNote(s: ClaudeSessionInfo) {
  if (noteSaving.value) return
  noteSaving.value = true
  try {
    await claudeApi.setCuration({ sessionId: s.id, note: noteDraft.value })
    s.note = noteDraft.value // 本地即时呈现（≤200 已由输入框 maxlength 保证）
    noteEditingId.value = ''
    message.success(t('claudeSessions.curation.noteSaved'))
  } catch {
    message.error(t('claudeSessions.curation.noteFail'))
  } finally {
    noteSaving.value = false
  }
}

// ============== 时间过滤 chips（P-20261003-174）：今天/本周/全部 ==============
// 与名称检索（q）AND 叠加、与隐藏管理视图正交（两态都可用）；纯展示层过滤，
// 服务端分页语义不动——窗口外会话经「加载更多」仍可达（rows 追加即重过滤）。
// 时间基点 = lastAt（文件 mtime，最后活动时间，与下方时间分段同源同口径）：
// 任务书所记 CreatedAt 在字段面为 firstAt/lastAt 双时间戳，判「今天跑过哪些」
// 语义归 lastAt（firstAt 是首条消息时刻，会把跨天活跃会话判出「今天」）。
// 「本周」= 滚动 7 天窗口（与时间分段 day7 同式）：日历周起点随 locale 漂移，
// 滚动窗口三平台语义一致
type PickerTimeFilter = 'today' | 'week' | 'all'
const timeFilterMarks: PickerTimeFilter[] = ['today', 'week', 'all']
const timeFilter = ref<PickerTimeFilter>('all')
const timeFilteredRows = computed<ClaudeSessionInfo[]>(() => {
  if (timeFilter.value === 'all') return rows.value
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const start = timeFilter.value === 'today' ? startOfToday : startOfToday - 6 * 86_400_000
  return rows.value.filter(s => new Date(s.lastAt).getTime() >= start)
})

// ============== 时间分段（软分页：最近的一眼看到） + 同题聚合 ==============
interface Bucket {
  label: string
  rows: RenderRow[]
  /** 星标置顶分组（P-20261003-67，恒在分段序列首位） */
  starred?: boolean
}

/** 同题聚合阈值：相同标题+目录的相邻会话 ≥3 条才折叠（1-2 条直接平铺） */
const COLLAPSE_MIN = 3
const expandedGroups = ref(new Set<string>())
function toggleGroup(key: string) {
  const next = expandedGroups.value
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedGroups.value = next
}

interface RenderRow {
  s: ClaudeSessionInfo
  /** 聚合组键（标题+cwd） */
  key: string
  /** 所在组大小（含自身） */
  groupSize: number
  /** 组处于折叠展示：只渲染代表行（最近一条）+ ×N 徽标 */
  collapsed: boolean
  /** 展开后组内非首条（缩进展示） */
  sub: boolean
  /** 展平后的行序号：键盘导航定位与 data-idx 挂钩 */
  idx: number
}

// 相邻同题归组：会话列表按时间倒序，标题+cwd 相同且时间相邻的视为一组
//（自动化/协议测试会产生几十条同题会话，平铺会把列表刷成刷屏噪声）
function aggregate(items: ClaudeSessionInfo[]): RenderRow[] {
  const groups: { key: string; items: ClaudeSessionInfo[] }[] = []
  for (const s of items) {
    const key = `${s.title}\n${s.cwd}`
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(s)
    else groups.push({ key, items: [s] })
  }
  const out: RenderRow[] = []
  for (const g of groups) {
    const head = g.items[0]!
    if (g.items.length >= COLLAPSE_MIN && !expandedGroups.value.has(g.key)) {
      out.push({ s: head, key: g.key, groupSize: g.items.length, collapsed: true, sub: false, idx: -1 })
      continue
    }
    g.items.forEach((s, i) => out.push({ s, key: g.key, groupSize: g.items.length, collapsed: false, sub: i > 0, idx: -1 }))
  }
  return out
}

const buckets = computed<Bucket[]>(() => {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day7 = startOfToday - 6 * 86400_000
  const day30 = startOfToday - 29 * 86400_000
  const b: { label: string; items: ClaudeSessionInfo[] }[] = [
    { label: t('claudeSessions.bucketToday'), items: [] },
    { label: t('claudeSessions.bucket7d'), items: [] },
    { label: t('claudeSessions.bucket30d'), items: [] },
    { label: t('claudeSessions.bucketEarlier'), items: [] },
  ]
  // 星标行先摘出（P-20261003-67）：时间分段按 lastAt 归桶会吞掉置顶语义，
  // 展示层必须把星标行归入独立置顶分组（服务端已分页前置顶，此处纯展示归位）；
  // 管理视图（P-20261003-112）跳过星标分组——隐藏行按时间平铺即可。
  // 数据源 = 时间过滤后的行（P-20261003-174）：时间窗口是外层约束，星标行在
  // 窗口外同样隐藏（置顶不能穿透时间过滤，否则「今天」过滤形同虚设）
  const starred = hiddenMode.value ? [] : timeFilteredRows.value.filter(s => s.starred)
  for (const s of timeFilteredRows.value) {
    if (!hiddenMode.value && s.starred) continue
    const at = new Date(s.lastAt).getTime()
    if (at >= startOfToday) b[0]!.items.push(s)
    else if (at >= day7) b[1]!.items.push(s)
    else if (at >= day30) b[2]!.items.push(s)
    else b[3]!.items.push(s)
  }
  const out: Bucket[] = b
    .filter(x => x.items.length > 0)
    .map(x => ({ label: x.label, rows: aggregate(x.items) }))
  // 置顶分组恒在最前（有星标才出现），组内保持服务端序（LastAt 倒序）
  if (starred.length > 0) {
    out.unshift({ label: t('claudeSessions.curation.bucketStar'), rows: aggregate(starred), starred: true })
  }
  // 展平行序号：键盘导航的全局索引（分段标签不占行号）
  let n = 0
  for (const bk of out) for (const r of bk.rows) r.idx = n++
  return out
})

const flatRows = computed<RenderRow[]>(() => buckets.value.flatMap(b => b.rows))
watch(flatRows, (rows) => {
  if (activeIdx.value >= rows.length) activeIdx.value = rows.length - 1
})

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** cwd 末段目录名：Windows / Unix 分隔符都兼容（标题 tooltip 里看完整路径） */
function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).pop() || cwd
}

// ============== 累计 token 用量徽标（P-20261002-139） ==============
// 服务端全文聚合的精确账目（input+output+cache_read），缺省 = 无 usage 数据。
// 徽标紧凑展示（与日报 formatTokensCompact 同口径），tooltip 给精确总数
function hasUsage(s: ClaudeSessionInfo): boolean {
  return !!s.usage && s.usage.totalTokens > 0
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`
  }
  return `${Math.round((n / 1_000_000) * 10) / 10}M`
}

// ============== 会话 id 展示与复制 ==============
// 恢复/排障（claude --resume <id>、假死重建）需要原始会话 id——列表展示短 id，
// 点击复制完整 id
const COPIED_ID_TTL = 1500
const copiedId = ref('')
let copiedIdTimer: ReturnType<typeof setTimeout> | null = null
async function copySessionId(id: string) {
  const ok = await copyText(id)
  if (!ok) return
  copiedId.value = id
  if (copiedIdTimer) clearTimeout(copiedIdTimer)
  copiedIdTimer = setTimeout(() => { copiedId.value = '' }, COPIED_ID_TTL)
}
onBeforeUnmount(() => { if (copiedIdTimer) clearTimeout(copiedIdTimer) })

// ============== 行右键菜单（P-20261031-1 会话 id 可见性强化） ==============
// id 前 8 位已在 meta 段明文展示（点击复制），但 10px 弱化段的复制入口可发现
// 性差——右键菜单收口显式动作（复制 id / 回放 / 恢复），与 AgentSidebarSessionTree
// 会话菜单同款 manual n-dropdown 惯例
const ctxRow = ref<ClaudeSessionInfo | null>(null)
const ctxMenuX = ref(0)
const ctxMenuY = ref(0)
const ctxMenuShow = computed(() => ctxRow.value !== null)
const ctxOptions = computed(() => [
  { label: t('claudeSessions.ctx.copyId'), key: 'copy-id' },
  { label: t('claudeSessions.replay'), key: 'replay' },
  { label: t('claudeSessions.resume'), key: 'resume', disabled: !!ctxRow.value?.active || !!ctxRow.value?.hidden },
])
function onRowContextmenu(s: ClaudeSessionInfo, e: MouseEvent) {
  ctxRow.value = s
  ctxMenuX.value = e.clientX
  ctxMenuY.value = e.clientY
}
function onCtxSelect(key: string) {
  const s = ctxRow.value
  ctxRow.value = null
  if (!s) return
  if (key === 'copy-id') void copySessionId(s.id)
  else if (key === 'replay') onReplay(s)
  else if (key === 'resume') void onResume(s)
}

// ============== 未命名会话回退显示（P-20261031-1） ==============
// 服务端标题来源 = 首条有效用户消息（无则回退会话 id），且服务端已对「渲染后
// 不可辨」的纯噪声文本硬化（整串 U+FFFD/零宽符——终端二进制输出转发的实测
// 形态）。前端仍保留最后一道防线：旧索引条目自愈前的窗口、远端旧实例代理的
// 数据面仍可能携带噪声标题，渲染即行失语。回退链：可见标题 → 相对时间
//（「3 天前」量级，提案三级链的中段）；id 前 8 位由 meta 段恒显（copySessionId
// 可复制），不再重复展示。回退态灰显 + 行 tooltip 注明「未命名会话」
// 判噪口径与服务端 hasVisibleRunes 对齐（Cc/Cf 全类 + U+FFFD；\s 兜空白含
// Zs 表意空格）——旧实例数据面的控制符纯噪声标题同样行失语，窄白名单会漏
const UNNAMED_TITLE_RE = /^[\s\p{C}\uFFFD]*$/u
function isUnnamedTitle(title: string): boolean {
  return !title || UNNAMED_TITLE_RE.test(title)
}
/** 行标题回退：噪声/空标题 → 相对时间（meta 段已有 id 前 8 位兜底可辨） */
function displayTitle(s: ClaudeSessionInfo): string {
  if (!isUnnamedTitle(s.title)) return s.title
  return relativeTime(s.lastAt)
}
/** tooltip/弹层标题回退：噪声/空标题 → 「未命名会话」明示（相对时间在行内已可见） */
function titleOrUnnamed(title: string): string {
  return isUnnamedTitle(title) ? t('claudeSessions.unnamed') : title
}
function relativeTime(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (min < 1) return t('claudeSessions.rel.now')
  if (min < 60) return t('claudeSessions.rel.minutes', { n: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('claudeSessions.rel.hours', { n: h })
  const d = Math.floor(h / 24)
  if (d < 30) return t('claudeSessions.rel.days', { n: d })
  return t('claudeSessions.rel.months', { n: Math.floor(d / 30) })
}

// ============== 恢复（新开终端注入 claude --resume） ==============
const resumingId = ref('')
async function onResume(s: ClaudeSessionInfo) {
  if (resumingId.value) return
  if (hiddenMode.value) return // 管理视图行不可恢复（恢复走行内「恢复显示」键）
  if (s.active) return // 运行中的对话不允许再恢复：会 fork 出第二个进程写同一历史
  resumingId.value = s.id
  try {
    const info = await sessionsStore.createAgent(
      t('claudeSessions.resumeName', { title: s.title.slice(0, 30) }),
      'claude',
      undefined,
      { dir: s.cwd, launchArgs: `--resume ${s.id}` },
    )
    if (!info) {
      message.error(t('claudeSessions.resumeFail'))
      return
    }
    if (info.launched === false) {
      message.warning(t('claudeSessions.resumeNoRuntime'))
    } else {
      message.success(t('claudeSessions.resumeOk', { title: s.title.slice(0, 30) }))
    }
    // 打开管理页并激活新会话（渲染 claude --resume 的 TUI）
    activeId.value = info.id
    await useAgentTerminal().open('docked')
    emit('resumed', info.id)
  } finally {
    resumingId.value = ''
  }
}

// ============== 接力新会话（P-20261003-114）：旧会话结论注入新会话 ==============
// 取该会话 timeline 尾部最后一条 assistant 结论（越近越相关）装箱进 launchArgs
// 前言，新开 agent 会话——跨天任务的知识接力进全新上下文（与 --resume 续跑
// 互异）。取数/装箱/创建收口 useClaudeRelay；这里只做宿主接线：成功后与恢复
// 同款（activeId 置新会话 → 开 docked 管理页 → emit resumed 让宿主切页签选中，
// 宿主语义就是「选中刚创建的会话」，接力复用同一接线）
const { relayingId, relay } = useClaudeRelay()
async function onRelay(s: ClaudeSessionInfo) {
  const id = await relay(s)
  if (!id) return
  activeId.value = id
  await useAgentTerminal().open('docked')
  emit('resumed', id)
}

// ============== 从实例接力（P-20261003-218）：跨实例会话接力入口 ==============
// 弹层选来源实例 + 会话（远端只读拉 timeline 摘要，写回零），结论注入**本实例**
// 新会话（useInstanceRelay 复用 P-114 链）；成功后与行内接力同一宿主接线
// （activeId 置新会话 → 开 docked 管理页 → emit resumed 切页签选中）。仅
// global 形态（管理页会话中心）暴露——项目浮层聚焦当前项目，跨实例是管理面动作
const showInstanceRelay = ref(false)
async function onInstanceRelayed(id: string) {
  activeId.value = id
  await useAgentTerminal().open('docked')
  emit('resumed', id)
}

// ============== 上下文压力徽标（P-20261002-58） ==============
// 服务端尾部 usage 估算（仅活跃会话携带，percent 为估算值）。档位阈值：
// <60% 弱化、60~80% 中性、>=80% 黄（建议 /compact）、>=95% 红（建议
// /compact 或开新会话）
type PressureTier = 'low' | 'mid' | 'warn' | 'danger'
function pressureTier(p: number): PressureTier {
  if (p >= 95) return 'danger'
  if (p >= 80) return 'warn'
  if (p >= 60) return 'mid'
  return 'low'
}

function pressureTip(p: number): string {
  const v = Math.round(p)
  if (p >= 95) return t('session.pressure.tipNew', { p: v })
  if (p >= 80) return t('session.pressure.tipCompact', { p: v })
  return t('session.pressure.tipOk', { p: v })
}

// ============== 回放时间线（P-20261001-3）：行内入口 + 弹层查看器 ==============
// 回放只读不写，活跃会话同样可看（恢复才禁止——避免双进程写同一对话）。
// focusAt 定位（P-20261002-82）：列表行入口无定位目标（空串=普通回览）；
// 全文命中行入口带命中消息时刻，打开即滚动到命中处
const replaySession = ref<ClaudeSessionInfo | null>(null)
const replayFocusAt = ref('')
function onReplay(s: ClaudeSessionInfo) {
  replayFocusAt.value = ''
  replaySession.value = s
}
function closeReplay() {
  replaySession.value = null
  replayFocusAt.value = ''
}

// ============== 键盘导航（↑↓ 选择、Enter 恢复） ==============
// 恢复会话是高频操作，此前只能鼠标：对齐搜索结果/大纲导航的键盘惯例。
// 监听挂在组件根上（搜索框/行按钮的按键冒泡到此）——不用 window 级监听，
// 否则管理页其他按钮/重命名框的 Enter 会被误当恢复指令。
const activeIdx = ref(-1)
const rootRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)

function scrollKbdRowIntoView() {
  const el = listRef.value?.querySelector<HTMLElement>(`[data-idx="${activeIdx.value}"]`)
  el?.scrollIntoView({ block: 'nearest' })
}

function moveActive(delta: number) {
  const rows = flatRows.value
  if (rows.length === 0) return
  let next = activeIdx.value + delta
  // 末尾继续 ↓ 且还有更多页：先追加，行数到位后再按一次即达
  if (delta > 0 && next >= rows.length && rows.length < total.value) loadMore()
  next = Math.max(0, Math.min(next, rows.length - 1))
  activeIdx.value = next
  void nextTick(scrollKbdRowIntoView)
}

function onRootKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) return
  if (hasBlockingOverlay()) return // 项目筛选等下拉打开时让位
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    // 全选可见行（P-20261002-20 树多选同款）；输入框内让位原生全选；
    // 管理视图让位（多选仅默认视图，P-20261003-237），不拦原生全选
    const el = e.target as HTMLElement | null
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    if (hiddenMode.value) return
    e.preventDefault()
    const next = new Set(selectedIds.value)
    for (const r of flatRows.value) next.add(r.s.id)
    selectedIds.value = next
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    // 单行搜索框里 ↑↓ 原本只移动光标端点，统一让给列表导航
    e.preventDefault()
    moveActive(e.key === 'ArrowDown' ? 1 : -1)
  } else if (e.key === 'Enter') {
    const row = flatRows.value[activeIdx.value]
    if (row && !row.s.active && !hiddenMode.value) {
      // 阻止行按钮的原生 Enter click，避免双重恢复
      e.preventDefault()
      void onResume(row.s)
    }
  }
}

// ============== 项目筛选下拉（仅 global 形态） ==============
const projectFilterOptions = computed(() => [
  { label: t('claudeSessions.scopeAllProjects'), key: '__all__' },
  ...projectStore.projects.map(p => ({ label: p.name, key: p.id })),
])
function onFilterSelect(key: string) {
  onFilterProject(key === '__all__' ? '' : key)
}

defineExpose({ refreshList })
</script>

<template>
  <div
    ref="rootRef"
    class="csp-root"
    tabindex="0"
    @keydown="onRootKeydown"
  >
    <!-- 浮层形态标题栏 -->
    <div
      v-if="props.closable"
      class="csp-head"
    >
      <BrandIcon
        name="claude"
        :size="14"
      />
      <span class="csp-head-title">{{ t('claudeSessions.title') }}</span>
      <button
        class="csp-head-close"
        :title="t('common.close')"
        @click="emit('close')"
      >
        <n-icon size="12">
          <CloseOutline />
        </n-icon>
      </button>
    </div>

    <div class="csp-toolbar">
      <n-input
        size="small"
        clearable
        :disabled="hiddenMode"
        :placeholder="hiddenMode ? t('claudeSessions.hide.searchDisabled') : t('claudeSessions.searchPlaceholder')"
        :value="searchInput"
        @update:value="onSearchInput"
      />
      <n-dropdown
        v-if="props.scope === 'global'"
        trigger="click"
        placement="bottom-end"
        :options="projectFilterOptions"
        @select="onFilterSelect"
      >
        <n-button
          size="small"
          quaternary
          :title="t('claudeSessions.scopeFilter')"
        >
          {{ filterProjectId
            ? projectStore.projects.find(p => p.id === filterProjectId)?.name
            : t('claudeSessions.scopeAllProjects') }}
        </n-button>
      </n-dropdown>
      <!-- 从实例接力（P-20261003-218）：跨实例会话接力入口（仅 global 形态）。
           打开弹层选来源实例+会话，远端只读拉摘要注入本实例新会话 -->
      <n-button
        v-if="props.scope === 'global'"
        size="small"
        quaternary
        data-test="instance-relay-open"
        :title="t('claudeSessions.instanceRelay.toolbarTip')"
        @click="showInstanceRelay = true"
      >
        <template #icon>
          <n-icon size="12">
            <GitNetworkOutline />
          </n-icon>
        </template>
        {{ t('claudeSessions.instanceRelay.toolbar') }}
      </n-button>
      <!-- 显示已隐藏（P-20261003-112）：管理开关，切到 hidden=1 视图（可恢复） -->
      <n-button
        size="small"
        quaternary
        :type="hiddenMode ? 'primary' : 'default'"
        data-test="session-hidden-toggle"
        :title="t('claudeSessions.hide.toggleTip')"
        @click="toggleHiddenMode"
      >
        <template #icon>
          <n-icon size="12">
            <EyeOffOutline />
          </n-icon>
        </template>
        {{ t('claudeSessions.hide.toggle') }}
      </n-button>
    </div>

    <!-- 时间过滤 chips（P-20261003-174）：今天/本周/全部，与名称检索 AND 叠加、
         与隐藏管理视图正交（两态可用）。过滤出空时保持可见（否则无从退出）；
         空列表期不渲染（无会话可筛，给空态留干净版面） -->
    <div
      v-if="rows.length > 0 || timeFilter !== 'all'"
      class="csp-time-chips"
      data-test="session-time-chips"
    >
      <button
        v-for="m in timeFilterMarks"
        :key="m"
        class="csp-time-chip"
        :class="{ active: timeFilter === m }"
        :data-test="`session-time-chip-${m}`"
        @click="timeFilter = m"
      >
        {{ t(`claudeSessions.timeChip.${m}`) }}
      </button>
    </div>

    <div
      ref="listRef"
      class="csp-list"
    >
      <!-- 全文命中区（P-20261003-19）：跨 transcripts 检索结果，点击直达回放
           并定位到命中时刻；与下方列表过滤（id/内容 → 恢复）分工互补 -->
      <div
        v-if="q"
        class="csp-ft"
        data-test="session-search-hits"
      >
        <div class="csp-ft-head">
          <span>{{ t('claudeSessions.search.section', { n: searchHits.length }) }}</span>
          <span
            v-if="searchTruncated"
            class="csp-ft-trunc"
            data-test="session-search-truncated"
          >{{ t('claudeSessions.search.truncated') }}</span>
        </div>
        <div
          v-if="searchHits.length === 0 && !searchPending"
          class="csp-ft-none"
        >
          {{ t('claudeSessions.search.none') }}
        </div>
        <button
          v-for="h in searchHits"
          :key="h.sessionId"
          class="csp-hit"
          data-test="session-search-hit"
          :title="t('claudeSessions.search.hitTip')"
          @click="onHitReplay(h)"
        >
          <span class="csp-hit-main">
            <!-- 未命名回退同口径（P-20261031-1）：命中行标题噪声态灰显 + 明示 -->
            <span
              class="csp-hit-title"
              :class="{ 'is-unnamed': isUnnamedTitle(h.title) }"
            >{{ titleOrUnnamed(h.title) }}</span>
            <!-- 备注命中（P-20261003-67）：来源标识徽标 + 备注原文（服务端已
                 遮蔽，此处前端兜底再遮蔽，与上下文行同口径） -->
            <span
              v-if="h.note"
              class="csp-hit-noteline"
              data-test="search-hit-note"
            >
              <span class="csp-hit-notebadge">{{ t('claudeSessions.curation.badge') }}</span>
              <span
                class="csp-hit-notetext"
                v-text="maskedHitLine(h.note)"
              />
            </span>
            <span
              v-for="(l, i) in h.lines"
              :key="i"
              class="csp-hit-line"
              v-text="maskedHitLine(l.text)"
            />
          </span>
          <span class="csp-hit-meta">
            <span
              class="csp-meta-seg csp-meta-folder"
              :title="h.cwd"
            >
              <n-icon size="10">
                <FolderOpenOutline />
              </n-icon>{{ folderName(h.cwd || '') }}
            </span>
            <span class="csp-meta-seg">
              <n-icon size="10">
                <TimeOutline />
              </n-icon>{{ fmtTime(h.lastAt) }}
            </span>
            <span class="csp-meta-seg csp-meta-id">
              <n-icon size="10">
                <PlayOutline />
              </n-icon>{{ h.sessionId.slice(0, 8) }}
            </span>
          </span>
        </button>
      </div>
      <n-spin
        v-if="loading && !loaded"
        size="small"
        class="csp-loading"
      />
      <n-empty
        v-else-if="timeFilteredRows.length === 0"
        size="small"
        :description="q
          ? t('claudeSessions.noMatch')
          : (timeFilter !== 'all'
            ? t('claudeSessions.timeChip.noMatch')
            : (hiddenMode ? t('claudeSessions.hide.empty') : t('claudeSessions.empty')))"
        class="csp-empty"
      />
      <template v-else>
        <template
          v-for="bucket in buckets"
          :key="bucket.label"
        >
          <div
            class="csp-bucket"
            :class="{ 'csp-bucket-star': bucket.starred }"
            :data-test="bucket.starred ? 'session-star-bucket' : undefined"
          >
            {{ bucket.label }}
          </div>
          <button
            v-for="r in bucket.rows"
            :key="r.s.id"
            class="csp-row"
            :class="{ 'is-active': r.s.active, 'is-kbd-active': r.idx === activeIdx, 'csp-row-sub': r.sub, 'csp-row-hidden': hiddenMode, 'is-selected': selectedIds.has(r.s.id) }"
            :data-idx="r.idx"
            :data-test="`session-row-${r.s.id}`"
            :title="(r.s.active ? t('claudeSessions.activeTip') : `${titleOrUnnamed(r.s.title)}\n${r.s.cwd}`) + (!hiddenMode ? '\n' + t('claudeSessions.batch.rowTip') : '')"
            @click="onRowClick(r, $event)"
            @contextmenu.prevent="onRowContextmenu(r.s, $event)"
          >
            <!-- 多选指示（P-20261003-165）：选中行行首对勾（Ctrl+点击切换） -->
            <span
              v-if="selectedIds.has(r.s.id)"
              class="csp-row-check"
              data-test="session-check"
            >
              <n-icon size="11">
                <Checkmark />
              </n-icon>
            </span>
            <BrandIcon
              name="claude"
              :size="14"
              class="csp-row-icon"
            />
            <span class="csp-row-main">
              <!-- 未命名回退（P-20261031-1）：噪声/空标题显示相对时间并灰显，
                   tooltip 注明「未命名会话」（行 title 由 titleOrUnnamed 承担） -->
              <span
                class="csp-row-title"
                :class="{ 'is-unnamed': isUnnamedTitle(r.s.title) }"
              >{{ displayTitle(r.s) }}</span>
              <!-- 备注预览（P-20261003-67）：单行弱化截断，hover 看全文 -->
              <span
                v-if="r.s.note"
                class="csp-row-notetext"
                data-test="session-note-text"
                :title="r.s.note"
              >{{ r.s.note }}</span>
              <span class="csp-row-meta">
                <span
                  class="csp-meta-seg csp-meta-folder"
                  :title="r.s.cwd"
                >
                  <n-icon size="10">
                    <FolderOpenOutline />
                  </n-icon>{{ folderName(r.s.cwd) }}
                </span>
                <span class="csp-meta-seg">
                  <n-icon size="10">
                    <TimeOutline />
                  </n-icon>{{ fmtTime(r.s.lastAt) }}
                </span>
                <span class="csp-meta-seg">
                  <n-icon size="10">
                    <ChatbubbleEllipsesOutline />
                  </n-icon>{{ r.s.messageCount }}
                </span>
                <!-- 累计 token 用量（P-20261002-139）：精确聚合值，无 ≈（区别于压力徽标的估算语义） -->
                <span
                  v-if="hasUsage(r.s)"
                  class="csp-meta-seg csp-meta-tokens"
                  :title="t('claudeSessions.usage.tip', { n: r.s.usage!.totalTokens })"
                  data-testid="session-tokens"
                >
                  <n-icon size="10">
                    <StatsChartOutline />
                  </n-icon>{{ fmtTokens(r.s.usage!.totalTokens) }}
                </span>
                <!-- 结构化台账（P-20261005-208）：timeline tool_use 会话级聚合
                     （✎改文件去重数 / ⌷命令数 / 跨时短格式），按段零值隐藏——
                     无工具动作的会话整段缺省；hover 提示为本地化完整句 -->
                <span
                  v-if="hasLedgerData(r.s.ledger)"
                  class="csp-meta-seg csp-meta-ledger"
                  data-testid="session-ledger"
                  :title="formatLedgerLine(r.s.ledger, t)"
                >
                  <span
                    v-if="r.s.ledger!.filesWritten > 0"
                    class="csp-ledger-part"
                  >
                    <n-icon
                      size="10"
                      data-icon-action="claude.filesWritten"
                    >
                      <DocumentTextOutline />
                    </n-icon>{{ r.s.ledger!.filesWritten }}
                  </span>
                  <span
                    v-if="r.s.ledger!.commandsRun > 0"
                    class="csp-ledger-part"
                  >
                    <n-icon size="10">
                      <TerminalOutline />
                    </n-icon>{{ r.s.ledger!.commandsRun }}
                  </span>
                  <span
                    v-if="r.s.ledger!.durationMs > 0"
                    class="csp-ledger-part"
                  >{{ fmtLedgerDurationShort(r.s.ledger!.durationMs) }}</span>
                </span>
                <span
                  class="csp-meta-seg csp-meta-id"
                  :title="t('claudeSessions.idCopyTip')"
                  @click.stop="copySessionId(r.s.id)"
                >
                  <n-icon size="10">
                    <CopyOutline />
                  </n-icon>{{ r.s.id.slice(0, 8) }}{{ copiedId === r.s.id ? ' ✓' : '' }}
                </span>
              </span>
            </span>
            <!-- 星标切换（P-20261003-67）：星标行恒显实心星（accent 黄），未星标
                 hover 显现空心星——与恢复/回放角标同款 hover 显现惯例 -->
            <span
              class="csp-row-star"
              :class="{ 'is-on': r.s.starred }"
              data-test="session-star"
              :title="r.s.starred ? t('claudeSessions.curation.unstar') : t('claudeSessions.curation.star')"
              @click.stop="toggleStar(r.s)"
            >
              <n-icon size="11">
                <Star v-if="r.s.starred" />
                <StarOutline v-else />
              </n-icon>
            </span>
            <!-- 隐藏（P-20261003-112）：默认视图行 hover 显现（与星标同款惯例）——
                 索引层移除 + 持久 ignore，transcript 文件零触碰，「显示已隐藏」可恢复 -->
            <span
              v-if="!hiddenMode"
              class="csp-row-hidebtn"
              data-test="session-hide-btn"
              :title="t('claudeSessions.hide.actionTip')"
              @click.stop="setSessionHidden(r.s, true)"
            >
              <n-icon size="11">
                <EyeOffOutline />
              </n-icon>
            </span>
            <!-- 备注编辑（行内弹层）：trigger=manual + noteEditingId 定位，一次
                 只开一行；textarea 键入经 teleport 不入列表键盘导航链 -->
            <n-popover
              trigger="manual"
              :show="noteEditingId === r.s.id"
              placement="bottom-end"
              :width="264"
              @update:show="(v: boolean) => { if (!v && noteEditingId === r.s.id) noteEditingId = '' }"
              @clickoutside="noteEditingId = ''"
            >
              <template #trigger>
                <span
                  class="csp-row-notebtn"
                  data-test="session-note-btn"
                  :title="t('claudeSessions.curation.noteEdit')"
                  @click.stop="openNoteEditor(r.s)"
                >
                  <n-icon
                    size="11"
                    data-icon-action="common.edit"
                  >
                    <CreateOutline />
                  </n-icon>
                </span>
              </template>
              <div
                class="csp-note-editor"
                data-test="note-editor"
                @click.stop
              >
                <n-input
                  v-model:value="noteDraft"
                  type="textarea"
                  size="small"
                  :rows="3"
                  maxlength="200"
                  show-count
                  :placeholder="t('claudeSessions.curation.notePlaceholder')"
                />
                <div class="csp-note-actions">
                  <n-button
                    size="tiny"
                    quaternary
                    :disabled="noteSaving || !noteDraft"
                    @click="noteDraft = ''"
                  >
                    {{ t('claudeSessions.curation.noteClear') }}
                  </n-button>
                  <n-button
                    size="tiny"
                    type="primary"
                    :loading="noteSaving"
                    @click="saveNote(r.s)"
                  >
                    {{ t('claudeSessions.curation.noteSave') }}
                  </n-button>
                </div>
              </div>
            </n-popover>
            <span
              v-if="r.groupSize >= COLLAPSE_MIN"
              class="csp-row-group"
              :title="t('claudeSessions.groupTip', { n: r.groupSize })"
              @click.stop="toggleGroup(r.key)"
            >×{{ r.groupSize }}</span>
            <span
              class="csp-row-replay"
              :title="t('claudeSessions.replayTip')"
              @click.stop="onReplay(r.s)"
            ><n-icon size="10">
              <PlayOutline />
            </n-icon>{{ t('claudeSessions.replay') }}</span>
            <!-- 接力新会话（P-20261003-114）：尾部结论注入新会话前言（跨天任务
                 知识接力）；仅非活跃行——运行中的会话结论未定型；例外：上下文
                 低余量行（P-20261003-141）放开且常显（换代入口不等 hover）。
                 取数中 is-busy 反馈（composable 单飞守卫，双击无害） -->
            <span
              v-if="!r.s.active || isLowRemaining(r.s.pressure, contextWarn.pct)"
              class="csp-row-relay"
              :class="{ 'is-busy': relayingId === r.s.id, 'is-lowctx': isLowRemaining(r.s.pressure, contextWarn.pct) }"
              data-test="session-relay"
              :title="t('claudeSessions.relay.tip')"
              @click.stop="onRelay(r.s)"
            ><n-icon size="10">
              <ArrowRedoOutline />
            </n-icon>{{ t('claudeSessions.relay.badge') }}</span>
            <!-- 上下文压力徽标：仅活跃会话携带（服务端按需估算），≈ 前缀标注估算语义 -->
            <span
              v-if="r.s.pressure"
              class="csp-row-pressure"
              :class="`is-${pressureTier(r.s.pressure.percent)}`"
              :title="pressureTip(r.s.pressure.percent)"
            >≈{{ Math.round(r.s.pressure.percent) }}%</span>
            <!-- 上下文将满警示（P-20261003-141）：余量低于警示阈值恒显（不等 hover——
                 警示要被看见；阈值用户可调 P-20261006-33，缺省 10%），接力动作由同行
                 角标常显承接（P-114 链路）；低余量行必为活跃行（服务端仅对活跃会话
                 估算压力），composable 同口径放开 -->
            <span
              v-if="isLowRemaining(r.s.pressure, contextWarn.pct)"
              class="csp-row-lowctx"
              data-test="session-lowctx"
              :title="t('claudeSessions.lowctx.tip', { pct: contextWarn.pct })"
            >{{ t('claudeSessions.lowctx.badge') }}</span>
            <!-- 管理视图行尾（P-20261003-112）：「已隐藏」徽标 + 恢复显示键 -->
            <span
              v-if="hiddenMode"
              class="csp-row-hiddenbadge"
            >{{ t('claudeSessions.hide.badge') }}</span>
            <span
              v-if="hiddenMode"
              class="csp-row-restore"
              data-test="session-restore-btn"
              :title="t('claudeSessions.hide.restoreTip')"
              @click.stop="setSessionHidden(r.s, false)"
            ><n-icon size="10">
              <EyeOutline />
            </n-icon>{{ t('claudeSessions.hide.restore') }}</span>
            <span
              v-if="!hiddenMode && r.s.active"
              class="csp-row-live"
            ><span class="csp-live-dot" />{{ t('claudeSessions.active') }}</span>
            <span
              v-else-if="!hiddenMode"
              class="csp-row-resume"
            >{{ t('claudeSessions.resume') }}</span>
          </button>
        </template>
        <div
          v-if="rows.length < total"
          class="csp-more"
        >
          <n-button
            size="tiny"
            quaternary
            :loading="loadingMore"
            @click="loadMore"
          >
            {{ t('claudeSessions.loadMore', { n: total - rows.length }) }}
          </n-button>
        </div>
      </template>
    </div>

    <!-- 批量导出操作条（P-20261003-165）：选中 ≥1 出现。计数 + 上限批注
         （≤50/批，超出禁用导出）+ md/JSONL 格式分段 + 口令加密开关
         （P-20261003-166，title 注记两档形态）+ 导出 + 清空选择。
         管理视图恒不出现（多选仅默认视图，P-20261003-237 批量导出排除隐藏——
         结构性门控兜底，与入口守卫双保险） -->
    <div
      v-if="selectedCount > 0 && !hiddenMode"
      class="csp-selbar"
      data-test="session-batch-bar"
    >
      <span
        class="csp-sel-count"
        :class="{ 'is-over': overLimit }"
        data-test="session-batch-count"
      >{{ t('claudeSessions.batch.selected', { n: selectedCount }) }}</span>
      <span
        v-if="overLimit"
        class="csp-sel-note is-over"
        data-test="session-batch-overlimit"
      >{{ t('claudeSessions.batch.overLimit') }}</span>
      <span
        v-else
        class="csp-sel-note"
      >{{ t('claudeSessions.batch.limit') }}</span>
      <span
        class="csp-sel-formats"
        role="group"
        :aria-label="t('claudeSessions.batch.formatLabel')"
      >
        <button
          class="csp-sel-fmt"
          :class="{ 'is-on': exportFormat === 'md' }"
          data-test="session-batch-fmt-md"
          @click="exportFormat = 'md'"
        >{{ t('claudeSessions.batch.fmtMd') }}</button>
        <button
          class="csp-sel-fmt"
          :class="{ 'is-on': exportFormat === 'jsonl' }"
          data-test="session-batch-fmt-jsonl"
          @click="exportFormat = 'jsonl'"
        >{{ t('claudeSessions.batch.fmtJsonl') }}</button>
      </span>
      <button
        class="csp-sel-enc"
        :class="{ 'is-on': exportEncrypted }"
        data-test="session-batch-enc"
        :aria-pressed="exportEncrypted"
        :title="t('claudeSessions.batch.encTip')"
        @click="exportEncrypted = !exportEncrypted"
      >
        {{ t('claudeSessions.batch.enc') }}
      </button>
      <button
        class="csp-sel-export"
        data-test="session-batch-export"
        :disabled="overLimit || exportingBatch"
        @click="exportSelected"
      >
        {{ t('claudeSessions.batch.export') }}
      </button>
      <button
        class="csp-sel-clear"
        data-test="session-batch-clear"
        :title="t('common.close')"
        @click="clearSelection"
      >
        <n-icon size="12">
          <CloseOutline />
        </n-icon>
      </button>
    </div>

    <!-- 回放时间线弹层：transcript 只读回览，恢复与回放互不影响。
         弹层内「继续此会话」（P-20261002-96）成功 = 关弹层并把恢复结果上抛
         （宿主切回终端页签并选中新会话，与列表行恢复同一接线）；
         focus-at（P-20261002-82）：全文命中行入口定位到命中时刻，其余入口空串 -->
    <n-modal
      :show="!!replaySession"
      preset="card"
      :title="replaySession
        ? t('claudeSessions.timelineTitle', { title: titleOrUnnamed(replaySession.title).slice(0, 40) })
        : ''"
      :style="{ width: 'var(--modal-w-lg)', maxWidth: '94vw' }"
      :bordered="false"
      @update:show="(v: boolean) => { if (!v) closeReplay() }"
    >
      <div class="csp-timeline-body">
        <!-- AI 总结发起成功（P-20261003-215）复用 resumed 接线：宿主语义同为
             「选中刚创建的会话」（接力先例），不另开宿主事件 -->
        <SessionTimeline
          v-if="replaySession"
          :session="replaySession"
          :focus-at="replayFocusAt"
          @resumed="(id: string) => { closeReplay(); emit('resumed', id) }"
          @summarized="(id: string) => { closeReplay(); emit('resumed', id) }"
        />
      </div>
    </n-modal>

    <!-- 从实例接力弹层（P-20261003-218）：远端只读拉摘要 → 本实例新会话，
         成功走与行内接力同一宿主接线（选中刚创建的会话） -->
    <InstanceRelayDialog
      :show="showInstanceRelay"
      @update:show="showInstanceRelay = $event"
      @relayed="onInstanceRelayed"
    />

    <!-- 行右键菜单（P-20261031-1）：复制会话 id 显式入口（meta 段弱化段的
         可发现性补位）+ 回放/恢复快捷动作；AgentSidebarSessionTree 会话菜单
         同款 manual n-dropdown 惯例 -->
    <n-dropdown
      trigger="manual"
      :show="ctxMenuShow"
      :options="ctxOptions"
      placement="bottom-start"
      :x="ctxMenuX"
      :y="ctxMenuY"
      @select="onCtxSelect"
      @clickoutside="ctxRow = null"
    />
  </div>
</template>

<style scoped>
.csp-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-panel);
}
.csp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.csp-head-title { font-size: 12px; font-weight: 600; color: var(--text-primary); flex: 1; }
.csp-head-close {
  display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border: none; border-radius: 4px;
  background: transparent; color: var(--text-secondary); cursor: pointer; padding: 0;
}
.csp-head-close:hover { background: var(--bg-hover); color: var(--text-primary); }

.csp-toolbar {
  display: flex;
  flex-wrap: wrap; /* 窄侧栏（默认 ~239px）放不下全部控件时换行——global 形态有
                      项目筛选/从实例接力/显示已隐藏三钮，挤压搜索框会缩到不可用 */
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.csp-toolbar .n-input { flex: 1; min-width: 120px; } /* 换行时搜索框保有可用宽度 */

/* 时间过滤 chips（P-20261003-174）：与 cp-cc-chip 同视觉语（CSS 变量零硬编码色） */
.csp-time-chips { display: flex; gap: 4px; padding: 0 8px 6px; flex-shrink: 0; }
.csp-time-chip {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 10px;
  cursor: pointer;
  transition: all var(--motion-fast);
}
.csp-time-chip:hover { border-color: var(--brand-accent); color: var(--brand-accent); }
.csp-time-chip.active { border-color: currentColor; color: var(--brand-accent); font-weight: 600; }

.csp-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px; }
.csp-empty { padding: 20px 0; }
/* 全文命中区（P-20261003-19）：搜索时置于列表顶部（同容器滚动），命中行
   携带 ≤2 条上下文片段（服务端已遮蔽），点击直达回放 */
.csp-ft { padding-bottom: 4px; }
.csp-ft-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 3px;
  font-size: 10px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.csp-ft-trunc { color: var(--accent-orange, #d97706); text-transform: none; letter-spacing: normal; }
.csp-ft-none { padding: 4px 8px 6px; font-size: 11px; color: var(--text-tertiary); }
.csp-hit {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.csp-hit:hover { background: var(--bg-hover); }
.csp-hit-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.csp-hit-title {
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 上下文片段：弱化单行截断（命中原文在回放里看全貌），anywhere 兼容 CJK/长 token */
.csp-hit-line {
  font-size: 10px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow-wrap: anywhere;
}
.csp-hit-meta { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--text-tertiary); flex-shrink: 0; }
/* 加载转圈居中（对齐 ats-boot / tr-loading 惯例；n-empty 自身居中无需处理） */
.csp-loading { padding: 20px 0; display: flex; justify-content: center; }
.csp-bucket {
  font-size: 10px;
  color: var(--text-tertiary);
  padding: 8px 8px 3px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.csp-row {
  display: flex;
  /* hover 显现徽标放不下时折行而非裁剪（P-20261031-1）：窄宿主 hover 态六个
     显现徽标超行宽，折行保「全部可达」，行高在 hover 期临时增加可接受 */
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.csp-row:hover { background: var(--bg-hover); }
/* 键盘活动行：与 hover 同底色，恢复徽标同步显现（键盘用户需要看见入口） */
.csp-row.is-kbd-active { background: var(--bg-hover); }
.csp-row.is-kbd-active .csp-row-resume { opacity: 1; color: var(--brand-accent); border-color: var(--brand-accent); }
.csp-row-icon { flex-shrink: 0; }
/* min-width 下限（P-20261031-1）：hover/键盘活动行六徽标恢复布局时放不下由
   .csp-row flex-wrap 折行，main 保底可读宽度不被 flex 收缩挤没（静息态
   徽标 display:none，此下限只在显现态生效） */
.csp-row-main { flex: 1; min-width: 120px; display: flex; flex-direction: column; gap: 1px; }
.csp-row-title {
  font-size: 12px;
  color: var(--text-primary);
  /* 长标题两行截断（比单行省略保留更多上下文），hover tooltip 有全文；
     anywhere 保证无空格长 token（路径/哈希/CJK 混排）可断行 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  line-height: 1.35;
  overflow: hidden;
  overflow-wrap: anywhere;
}
/* 未命名回退态（P-20261031-1）：噪声/空标题的相对时间回退值灰显——与正常
   标题一眼可辨，tooltip 明示「未命名会话」；色走主题变量不硬编码 */
.csp-row-title.is-unnamed,
.csp-hit-title.is-unnamed { color: var(--text-tertiary); }
.csp-row-meta { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--text-tertiary); overflow: hidden; }
.csp-meta-seg { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; }
.csp-meta-id { cursor: pointer; font-family: var(--font-mono); }
.csp-meta-id:hover { color: var(--accent-blue); }
/* 累计 token 用量徽标（P-20261002-139）：等宽与压力徽标一致，中性色 */
.csp-meta-tokens { font-family: var(--font-mono); color: var(--text-secondary); }
/* 结构化台账段（P-20261005-208）：等宽弱化（数字与短跨时是语言中立形态，
   本地化完整句在 title）；part 间稍加呼吸感 */
.csp-meta-ledger { font-family: var(--font-mono); color: var(--text-secondary); gap: 5px; }
.csp-ledger-part { display: inline-flex; align-items: center; gap: 2px; }
.csp-meta-folder { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; min-width: 0; }
.csp-row-resume {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-tertiary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 1px 6px;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.csp-row:hover .csp-row-resume { opacity: 1; color: var(--brand-accent); border-color: var(--brand-accent); }
/* 回放角标：与恢复角标同款 hover 显现（只读操作，活跃会话同样可用） */
.csp-row-replay {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--text-tertiary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 1px 6px;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.csp-row-replay:hover { color: var(--accent-blue); border-color: var(--accent-blue); }
.csp-row:hover .csp-row-replay,
.csp-row.is-kbd-active .csp-row-replay { opacity: 1; }
/* 接力角标（P-20261003-114）：与恢复/回放角标同款 hover 显现；绿色=出发语义
   （区别于回放的蓝/恢复的品牌色）；取数中虚线边框常显 */
.csp-row-relay {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--text-tertiary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 1px 6px;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.csp-row-relay:hover { color: var(--accent-green); border-color: var(--accent-green); }
.csp-row:hover .csp-row-relay,
.csp-row.is-kbd-active .csp-row-relay { opacity: 1; }
.csp-row-relay.is-busy { opacity: 1; border-style: dashed; pointer-events: none; }
.csp-row-relay.is-lowctx { opacity: 1; }
/* 上下文将满警示标（P-20261003-141）：红档描边恒显（与压力徽标红档同色系，
   语义是其「该行动了」的升级），动作由同行接力角标常显承接 */
.csp-row-lowctx {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 6px;
  border: 1px solid var(--accent-red);
  border-radius: 4px;
  color: var(--accent-red);
  font-weight: 600;
}
.csp-timeline-body {
  height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.csp-timeline-body > :deep(*) { flex: 1; min-height: 0; }
/* 同题聚合：×N 计数徽标（折叠组头行）；展开后的组内子行缩进呈现 */
.csp-row-group {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
}
.csp-row-group:hover { color: var(--text-primary); background: var(--border-default); }
.csp-row-sub { padding-left: 22px; }
/* 人工策展层（P-20261003-67）：置顶分组标签带星标色；星标恒显/未星标 hover
   显现（与恢复/回放角标同款惯例）；备注预览单行弱化截断 */
.csp-bucket-star { color: var(--accent-yellow); }
.csp-row-star {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.csp-row-star:hover { color: var(--accent-yellow); }
.csp-row-star.is-on { opacity: 1; color: var(--accent-yellow); }
.csp-row:hover .csp-row-star,
.csp-row.is-kbd-active .csp-row-star { opacity: 1; }
/* 隐形 hover 显现钮不拦行点击（P-112 修复轮）：opacity:0 期间 pointer-events:none
   ——右侧钮群随历次策展/导出能力增多已挤进行幅中央，隐形钮拦截行中点击会让
   「点行恢复」落在备注编辑上（触屏/无 hover 设备无 hover 前置，尤甚）；可见性
   恢复处（hover/kbd-active/常显 is-on）一并恢复可点击——视觉可点与实际可点恒一致。
   指定钮点击（Playwright/真人）先 hover 目标即经 row:hover 恢复，交互不受影响 */
.csp-row-star,
.csp-row-hidebtn,
.csp-row-notebtn,
.csp-row-replay,
.csp-row-resume { pointer-events: none; }
.csp-row-star.is-on,
.csp-row:hover .csp-row-star,
.csp-row.is-kbd-active .csp-row-star,
.csp-row:hover .csp-row-hidebtn,
.csp-row.is-kbd-active .csp-row-hidebtn,
.csp-row:hover .csp-row-notebtn,
.csp-row.is-kbd-active .csp-row-notebtn,
.csp-row:hover .csp-row-replay,
.csp-row.is-kbd-active .csp-row-replay,
.csp-row:hover .csp-row-resume,
.csp-row.is-kbd-active .csp-row-resume { pointer-events: auto; }
/* 隐藏操作（P-20261003-112）：与星标同款 hover 显现；弱化中性色（低危可逆操作） */
.csp-row-hidebtn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.csp-row-hidebtn:hover { color: var(--text-primary); }
.csp-row:hover .csp-row-hidebtn,
.csp-row.is-kbd-active .csp-row-hidebtn { opacity: 1; }
/* 管理视图行：不可点击恢复（恢复走行内键），「已隐藏」徽标 + 恢复键恒显 */
.csp-row-hidden { cursor: default; }
.csp-row-hidden:hover { background: transparent; }
.csp-row-hiddenbadge {
  flex-shrink: 0;
  font-size: 9px;
  line-height: 1;
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid var(--border-default);
  color: var(--text-tertiary);
}
.csp-row-restore {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--brand-accent);
  border: 1px solid var(--brand-accent);
  border-radius: 4px;
  padding: 1px 6px;
  cursor: pointer;
}
.csp-row-restore:hover { background: var(--bg-hover); }
.csp-row-notebtn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.csp-row-notebtn:hover { color: var(--accent-blue); }
.csp-row:hover .csp-row-notebtn,
.csp-row.is-kbd-active .csp-row-notebtn { opacity: 1; }
.csp-row-notetext {
  font-size: 10px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow-wrap: anywhere;
}
/* 全文命中区的备注标识（P-20261003-67）：「备注」徽标 + 原文（服务端已遮蔽） */
.csp-hit-noteline {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.csp-hit-notebadge {
  flex-shrink: 0;
  font-size: 9px;
  line-height: 1;
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid var(--accent-yellow);
  color: var(--accent-yellow);
}
.csp-hit-notetext {
  font-size: 10px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow-wrap: anywhere;
}
/* 备注行内弹层编辑器（n-popover 内容，teleport 到 body） */
.csp-note-editor { display: flex; flex-direction: column; gap: 6px; }
.csp-note-actions { display: flex; justify-content: flex-end; gap: 6px; }
/* 活跃会话（正被活终端写入）：恢复入口隐藏，恒显"进行中"徽标 */
.csp-row.is-active { cursor: default; }
.csp-row.is-active:hover { background: transparent; }
.csp-row-live {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--accent-green);
}
.csp-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-green);
  animation: csp-live-pulse 1.6s ease-in-out infinite;
}
@keyframes csp-live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
/* 上下文压力徽标（P-20261002-58，仅活跃行携带）：<60% 弱化、60~80% 中性、
   >=80% 黄、>=95% 红；≈ 前缀 + title 提示估算语义与 /compact 建议 */
.csp-row-pressure {
  flex-shrink: 0;
  font-size: 10px;
  font-family: var(--font-mono);
  padding: 1px 6px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-secondary);
}
.csp-row-pressure.is-low { color: var(--text-tertiary); border-color: transparent; }
.csp-row-pressure.is-warn { color: var(--accent-yellow); border-color: var(--accent-yellow); }
.csp-row-pressure.is-danger { color: var(--accent-red); border-color: var(--accent-red); font-weight: 600; }
.csp-more { display: flex; justify-content: center; padding: 6px 0; }
/* 多选批量导出（P-20261003-165）：选中行淡品牌色底 + 行首对勾（随行渲染，
   滚动/重排不丢）；操作条吸底，计数超限黄色警示 */
.csp-row.is-selected { background: color-mix(in srgb, var(--brand-accent) 12%, transparent); }
.csp-row.is-selected:hover { background: color-mix(in srgb, var(--brand-accent) 18%, transparent); }
.csp-row-check {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  color: var(--brand-accent);
}
.csp-selbar {
  display: flex;
  /* 侧栏宿主可窄至 ~240px，子项不换行会横向溢出被相邻主区盖住（按钮可见
     却点不中）——窄容器折行、行距紧凑，宽宿主仍单行右对齐 */
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--border-default);
  flex-shrink: 0;
  background: var(--bg-panel);
}
.csp-sel-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--brand-accent);
  flex-shrink: 0;
}
.csp-sel-count.is-over { color: var(--accent-yellow); }
.csp-sel-note {
  font-size: 10px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.csp-sel-note.is-over { color: var(--accent-yellow); }
.csp-sel-formats {
  display: inline-flex;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  overflow: hidden;
  margin-left: auto;
  flex-shrink: 0;
}
.csp-sel-fmt {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 10px;
  padding: 2px 8px;
  cursor: pointer;
}
.csp-sel-fmt + .csp-sel-fmt { border-left: 1px solid var(--border-default); }
.csp-sel-fmt.is-on { background: var(--bg-hover); color: var(--brand-accent); font-weight: 600; }
/* 口令加密开关（P-20261003-166）：格式分段同族的独立小片钮，开启态描边强调
   （与格式分段 is-on 的填充态区分——开关与档位选择是两类控件）；间距承接
   formats 组的 margin-left:auto 推右后的自然流式排布 */
.csp-sel-enc {
  flex-shrink: 0;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 10px;
  padding: 2px 8px;
  cursor: pointer;
}
.csp-sel-enc:hover { border-color: var(--text-secondary); }
.csp-sel-enc.is-on { border-color: var(--brand-accent); color: var(--brand-accent); font-weight: 600; }
.csp-sel-export {
  flex-shrink: 0;
  border: 1px solid var(--brand-accent);
  border-radius: 4px;
  background: transparent;
  color: var(--brand-accent);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 10px;
  cursor: pointer;
}
.csp-sel-export:hover { background: color-mix(in srgb, var(--brand-accent) 12%, transparent); }
.csp-sel-export:disabled { opacity: 0.45; cursor: not-allowed; }
.csp-sel-clear {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
}
.csp-sel-clear:hover { background: var(--bg-hover); color: var(--text-primary); }
/* 隐形 hover 显现钮静息态移出布局（P-20261031-1 行失语根因修复）：六钮
   （星标/隐藏/备注/回放/接力/恢复）opacity:0 期间仍占布局（合计 ~187px 徽标
   + 15px 钮×3），~240px 侧栏行宽下把 .csp-row-main（flex:1 = basis 0%，
   min-width:0）挤成零宽——标题与 meta 全列不可见，整列表剩「只花标无文字」
   （用户 2026-10-31 截图实测根因，flex 计算与浏览器无关）。静息 display:none
   换标题全程可读；hover/键盘活动/常显态（is-on/is-lowctx/is-busy）恢复原
   display。display 切换不吃 opacity 过渡（显现为瞬时出现），折行由
   .csp-row flex-wrap 承接，触屏无 hover 设备语义与 P-112 姿态一致（隐形钮
   本就不可达）。规则置于样式块末尾：各钮自身规则（display: inline-flex）
   在前，同特异性靠后覆盖静息态 */
.csp-row-star,
.csp-row-hidebtn,
.csp-row-notebtn,
.csp-row-replay,
.csp-row-relay,
.csp-row-resume { display: none; }
.csp-row-star.is-on,
.csp-row:hover .csp-row-star,
.csp-row.is-kbd-active .csp-row-star,
.csp-row:hover .csp-row-hidebtn,
.csp-row.is-kbd-active .csp-row-hidebtn,
.csp-row:hover .csp-row-notebtn,
.csp-row.is-kbd-active .csp-row-notebtn,
.csp-row:hover .csp-row-replay,
.csp-row.is-kbd-active .csp-row-replay,
.csp-row:hover .csp-row-relay,
.csp-row.is-kbd-active .csp-row-relay,
.csp-row-relay.is-lowctx,
.csp-row-relay.is-busy { display: inline-flex; }
.csp-row:hover .csp-row-resume,
.csp-row.is-kbd-active .csp-row-resume { display: inline; }
</style>
