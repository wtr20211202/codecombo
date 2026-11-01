<script setup lang="ts">
/**
 * 单张审批卡（P-20261003-87 自 ApprovalCards 拆出，纯重构零行为变化）：
 * 渲染一张待裁决审批卡的全部卡内面——头部（脉冲点/标题/发起方标签 +
 * 会话名归属芯片 P-20261003-161（store 查名，关闭/未知显截断 id） +
 * 「查看发起会话」「回放」「查看过程实况」三小按钮）/ op 与 target 呈现
 * （路径形态 target 可点击预览 P-20261003-47）/ 裁决按钮族（「先问发起者」
 * P-20261006-50：裁决前向发起会话提问——broadcast-write 写入 + P-2 跳转，
 * 会话已关禁用降级 / 拒绝理由输入行
 * P-20261003-21 + 放行时限三选一弹层 P-20261003-316（P-20261002-126 二次确认
 * 面升级） + 允许一次）。
 * 「查看发起会话」「回放」「查看过程实况」三小按钮）/ impact 结构化徽标行
 * （P-20261003-319：kind 图标+类型徽标+一句话 summary+文件计数，命令清单次行；
 * detail 散文随之折叠为次级，无 impact 老卡不受影响；长 detail 默认 ~3 行
 * 钳制+「展开全部」解钳 P-20261003-258，短 detail 不钳）/ 合并审批「+N 同型
 * 待批」徽标与展开清单（P-20261006-26：主卡挂起队列快照逐条 op+target，细控
 * 出口）/ 同类历史弱行（P-20261005-173：同 op 已裁决记录就近回看——重复裁决
 * 的一致性锚，挂载即查 historyForOp、默认收起可展开、零历史/失败不渲染，只呈现
 * 事实不自动建议动作）/ op 与 target 呈现
 * （路径形态 target 可点击预览 P-20261003-47，点击按探测形态分发：文件开
 * 文件/差异视图、已存在目录树定位 P-20261003-201；悬停浮窗 diff 摘要
 * P-20261003-253 由 TargetDiffPopover 承载；op 行尾 op+target 一键复制
 * P-20261003-81）/ 三按钮裁决（拒绝理由输入行
 * P-20261003-21 + 完全允许 Popconfirm 二次确认 P-20261002-126 + 允许一次）。
 *
 * 【落点注释（P-20261003-87 拆分）】后续涉及「单卡」的案（单卡视觉、头部门
 * 按钮、target 呈现与点击、裁决按钮族、理由行交互）落本文件；堆策略（折叠
 * 摘要条/展开记忆）、键盘分发（P-20261003-1）、跨卡状态（理由行同屏至多一卡
 * 展开）、录制/回放弹层宿主在宿主 ApprovalCards.vue——两文件各改各的，不再
 * 挤同一冲突面。
 *
 * 跨卡协调（状态归宿主，本组件只渲染与上报）：
 * - 理由行开闭与理由文本由宿主经 props 传入（denyOpen/denyReason，同屏至多
 *   一卡展开），确认/收起/点拒绝经事件回传宿主裁决链；本组件只持输入行实例
 *   供宿主展开后聚焦（focusDenyInput，时序与拆分前「赋值 → nextTick →
 *   函数 ref 实例 focus」一致）
 * - 放行时限弹层实例留在卡内，经 showAllowAlwaysConfirm 暴露给宿主键盘键 2
 *   链打开（P-126 二次确认面锚在本卡，P-316 起为三选一档位面）
 * - 裁决/跳转动作在 useApprovalActions（与值班大屏审批卡共用），本组件直接
 *   取用；录制/回放弹层是全局单例，归宿主渲染，本组件只发事件
 */
import { NButton, NIcon, NInput, useMessage } from 'naive-ui'
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useProjectStore } from '../../stores/project'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { projectApi } from '../../api/client'
import { terminalApi } from '../../api/domains/terminal'
import { opsConfirmApi } from '../../api/domains/opsconfirm'
import { useApprovalActions } from '../../composables/useApprovalActions'
import { copyText } from '../../utils/clipboard'
import { hasUncommittedDiff, isDirectoryProbeError, isPathLikeTarget, middleEllipsis, normRelPath } from '../../utils/approvalTarget'
import { maskApprovalSecrets } from '../../utils/sensitiveMask'
import { relativeTimeParts } from '../../utils/relative-time'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../../utils/opsEvents'
import { useEditorTreeLocate } from '../../composables/useEditorTreeLocate'
import type { ComponentPublicInstance } from 'vue'
import type { ApprovalRecord } from '../../api/domains/opsconfirm'
import ApprovalTierPopover from './ApprovalTierPopover.vue'
import TargetDiffPopover from './TargetDiffPopover.vue'
import type { Component } from 'vue'
import {
  AlertCircleOutline,
  ArrowBackOutline,
  CloudUploadOutline,
  CopyOutline,
  RocketOutline,
  TerminalOutline,
  TrashOutline,
} from '@vicons/ionicons5'

const props = defineProps<{
  /** 本卡审批记录（宿主堆渲染单项：pendingList/visibleList 元素） */
  record: ApprovalRecord
  /** 拒绝理由输入行是否展开（宿主跨卡单开状态投影到本卡） */
  denyOpen: boolean
  /** 理由文本（宿主持有，跨卡唯一） */
  denyReason: string
}>()

const emit = defineEmits<{
  'update:denyReason': [value: string]
  'open-deny': []
  'confirm-deny': []
  'close-deny': []
  'open-recording': []
  'open-replay': []
}>()

const { t } = useI18n()
const { agentLabel, decide, jumpToSession } = useApprovalActions()
const message = useMessage()
const projectStore = useProjectStore()
// 目录 target 树定位（P-20261003-201）：编辑器「在文件树中定位」同款派发链
// （先切 files 视图等 FileTreeView 重挂再派事件，防侧栏停在别的视图时丢事件）
const { locateInTree } = useEditorTreeLocate()

/** 理由文本 v-model 桥（v-model 不直接绑 prop——computed get/set 转发宿主） */
const reasonModel = computed({
  get: () => props.denyReason,
  set: (v: string) => emit('update:denyReason', v),
})

// 放行时限三选一弹层实例（P-316 自 P-126 Popconfirm 升级）：命令式入口收口
// open/close，仅被宿主键盘键 2 链调用
const tierPopover = ref<InstanceType<typeof ApprovalTierPopover> | null>(null)
/** 键盘键 2（放行时限）的卡内落点：折叠展开判定归宿主，本卡只负责打开自己的
 *  三选一档位面（弹层锚在本卡，teleport DOM 查询仍在宿主） */
function showAllowAlwaysConfirm(): void {
  tierPopover.value?.open()
}

// 拒绝理由输入行实例：宿主 openDeny 展开后经 focusDenyInput 聚焦（同一时刻
// 至多一行挂载，单值收集即可——挂载赋实例、卸载赋 null，与拆分前同款收集思路）
const denyInput = ref<InstanceType<typeof NInput> | null>(null)
function setDenyInput(inst: Element | ComponentPublicInstance | null): void {
  denyInput.value = (inst as InstanceType<typeof NInput> | null)
}
function focusDenyInput(): void {
  denyInput.value?.focus()
}

/** 输入行键盘：Enter 确认 / Esc 收起（IME 合成中的 Enter 是候选确认，放行；
 *  确认/收起动作归宿主裁决链，本组件只上报） */
function denyInputKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close-deny')
  } else if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    emit('confirm-deny')
  }
}

// ---- target 可点击预览（P-20261003-47）：路径形态 target 点击开文件/差异视图 ----

/** target 点击分发（P-20261003-201 起按探测形态三分）：文件且无未提交差异 →
 *  打开文件；有未提交差异 → 直开 vs HEAD 差异视图；已存在目录（mkdir/目录类
 *  审批）→ 树定位该目录。打开动作走 OPS_OPEN_FILE_AT 既有窗口事件桥（本组件
 *  随宿主挂 App 根在 Layout 之外，useLayoutViews 消费后复用「切回编辑器主区 +
 *  打开/行定位」既有链路）；目录定位复用 useEditorTreeLocate（P-294 编辑器
 *  tab「在文件树中定位」同款派发链——侧栏不在 files 视图时 FileTreeView 未
 *  挂载、事件会丢，该链先切视图等重挂再派发 OPS_LOCATE_IN_TREE，FileTreeView
 *  接收方负责开面板/退最大化/清搜索/逐层展开/滚动高亮）。探测全部静默（点击
 *  链专属失败不弹错——agent 可能引用将新建路径，落空静默）。API 调用只发生
 *  在点击时刻（每击至多 2 次轻量请求：git status + 一次 stat），不进渲染热路径 */
async function openTargetPreview(a: ApprovalRecord): Promise<void> {
  const path = a.target?.trim()
  const pid = projectStore.currentProjectId
  if (!path || !pid) return // 无当前项目上下文：无处落，静默
  let changed = false
  try {
    // 一次 git status（silent）：命中改动文件（非 Untracked）→ 有未提交差异
    const res = await projectApi.status(pid, { silent: true })
    changed = hasUncommittedDiff(res.data || [], path)
  } catch {
    // 非 git 仓库 / 状态查询失败 → 按无差异打开
  }
  if (!changed) {
    try {
      // 存在性探测（一次 stat，silent）：文件存在 → 落到下方开文件
      await projectApi.filePolicy(pid, path, { silent: true })
    } catch (e) {
      // 已存在目录（P-20261003-201）：filePolicy 对目录回 400「path is a
      // directory」（server/api/files/file.go GetFilePolicy 专属响应，与 404
      // 不存在 / 403 越根相区分）——目录审批的知情出口改派树定位，路径先归一
      // 正斜杠相对路径（OPS_LOCATE_IN_TREE detail 契约）；404（将新建路径）
      // 等其余失败维持落空静默（P-47 既有语义）
      if (isDirectoryProbeError(e)) await locateInTree(normRelPath(path))
      return
    }
  }
  window.dispatchEvent(new CustomEvent<OpenFileAtDetail>(OPS_OPEN_FILE_AT, {
    detail: { path, projectId: pid, diffVsHead: changed },
  }))
}

// ---- op+target 一键复制（P-20261003-81）：审批语境转述出口 ----

/** op 行尾小钮：复制 op+target 拼合文本（「他要跑 git push -f origin main」这类
 *  完整命令语境转述给别的 agent/记录/文档时免逐字手抄）。拼合格式与值班大屏
 *  待裁决清单同款（MonitorView lines.push：op + 空格 + target，target 缺省只
 *  复制 op）；target trim 掉首尾空白，粘贴即用。与 target 点击正交——独立
 *  兄弟按钮事件天然隔离，点复制不开文件/差异视图。反馈按 copyText 返回值
 *  分支 toast（健壮性红线：剪贴板一律走 utils/clipboard 的 copyText 降级链，
 *  禁裸 navigator.clipboard） */
async function copyCommandContext(a: ApprovalRecord): Promise<void> {
  // 复制走脱敏后文本（P-20261003-197）：转述出口与卡面所见一致，密钥不出剪贴板
  const text = [a.op, maskApprovalSecrets(a.target ?? '').trim()].filter(Boolean).join(' ')
  if (!text) return
  const ok = await copyText(text)
  if (ok) message.success(t('common.copied'))
  else message.error(t('common.copyFailed'))
}

// ---- 卡头会话名归属（P-20261003-161）：agent 标签旁附发起会话名 ----

// 多会话并行时卡头只有 agent 类型可辨（同类多会话归属不明不敢轻易放行）——
// 发起会话名经 terminal-sessions store 查名（响应式：列表对账/改名即跟随；
// 列表数据面懒拉收口在宿主 ApprovalCards 堆层，单卡只读）。已关闭/未知会话
// 降级显截断 id：取尾 8 位而非头 8 位——term-<UnixNano> 形 id 的区分位在尾部
// 纳秒（头 8 位 'term-17x' 跨月恒同起不到辨识作用），tmux 形 'sc_<hash>-<rand>'
// 的尾部随机段同样高区分度；全 id 留在 title tooltip 供悬停核对
const sessionsStore = useTerminalSessionsStore()
const SESSION_ID_TAIL = 8
/** 会话 id → 展示名（P-161 判据收敛）：列表查名，已关闭/未知降显尾 8 位截断 id
 *  （term-<UnixNano> 形 id 的区分位在尾部纳秒，tmux 形尾部随机段同高区分度）。
 *  卡头芯片（P-161）与同类历史条目（P-173）共用——同一会话在卡上两处呈现同名 */
function sessionNameOf(sid?: string): string {
  if (!sid) return ''
  return sessionsStore.sessions.find(s => s.id === sid)?.name
    || (sid.length > SESSION_ID_TAIL ? '…' + sid.slice(-SESSION_ID_TAIL) : sid)
}
const sessionChip = computed<string>(() => sessionNameOf(props.record.sessionId))

// ---- 「先问发起者」（P-20261006-50）：pending 态裁决前的对话入口 ----

// 发起会话存活性（P-161 同一数据源）：terminal-sessions 列表即活会话全集
// （关闭即对账出列），在列 = 可问，不在列（已关闭/未知）按钮禁用降级——与
// 卡头会话名芯片同一判据，零新增取数。列表由宿主堆层懒拉（ApprovalCards
// pending 在屏 watch），冷启动窗口期短暂禁用、对账到位即自愈（响应式）
const sessionAlive = computed(() => {
  const sid = props.record.sessionId
  return !!sid && sessionsStore.sessions.some(s => s.id === sid)
})

// 提问行状态卡内自持（与理由行的宿主单开不同：问题文本无跨卡共享语义、无
// 键盘热键链，多卡各开各行互不干扰，无需上翻宿主）。展开即预置模板（op +
// approvalId 内联在所发文本里，agent 收到即知道在问哪个操作）——所见即所发
// （写入文本进 agent 输入流 = 用户信任面，不允许发送时二次拼装）
const askOpen = ref(false)
const askText = ref('')
const askSending = ref(false)
const askInput = ref<InstanceType<typeof NInput> | null>(null)

function openAsk(): void {
  askText.value = t('approval.ask.template', { op: props.record.op, id: props.record.id })
  askOpen.value = true
  // 展开即聚焦可打字（同理由行展开后宿主聚焦的手感；本行开闭在卡内，无宿主时序）
  void nextTick(() => askInput.value?.focus())
}

/** 确认发送：文本 + 尾部 \r 经 broadcast-write 写入发起会话（用户令牌调用天然
 *  豁免 AgentGuard，与手动切会话打字完全同级——纯入口聚合，权限面零变化），
 *  成功即收行并自动走 P-2 跳转链切到该会话看回答；written=0（发送间隙会话
 *  消亡）/请求失败都保留输入行原文本，可修正重试（失败可恢复） */
async function confirmAsk(): Promise<void> {
  const sid = props.record.sessionId
  const text = askText.value.trimEnd()
  if (!sid || !text || askSending.value) return
  askSending.value = true
  try {
    const res = await terminalApi.broadcastWrite([sid], text + '\r')
    const written = (res as { data?: { written?: number } })?.data?.written ?? 0
    if (written > 0) {
      message.success(t('approval.ask.sent'))
      askOpen.value = false
      // 会话恰在发送间隙关闭时跳转链内自带降级提示，无需在此预判
      void jumpToSession(sid)
    } else {
      message.warning(t('approval.ask.sendFailed'))
    }
  } catch {
    message.error(t('approval.ask.sendFailed'))
  } finally {
    askSending.value = false
  }
}

/** 输入行键盘：Enter 发送并跳转 / Esc 收起（IME 合成中的 Enter 是候选确认，
 *  放行——与理由输入行同款守卫） */
function askInputKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    askOpen.value = false
  } else if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    void confirmAsk()
  }
}

defineExpose({ showAllowAlwaysConfirm, focusDenyInput })

// ---- impact 结构化徽标行（P-20261003-319）：kind 图标映射 + detail 折叠 ----

// kind → 图标（@vicons/ionicons5 既有依赖，零新增）。服务端枚举校验后只有六类
// 流转；未知 kind（理论上不可达）兜底 other 图标，标签走 i18n 键回退
const impactIcons: Record<string, Component> = {
  delete: TrashOutline,
  reset: ArrowBackOutline,
  'push-force': CloudUploadOutline,
  'remote-exec': TerminalOutline,
  deploy: RocketOutline,
  other: AlertCircleOutline,
}
const impactIcon = computed<Component>(() => impactIcons[props.record.impact?.kind ?? ''] ?? impactIcons.other!)

// detail 折叠为次级（仅 impact 卡生效）：裁决要点已由徽标行速读承载，散文
// detail 默认收起、点「详情」展开；展开后不回折（同一张卡通常只看一眼）。
// 无 impact 老卡不经此分支，detail 保持原样全显（零破坏）
const detailExpanded = ref(false)

// ---- 合并审批「+N 同型待批」徽标与展开清单（P-20261006-26） ----

// 主卡挂起队列快照（服务端聚合：同会话+同 op 短窗口内的后续请求不弹独立卡，
// 排队等本卡同裁决）。徽标折叠为默认态（裁决看主卡即可），展开逐条核对
// op+target 是细控出口（「允许=整批放行」前先看清放行了什么）。展开态本地
// 持有，不随载荷更新回折（同 P-319/P-258 折叠面惯例）
const mergedItems = computed(() => props.record.merged ?? [])
const mergedOpen = ref(false)
// 条目 target 与记录同源脱敏（服务端 MaskApprovalText），渲染兜底再过
// maskApprovalSecrets（旧记录补账 seed 链双保护，同卡面其他出口口径）
const safeMergedTargets = computed(() => mergedItems.value.map(m => maskApprovalSecrets(m.target ?? '')))

// ---- 卡面展示脱敏（P-20261003-197）：记录面与展示面的双保护 ----

// 服务端入库前已过 mask.MaskApprovalText（记录/广播/webhook 同源脱敏），此处
// 渲染兜底再过 maskApprovalSecrets：旧记录补账（seedPending 拉历史 pending，
// 落库于本能力上线前）与广播链回归时不出现明文密钥。target 点击预览仍用原值
// ——脱敏只改密钥形态，普通路径原样，点击链为独立分支。op+target 复制出口
// （copyCommandContext）走脱敏后文本——转述出去的就是卡面所见
const safeTarget = computed(() => maskApprovalSecrets(props.record.target ?? ''))
const safeDetail = computed(() => maskApprovalSecrets(props.record.detail ?? ''))
const safeImpactSummary = computed(() => maskApprovalSecrets(props.record.impact?.summary ?? ''))
const safeImpactCommands = computed(() => (props.record.impact?.commands ?? []).map(maskApprovalSecrets))

// 路径形态 target 的卡面展示文本（P-20261003-231）：长路径 JS 中段截断
// （前 20 + … + 后 24）接替 CSS ellipsis 的单行尾裁——目录前缀吞文件名
// （文件名在尾部恰被裁掉）是长路径展示的主要痛点，中段省略保首尾：头段
// 目录形态可辨、尾段文件名恒完整。title 仍走 safeTarget 全量（悬停核对
// 全路径）。只收口路径形态分支：非路径 target（命令行/含脱敏密钥形）保持
// 既有呈现零变化——卡面密钥遮蔽形的「首尾可读」契约（P-20261003-197）不
// 被中段省略二次破坏
const displayTarget = computed(() => middleEllipsis(safeTarget.value))

// ---- detail 长文本三行钳制（P-20261003-258）：长细节撑爆卡面 ----

/** detail 是否「长」（默认钳到 ~3 行）：显式 >3 行，或总长超阈值（单行长散文
 *  折行后同样溢出三行）。阈值 120 字符 ≈ 卡面 0.8em 字号典型宽度下三行满排，
 *  判定误差两向不对称：误判「长」的代价只是多一个空操作展开钮（钳制无视觉
 *  变化），误判「短」的代价是窄视口下长文本无出口地撑高卡面——故宁长勿短。
 *  判定只决定是否施加钳制与显钮，视觉截断恒由 CSS line-clamp 兜底 */
const DETAIL_FOLD_LINES = 3
const DETAIL_FOLD_CHARS = 120
function isLongDetail(detail: string): boolean {
  return detail.split('\n').length > DETAIL_FOLD_LINES || detail.length > DETAIL_FOLD_CHARS
}

// 长 detail 默认钳 ~3 行（CSS line-clamp 纯视觉截断，文本仍全量在 DOM），点
// 「展开全部」解钳看全量；展开后不回折（与 P-319 impact 详情折叠同理由：同一
// 张卡通常只看一眼）。短 detail 不钳不显钮，呈现零变化
const detailFull = ref(false)
const detailClamped = computed(() => isLongDetail(safeDetail.value) && !detailFull.value)

// ---- 同类历史弱行（P-20261005-173）：重复裁决的一致性锚 ----

// 挂载即查同 op 已裁决记录（服务端 ?historyForOp= 完整串精确匹配 + resolved-only
// + 钳 3 条）。快照语义：只回本卡在场时刻的既有终态，在场期间的新裁决不追更
// （锚是「上次怎么裁的」不是实时对账）；失败静默不渲染（增强信息不弹错，同
// ruleSuggest 惯例）；零历史不渲染（无锚不加行——卡面退化为既有形态）。
// 每卡一请求：pending 卡是人裁决尺度的小集合（堆折叠后可见卡更少），无热路径
// 顾虑；同 op 多卡并发重复查询无害（幂等 GET，省共享缓存的复杂度）
const historyItems = ref<ApprovalRecord[]>([])
const historyOpen = ref(false)
onMounted(async () => {
  try {
    const res = await opsConfirmApi.list({ historyForOp: props.record.op }) as unknown as { data?: ApprovalRecord[] }
    historyItems.value = (res?.data ?? []).filter(a => a.status === 'allowed' || a.status === 'denied')
  } catch { /* 拉取失败静默：弱行退场，裁决面不受影响 */ }
})

/** 条目裁决时刻相对文案（agentTerminal.activity* 族与各宿主同口径；缺/脏时刻
 *  回空串——少一段文案好过渲染 NaN） */
function historyTime(a: ApprovalRecord): string {
  const ts = new Date(a.resolvedAt || a.createdAt || '').getTime()
  if (Number.isNaN(ts)) return ''
  const p = relativeTimeParts(ts)
  return t(`agentTerminal.${p.key}`, { n: p.n })
}

/** 状态点悬浮可读出口（色点之外的非颜色通道）：结果词复用「最近裁决」键 */
function historyStatusWord(a: ApprovalRecord): string {
  return a.status === 'denied' ? t('approval.recent.denied') : t('approval.recent.allowed')
}
</script>

<template>
  <div class="aprv-card">
    <div class="aprv-head">
      <span class="aprv-dot" />
      <span class="aprv-title">{{ t('agentTerminal.approvalTitle') }}</span>
      <span
        class="aprv-agent"
        :title="record.agent || ''"
      >{{ agentLabel(record.agent) }}</span>
      <!-- 会话名归属（P-20261003-161）：agent 标签旁附发起会话名，关闭/未知
           会话降显截断 id（title 留全 id 供核对）；与跳转按钮同门控——无
           sessionId 的老记录不渲染 -->
      <span
        v-if="sessionChip"
        class="aprv-session"
        data-test="aprv-session"
        :title="record.sessionId"
      >{{ sessionChip }}</span>
      <n-button
        v-if="record.sessionId"
        size="tiny"
        quaternary
        class="aprv-jump"
        :title="t('agentTerminal.approvalJumpSession')"
        @click="jumpToSession(record.sessionId)"
      >
        {{ t('agentTerminal.approvalJumpSession') }}
      </n-button>
      <n-button
        v-if="record.sessionId"
        size="tiny"
        quaternary
        class="aprv-jump"
        :title="t('approval.replay.button')"
        data-test="aprv-replay"
        @click="$emit('open-replay')"
      >
        {{ t('approval.replay.button') }}
      </n-button>
      <n-button
        size="tiny"
        quaternary
        class="aprv-jump"
        :title="t('recording.viewProcess')"
        @click="$emit('open-recording')"
      >
        {{ t('recording.viewProcess') }}
      </n-button>
    </div>
    <!-- impact 结构化徽标行（P-20261003-319）：agent 附带时置顶速读——kind 图标+
         类型徽标 + 一句话 summary + 文件计数（存在即可显，显式 0 也是有效计数）；
         命令清单次行等宽呈现（服务端已钳 ≤5 条）。裁决要点先于 detail 散文 -->
    <div
      v-if="record.impact"
      class="aprv-impact"
      data-test="aprv-impact"
    >
      <span
        class="aprv-impact-kind"
        :data-kind="record.impact.kind"
      >
        <n-icon :component="impactIcon" :size="12" />
        {{ t('approval.impact.kind.' + record.impact.kind) }}
      </span>
      <span
        class="aprv-impact-summary"
        data-test="aprv-impact-summary"
        :title="safeImpactSummary"
      >{{ safeImpactSummary }}</span>
      <span
        v-if="record.impact.filesCount !== undefined"
        class="aprv-impact-count"
        data-test="aprv-impact-count"
      >{{ t('approval.impact.filesCount', { n: record.impact.filesCount }) }}</span>
    </div>
    <!-- 关键命令清单（≤5 条，服务端已钳）：等宽小字逐行，比散文 detail 快扫 -->
    <div
      v-if="record.impact?.commands?.length"
      class="aprv-impact-cmds"
      data-test="aprv-impact-cmds"
    >
      <code
        v-for="(cmd, i) in safeImpactCommands"
        :key="i"
      >{{ cmd }}</code>
    </div>
    <!-- 合并审批「+N 同型待批」（P-20261006-26）：同会话同型操作排队等本卡同
         裁决的徽标 + 展开逐条清单（op+target 可见——细控不丢：裁决=整批放行/
         全拒，展开先看清放行了什么）。徽标钮 aria-expanded 语义给读屏；清单
         行 target 全量在 title，卡面省略防撑破 -->
    <div
      v-if="mergedItems.length"
      class="aprv-merged"
      data-test="aprv-merged"
    >
      <button
        type="button"
        class="aprv-merged-toggle"
        data-test="aprv-merged-toggle"
        :aria-expanded="mergedOpen"
        :title="t('approval.merged.toggleTitle', { n: mergedItems.length })"
        @click="mergedOpen = !mergedOpen"
      >
        +{{ mergedItems.length }} {{ t('approval.merged.badge') }}
        <span
          class="aprv-merged-arrow"
          aria-hidden="true"
        >{{ mergedOpen ? '▾' : '▸' }}</span>
      </button>
      <ul
        v-if="mergedOpen"
        class="aprv-merged-list"
        data-test="aprv-merged-list"
      >
        <li
          v-for="(m, i) in mergedItems"
          :key="m.id"
        >
          <span class="aprv-merged-op">{{ record.op }}</span>
          <span
            class="aprv-merged-target"
            :title="safeMergedTargets[i]"
          >{{ safeMergedTargets[i] }}</span>
        </li>
      </ul>
    </div>
    <div class="aprv-op">
      {{ record.op }}
      <!-- target 可点击预览（P-20261003-47）+ 悬停浮窗 diff 摘要（P-20261003-253）：
           路径形态渲染为可点态（下划线+hover 高亮），展示文本走中段省略
           （P-20261003-231：长路径保首尾，文件名恒可见），title 沿用完整
           target 文本（悬停看全路径），外包 TargetDiffPopover 悬停延迟弹
           工作区 diff 摘要（点击链不经过浮窗，P-47 语义保留）；点击按探测
           形态分发：文件开文件/差异视图、已存在目录树定位（P-20261003-201）；
           命令形等非路径 target 走 v-else 纯文本分支（既有呈现零变化）。
           展示文本与 title 均基于脱敏后 safeTarget（P-20261003-197 展示兜底） -->
      <target-diff-popover
        v-if="record.target && isPathLikeTarget(record.target)"
        :target="record.target"
      >
        <button
          type="button"
          class="aprv-target aprv-target-link"
          data-test="aprv-target-link"
          :title="safeTarget"
          @click="openTargetPreview(record)"
        >{{ displayTarget }}</button>
      </target-diff-popover>
      <span
        v-else-if="record.target"
        class="aprv-target"
        :title="safeTarget"
      >{{ safeTarget }}</span>
      <!-- op+target 一键复制（P-20261003-81）：行尾常驻小钮（margin-left:auto
           钉在行末，target 超宽省略时也可见可点），复制完整命令语境的转述出口；
           与 target 可点态（开文件/差异）兄弟隔离互不干扰。@click.stop 防御性
           阻断——op 行未来若挂点击语义不串扰 -->
      <button
        type="button"
        class="aprv-copy"
        data-test="aprv-copy"
        :title="t('approval.copyCommand')"
        @click.stop="copyCommandContext(record)"
      >
        <n-icon :size="12"><CopyOutline /></n-icon>
      </button>
    </div>
    <!-- 同类历史弱行（P-20261005-173）：同 op 已裁决记录就近回看——重复裁决的
         一致性锚（「上次拒了这次别手滑放行」）。默认收起、展开只读清单（状态
         色点+相对时间+会话名摘要）；只呈现事实不自动建议动作（决策辅助非决策
         代理）。零历史/拉取失败不渲染（无锚不加行），与 P-26 合并徽标同族
         toggle 弱行语言；色点结果词在 title（非颜色通道可读） -->
    <div
      v-if="historyItems.length"
      class="aprv-history"
      data-test="aprv-history"
    >
      <button
        type="button"
        class="aprv-history-toggle"
        data-test="aprv-history-toggle"
        :aria-expanded="historyOpen"
        :title="t('approval.history.toggleTitle')"
        @click="historyOpen = !historyOpen"
      >
        {{ t('approval.history.toggle', { n: historyItems.length }) }}
        <span
          class="aprv-merged-arrow"
          aria-hidden="true"
        >{{ historyOpen ? '▾' : '▸' }}</span>
      </button>
      <ul
        v-if="historyOpen"
        class="aprv-history-list"
        data-test="aprv-history-list"
      >
        <li
          v-for="h in historyItems"
          :key="h.id"
          :data-status="h.status"
        >
          <span
            class="aprv-history-dot"
            :data-status="h.status"
            :title="historyStatusWord(h)"
          />
          <span class="aprv-history-time">{{ historyTime(h) }}</span>
          <span
            class="aprv-history-session"
            :title="h.sessionId || ''"
          >{{ sessionNameOf(h.sessionId) }}</span>
        </li>
      </ul>
    </div>
    <!-- detail 散文（P-20261003-319）：impact 卡折叠为次级（默认收起，点「详情」
         展开）；无 impact 老卡保持原样全显（呈现与改动前一致）。长 detail 默认
         三行钳制（P-20261003-258）：视觉截断保卡面可读，文本恒全量在 DOM -->
    <button
      v-if="record.detail && record.impact && !detailExpanded"
      type="button"
      class="aprv-detail-fold"
      data-test="aprv-detail-fold"
      @click="detailExpanded = true"
    >
      {{ t('approval.impact.detailMore') }}
    </button>
    <div
      v-if="record.detail && (!record.impact || detailExpanded)"
      class="aprv-detail"
      :class="{ 'aprv-detail--clamp': detailClamped }"
      data-test="aprv-detail"
    >
      {{ safeDetail }}
    </div>
    <!-- 长 detail 展开全量开关（P-20261003-258）：只在钳制态在场，点击解钳看
         全量（不回折）；视觉复用 .aprv-detail-fold（卡内文案开关同一弱化下划线
         小钮语言），data-test 独立（aprv-detail-fold 是 impact 整段折叠开关） -->
    <button
      v-if="detailClamped"
      type="button"
      class="aprv-detail-fold"
      data-test="aprv-detail-expand"
      @click="detailFull = true"
    >
      {{ t('approval.detail.expand') }}
    </button>
    <div class="aprv-actions">
      <!-- 先问发起者（P-20261006-50）：裁决前向发起会话提问的对话入口（排裁决
           按钮首位呼应「先问再裁」）。无 sessionId 的老记录不渲染（与跳转/回放
           同门控）；会话已关闭/未知（P-161 存活性，同卡头芯片判据）禁用降级，
           title 说明缘由不哑禁 -->
      <n-button
        v-if="record.sessionId"
        size="tiny"
        quaternary
        :disabled="!sessionAlive"
        :title="sessionAlive ? t('approval.ask.buttonTitle') : t('approval.ask.disabledTitle')"
        data-test="aprv-ask"
        @click="openAsk"
      >
        {{ t('approval.ask.button') }}
      </n-button>
      <!-- 拒绝理由（P-20261003-21）：点拒绝展开下方理由输入行（可空确认=原行为），
           键盘 3 直选不经过此行（useApprovalHotkeys 直连 decide，两路共存） -->
      <n-button
        size="tiny"
        quaternary
        :title="t('approval.hotkey.deny')"
        data-test="aprv-deny"
        @click="$emit('open-deny')"
      >
        {{ t('agentTerminal.approvalDeny') }}
      </n-button>
      <!-- 放行时限三选一（P-20261003-316，P-20261002-126 二次确认面升级）：
           切全局审批档位（会话级/24h/永久，落盘持久），误触即静默放开安全面
           ——弹层三选兜一道，选项文案明示各自作用面。z-index 抬过审批卡堆锚点
           （.agent-input-stack 3000，弹层面板 teleport 到 body 默认层级在其下
           会被卡片盖住点不到），低于 modal（10xxx）。键盘裁决（P-20261003-1）
           键 2 经宿主转发的 showAllowAlwaysConfirm 打开本弹层，弹层内 1/2/3
           直选三档 -->
      <approval-tier-popover
        ref="tierPopover"
        @apply="(h) => decide(record.id, true, false, '', h)"
      >
        <n-button
          size="tiny"
          secondary
          type="warning"
          :title="t('approval.hotkey.always')"
          data-test="aprv-always"
        >
          {{ t('agentTerminal.approvalAlways') }}
        </n-button>
      </approval-tier-popover>
      <n-button
        size="tiny"
        type="primary"
        :title="t('approval.hotkey.allowOnce')"
        @click="decide(record.id, true)"
      >
        {{ t('agentTerminal.approvalAllow') }}
      </n-button>
    </div>
    <!-- 拒绝理由输入行（P-20261003-21）：至多一张卡展开（宿主 denyOpen 投影）；
         Enter 确认 / Esc 收起，:maxlength 前端软钳与服务端 200 rune 钳制同口径 -->
    <div
      v-if="denyOpen"
      class="aprv-deny-row"
    >
      <n-input
        :ref="setDenyInput"
        v-model:value="reasonModel"
        size="tiny"
        :maxlength="200"
        :placeholder="t('approval.denyReason.placeholder')"
        data-test="aprv-deny-input"
        @keydown="denyInputKeydown"
      />
      <n-button
        size="tiny"
        type="error"
        data-test="aprv-deny-confirm"
        @click="$emit('confirm-deny')"
      >
        {{ t('approval.denyReason.confirm') }}
      </n-button>
      <n-button
        size="tiny"
        quaternary
        data-test="aprv-deny-cancel"
        @click="$emit('close-deny')"
      >
        {{ t('approval.denyReason.cancel') }}
      </n-button>
    </div>
    <!-- 先问发起者输入行（P-20261006-50）：展开时预置「关于 <op>（审批 <id>）：」
         模板，用户补问题后 Enter/发送并跳转——发送文本=输入框所见全文（所见即
         所发的信任面），经 broadcast-write 写入发起会话后自动跳转过去看回答；
         空文本发送钮禁用（无内容的回车是对 agent 输入流的噪音）。:maxlength 前
         端软钳 500：单行问题量级远小于服务端 64KB data 上限，钳制防误粘大段 -->
    <div
      v-if="askOpen"
      class="aprv-ask-row"
    >
      <n-input
        ref="askInput"
        v-model:value="askText"
        size="tiny"
        :maxlength="500"
        :placeholder="t('approval.ask.placeholder')"
        data-test="aprv-ask-input"
        @keydown="askInputKeydown"
      />
      <n-button
        size="tiny"
        type="primary"
        :loading="askSending"
        :disabled="!askText.trim()"
        data-test="aprv-ask-send"
        @click="confirmAsk"
      >
        {{ t('approval.ask.confirm') }}
      </n-button>
      <n-button
        size="tiny"
        quaternary
        data-test="aprv-ask-cancel"
        @click="askOpen = false"
      >
        {{ t('common.cancel') }}
      </n-button>
    </div>
  </div>
</template>

<style scoped>
/* 单卡视觉（自 ApprovalCards 原样迁入，类名/呈现零变化）：点样式与摘要条点
   同形——scoped 样式不跨组件，.aprv-dot 与下方 keyframes 在宿主各持一份。
   等待裁决警示色走状态语义色等待档（P-20261003-285），与值班大屏审批卡/通知
   警示档同源 */
.aprv-card {
  background: var(--bg-panel); border: 1px solid var(--status-waiting);
  border-left-width: 3px; border-radius: 8px; padding: 10px 12px;
  box-shadow: var(--shadow-pop-lg);
}
.aprv-head { display: flex; align-items: center; gap: 6px; }
.aprv-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--status-waiting);
  animation: aprv-pulse 1.2s ease-in-out infinite;
}
@keyframes aprv-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .aprv-dot { animation: none; }
}
.aprv-title { font-size: 0.82em; font-weight: 600; color: var(--text-primary); }
.aprv-agent {
  margin-left: auto; font-size: 0.72em; line-height: 1.4;
  color: var(--text-secondary); border: 1px solid var(--status-waiting);
  border-radius: 4px; padding: 0 6px; opacity: 0.9;
}
.aprv-jump { font-size: 0.72em; }
/* 会话名芯片（P-20261003-161）：弱于 agent 标签一级（border-subtle 描边）不争
   视觉，超长省略防挤下跳转按钮（全 id 在 title）；颜色全走主题变量 */
.aprv-session {
  font-size: 0.72em; line-height: 1.4; color: var(--text-secondary);
  border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0 6px;
  max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.aprv-op {
  margin-top: 6px; font-size: 0.88em; color: var(--text-primary);
  font-family: monospace; word-break: break-all;
  display: flex; gap: 6px; align-items: baseline;
}
/* target 展示（路径形态文本已 JS 中段省略 P-20261003-231，≤45 码点封顶）：
   ellipsis/nowrap 降级为超窄视口兜底——容器窄于截断后文本时末端继续裁
   （flex 收缩 + overflow hidden 防撑破卡面），正常宽度不触发；overflow
   hidden 同时是 flex 项可收缩（min-width:auto→0）的前提，不可删 */
.aprv-target {
  color: var(--text-muted); font-size: 0.9em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* target 可点态（P-20261003-47）：按钮裸化对齐 span 原呈现（省略样式继承
   .aprv-target），下划线 + hover/focus 高亮提示可点；颜色全走主题变量 */
.aprv-target-link {
  appearance: none; background: none; border: none; padding: 0; margin: 0;
  font: inherit; color: inherit; cursor: pointer; text-align: left;
  text-decoration: underline; text-underline-offset: 2px;
}
.aprv-target-link:hover,
.aprv-target-link:focus-visible { color: var(--text-primary); }
.aprv-target-link:focus-visible {
  outline: 1px solid var(--status-waiting); outline-offset: 1px;
}
/* op 行尾复制小钮（P-20261003-81）：裸化图标钮弱化呈现（不与 target 可点态争
   视觉），margin-left:auto 钉行末——target 超宽省略时仍常驻可见可点；颜色全走
   主题变量，四主题自适应 */
.aprv-copy {
  appearance: none; background: none; border: none; padding: 0 2px; margin: 0;
  margin-left: auto; flex-shrink: 0; align-self: center; line-height: 1;
  display: inline-flex; align-items: center;
  color: var(--text-muted); cursor: pointer;
}
.aprv-copy:hover,
.aprv-copy:focus-visible { color: var(--text-primary); }
.aprv-copy:focus-visible {
  outline: 1px solid var(--status-waiting); outline-offset: 1px;
}
.aprv-detail { margin-top: 4px; font-size: 0.8em; color: var(--text-secondary); line-height: 1.5; }
/* detail 三行钳制（P-20261003-258）：长 detail 默认 ~3 行截断保卡面可读——
   line-clamp 在三引擎（Chromium/Firefox/Safari）统一走 -webkit- 前缀形态，
   是跨平台标准写法；纯视觉截断（文本全量仍在 DOM，无第二数据面），「展开
   全部」开关点击即移除本类恢复块级全显 */
.aprv-detail--clamp {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
/* impact 结构化徽标行（P-20261003-319）：置顶速读——kind 徽标描边与卡片警示色
   同源（status-waiting 等待档），summary 主文案加重；计数弱化为次级芯片。
   颜色全走主题变量，四主题自适应 */
.aprv-impact {
  margin-top: 6px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.aprv-impact-kind {
  display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0;
  font-size: 0.72em; line-height: 1.5; color: var(--text-primary);
  border: 1px solid var(--status-waiting); border-radius: 4px; padding: 0 6px;
}
.aprv-impact-summary {
  font-size: 0.84em; font-weight: 600; color: var(--text-primary);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.aprv-impact-count {
  flex-shrink: 0; font-size: 0.72em; line-height: 1.5;
  color: var(--text-secondary); border: 1px solid var(--border-subtle);
  border-radius: 4px; padding: 0 6px;
}
.aprv-impact-cmds {
  margin-top: 4px; display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.aprv-impact-cmds code {
  font-family: monospace; font-size: 0.76em; color: var(--text-secondary);
  word-break: break-all;
}
/* 合并审批徽标与展开清单（P-20261006-26）：徽标钮描边弱化（与 impact 计数
   芯片同族的次要芯片语言，不与裁决按钮争视觉），展开清单缩进 + 等宽 target
   逐行——细控核对面，行数受服务端上限护栏约束（≤20）不撑爆卡面。
   同类历史弱行（P-20261005-173）与合并徽标同族 toggle 语言（同选择器组——
   两弱行一张卡上呈现一致），清单行只读回看（状态点+相对时间+会话名摘要） */
.aprv-merged { margin-top: 6px; min-width: 0; }
.aprv-merged-toggle,
.aprv-history-toggle {
  appearance: none; background: none; border: none; padding: 0; margin: 0;
  font: inherit; font-size: 0.74em; line-height: 1.5; color: var(--text-secondary);
  cursor: pointer; display: inline-flex; align-items: center; gap: 3px;
  border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0 6px;
}
.aprv-merged-toggle:hover,
.aprv-merged-toggle:focus-visible,
.aprv-history-toggle:hover,
.aprv-history-toggle:focus-visible { color: var(--text-primary); }
.aprv-merged-toggle:focus-visible,
.aprv-history-toggle:focus-visible {
  outline: 1px solid var(--status-waiting); outline-offset: 1px;
}
.aprv-merged-arrow { font-size: 0.9em; }
.aprv-history { margin-top: 6px; min-width: 0; }
.aprv-history-list {
  margin: 4px 0 0; padding: 0 0 0 14px; list-style: disc;
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.aprv-history-list li {
  font-size: 0.76em; color: var(--text-secondary);
  display: flex; gap: 6px; align-items: baseline; min-width: 0;
}
/* 状态色点（P-173）：与「最近裁决」结果分色同源变量（allowed 绿弱化档、
   denied 红），结果词在点 title（非颜色通道可读） */
.aprv-history-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center;
}
.aprv-history-dot[data-status='allowed'] { background: var(--accent-green-dim); }
.aprv-history-dot[data-status='denied'] { background: var(--status-failed); }
.aprv-history-time { flex-shrink: 0; }
.aprv-history-session {
  color: var(--text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.aprv-merged-list {
  margin: 4px 0 0; padding: 0 0 0 14px; list-style: disc;
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.aprv-merged-list li {
  font-size: 0.76em; color: var(--text-secondary);
  display: flex; gap: 6px; align-items: baseline; min-width: 0;
}
.aprv-merged-op { font-family: monospace; flex-shrink: 0; }
.aprv-merged-target {
  font-family: monospace; color: var(--text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
/* detail 折叠开关（仅 impact 卡出现）：裸化小按钮，弱于正文强调于散文本体 */
.aprv-detail-fold {
  appearance: none; background: none; border: none; padding: 0; margin: 4px 0 0;
  font: inherit; font-size: 0.74em; color: var(--text-muted); cursor: pointer;
  text-align: left; text-decoration: underline; text-underline-offset: 2px;
}
.aprv-detail-fold:hover,
.aprv-detail-fold:focus-visible { color: var(--text-primary); }
.aprv-detail-fold:focus-visible { outline: 1px solid var(--status-waiting); outline-offset: 1px; }
.aprv-actions {
  margin-top: 8px; display: flex; justify-content: flex-end; gap: 8px;
  /* 窄屏钳宽（P-20261003-104）后三按钮一行可能放不下——允许换行保可点 */
  flex-wrap: wrap;
}
.aprv-deny-row {
  margin-top: 6px; display: flex; align-items: center; gap: 6px;
}
.aprv-deny-row .n-input { flex: 1; min-width: 0; }
/* 先问发起者输入行（P-20261006-50）：与理由行同族行形态（同行同布局零新语言） */
.aprv-ask-row {
  margin-top: 6px; display: flex; align-items: center; gap: 6px;
}
.aprv-ask-row .n-input { flex: 1; min-width: 0; }
/* 触屏热区放大（P-20261003-128）：手机裁决是移动形态核心动作，tiny 裁决按钮
   （naive-ui 高 22px）远小于 44px 触控指南，触屏误触/难点——coarse 指针（触屏
   为主指针的设备）下裁决按钮行与理由行按钮 min-height 40px + 按钮间距增大；
   fine 指针（桌面鼠标）不进此分支，呈现零变化。naive-ui 高度由 --n-height
   承载，min-height 更大时按 CSS 钳制规则胜出，n-button inline-flex 内容
   垂直居中不受影响；窄屏换行（.aprv-actions flex-wrap，P-104）已有，放大后
   仍不溢出。范围＝裁决动作按钮（三按钮 + 理由行确认/取消 + 提问行确认/取消，
   P-20261006-50 提问是裁决前置动作同面板）；卡头「跳转/
   回放/实况」辅助小钮与值班大屏内联卡（MonitorView 自持呈现）不放大——
   前者非裁决动作，后者是桌面值守面 */
@media (pointer: coarse) {
  .aprv-actions { gap: 12px; }
  .aprv-actions .n-button { min-height: 40px; }
  .aprv-deny-row { gap: 10px; }
  .aprv-deny-row .n-button { min-height: 40px; }
  .aprv-ask-row { gap: 10px; }
  .aprv-ask-row .n-button { min-height: 40px; }
}
</style>
