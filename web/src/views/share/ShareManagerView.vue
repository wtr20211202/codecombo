<script setup lang="ts">
// 文件分享管理视图：主区级视图（与远程控制台同层级互斥）。
// 全部短链一览：复制/打开/二维码 + 「更多」（口令/留言/刷新/轮换/撤销），
// 单条撤销 + 多选批量撤销 + 子服务就绪态提示；窄屏靠 scroll-x 与固定操作列
// 保持可用（P-20261020-9）。
// 风格与主应用面板体系一致（bg-surface 卡片 + 主题变量，无独立渐变皮肤）
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NButton, NCheckbox, NDataTable, NDropdown, NEmpty, NIcon, NInput, NModal, NPagination, NQrCode, NSpin, NTag, NTooltip, useDialog, useMessage,
} from 'naive-ui'
import type { DataTableColumns, DropdownDividerOption, DropdownOption } from 'naive-ui'
import {
  CheckboxOutline, CopyOutline, EllipsisHorizontalOutline, OpenOutline, QrCodeOutline, RefreshOutline, ShareSocialOutline, SearchOutline, KeyOutline,
  FolderOutline, DocumentOutline, TextOutline, TrashOutline, TerminalOutline, TimeOutline, PlayCircleOutline, LockClosedOutline,
  ChatbubbleEllipsesOutline, ChatbubblesOutline, PaperPlaneOutline, AddOutline, LocateOutline, RepeatOutline,
  CloudCircleOutline, CloudUploadOutline, HandLeftOutline, CreateOutline,
} from '@vicons/ionicons5'
import {
  shareApi, quickdropApi, buildDropUrl,
  type ShareInfo, type ShareKind, type ShareMessage, type ShareServiceStatus, type QuickdropTokenMeta, type ShareDropItem,
} from '../../api/domains/share'
import ShareReachBadge from '../../components/share/ShareReachBadge.vue'
import { useI18n } from '../../composables/useI18n'
import { useShareAddressPlan } from '../../composables/useShareAddressPlan'
import { bumpTerminalLiveShares } from '../../composables/useTerminalLiveShares'
import { bumpDirectInputShares } from '../../composables/useDirectInputShares'
import { confirmDialog, promptDialog } from '../../composables/useDialog'
import { confirmSensitiveFiles } from '../../composables/useShareDialog'
import { useShareNewShare } from '../../composables/useShareNewShare'
import ShareTtlModal from '../../components/share/ShareTtlModal.vue'
import {
  shareHealth, useShareManagerList,
} from '../../composables/useShareManagerList'
import { shareCanReshare, useShareReshare } from '../../composables/useShareReshare'
import { shareCanLocate, useShareLocate } from '../../composables/useShareLocate'
import { useNotificationStore } from '../../stores/notification'
import { useProjectStore } from '../../stores/project'
import { AppError } from '../../api/error-types'
import { formatBytes, usageExceeds } from '../../utils/bytes'
import { formatDateTime } from '../../utils/git'
import { relativeTimeParts } from '../../utils/relative-time'
import { copyText } from '../../utils/clipboard'
import { buildShareInviteText } from '../../utils/shareInvite'
import ShareQrPanel from '../../components/share/ShareQrPanel.vue'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
// 「新建分享」CTA（P-20261020-8）：有项目 → 打开文件树回根并聚焦；无项目 →
// toast 提示先开项目（判定与文案在组合式内闭环）
const { startNewShare } = useShareNewShare()
function onNewShare() { void startNewShare() }
const notificationStore = useNotificationStore()
// 行内复制/打开/二维码共用同一份地址计划（P-20261020-6）：回环入口下自动
// 改用局域网候选，避免二维码与复制两套口径
const sharePlan = useShareAddressPlan()

const loading = ref(false)
const shares = ref<ShareInfo[]>([])
const status = ref<ShareServiceStatus>({ running: false, port: 0, scheme: '' })
// 全局可达性徽标（P-20261020-2）：与行内复制/打开/二维码共用同一份地址
// 计划——由 useShareAddressPlan 统一拉取分享基址/外部地址/局域网候选
const basePlan = computed(() => sharePlan.plan.value)
// 快照库占用（P-20261005-176）：列表响应随附 frozenUsage{totalBytes,capBytes}
//——容量护栏从「撞 413 才知」变常透明；null = 统计不可用（服务端省略投影）
const frozenUsage = ref<{ totalBytes: number; capBytes: number } | null>(null)
const pageSize = 15

// ── 冻结快照占用（P-20261005-176）：头部信息行 + 行体积列 ──
// 从未冻结过（总量 0 且无快照行）不显头部行——「0.00MB / 1GB」是纯噪音
const hasSnapshotRow = computed(() => shares.value.some((s) => s.frozen || s.kind === 'terminal-frozen' || s.kind === 'cast' || s.kind === 'session'))
const showFrozenUsage = computed(() => frozenUsage.value != null
  && (frozenUsage.value.totalBytes > 0 || hasSnapshotRow.value))
const frozenUsageWarn = computed(() =>
  frozenUsage.value != null && usageExceeds(frozenUsage.value.totalBytes, frozenUsage.value.capBytes))
const frozenUsageText = computed(() => {
  if (!frozenUsage.value) return ''
  return t('share.frozenUsage.line', {
    used: formatBytes(frozenUsage.value.totalBytes, 2),
    cap: formatBytes(frozenUsage.value.capBytes),
  })
})

// 过期倒计时/相对时间基准：30s 粒度自 tick 驱动表格重渲染——分钟级倒计时
// 不需要秒针精度，30s 已足够顺滑且开销可忽略。now 同时供状态筛选（已过期）
// 与倒计时共用，避免两套时钟。
const now = ref(Date.now())
let countdownTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  countdownTimer = setInterval(() => { now.value = Date.now() }, 30_000)
})
onBeforeUnmount(() => { if (countdownTimer) clearInterval(countdownTimer) })

// 搜索/类别/状态筛选 + 预分页排序（P-20261020-10）：逻辑抽在 composable
// （useShareManagerList），排序在分页前作用于全集；排序真值单点在 composable
// 的 sortKey/sortOrder，列上的 sortOrder 读 sortOrderFor
const {
  search, kindFilter, statusFilter, page,
  isFiltering, visibleShares, paged, pageCount, abnormalCount,
  onSorter, sortOrderFor, onKindChecked, onStatusChecked, filterAbnormal,
} = useShareManagerList(shares, now, pageSize)

// ── 健康投影（P-20261020-10）：异常行徽标 + 行样式 + 行操作可用性 ──
const projectStore = useProjectStore()
const projectIds = computed(() => new Set(projectStore.projects.map((p) => p.id)))
const { locateTarget } = useShareLocate()

function healthLabel(s: ShareInfo): string {
  switch (shareHealth(s)) {
    case 'target_missing': return t('share.health.targetMissing')
    case 'project_gone': return t('share.health.projectGone')
    case 'snapshot_missing': return t('share.health.snapshotMissing')
    default: return ''
  }
}

function healthTip(s: ShareInfo): string {
  switch (shareHealth(s)) {
    case 'target_missing': return t('share.health.targetMissingTip')
    case 'project_gone': return t('share.health.projectGoneTip')
    case 'snapshot_missing': return t('share.health.snapshotMissingTip')
    default: return ''
  }
}

function canLocate(s: ShareInfo): boolean {
  return shareCanLocate(s, projectIds.value)
}

function canReshare(s: ShareInfo): boolean {
  return shareCanReshare(s, now.value, projectIds.value)
}

/**
 * 过期倒计时文案（凡带 expiresAt 的行）：已过显「已过期」；<1h 显分钟、
 * <24h 显小时、其余显天。snippet 与 file（opt-in TTL）各用一套键位——
 * 片段是 24h 固定窗口、文件是用户显式选择的有效期，文案语境不同
 */
function countdownText(s: ShareInfo): string {
  if (!s.expiresAt) return ''
  const remain = new Date(s.expiresAt).getTime() - now.value
  if (remain <= 0) return s.kind === 'snippet' ? t('share.snippet.expired') : t('share.ttl.expired')
  const minutes = Math.ceil(remain / 60_000)
  if (s.kind === 'snippet') {
    if (minutes < 60) return t('share.snippet.expiresInMinutes', { n: minutes })
    return t('share.snippet.expiresInHours', { n: Math.floor(minutes / 60) })
  }
  if (minutes < 60) return t('share.ttl.expiresInMinutes', { n: minutes })
  if (minutes < 60 * 24) return t('share.ttl.expiresInHours', { n: Math.floor(minutes / 60) })
  return t('share.ttl.expiresInDays', { n: Math.floor(minutes / (60 * 24)) })
}

// 相对时间（ISO → 刚刚/N 分钟前/…）：复用活动时间的三层分档（share 域
// 自持文案拷贝，agentTerminal 同款先例），随既有 30s tick 刷新（与倒计时
// 同一驱动，不加新定时器）。P-20261008-2 起退役访问徽标的 tooltip 同源
function relativeAgo(iso: string | undefined): string {
  if (!iso) return ''
  const p = relativeTimeParts(new Date(iso).getTime(), now.value)
  return t(`share.${p.key}`, { n: p.n })
}

// 最近访问相对时间（P-20261002-14）
function lastAccessText(s: ShareInfo): string {
  return relativeAgo(s.lastAccessAt)
}

function urlOf(s: ShareInfo): string {
  return sharePlan.urlOf(s.token)
}

async function fetchAll() {
  loading.value = true
  try {
    // 拦截器已解包 envelope：返回值即 {data, frozenUsage?}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [listRes, statusRes]: any[] = await Promise.all([
      shareApi.list(),
      shareApi.status(),
    ])
    shares.value = (listRes?.data || []) as ShareInfo[]
    frozenUsage.value = (listRes?.frozenUsage ?? null) as { totalBytes: number; capBytes: number } | null
    status.value = (statusRes?.data || { running: false, port: 0, scheme: '' }) as ShareServiceStatus
    if (page.value > pageCount.value) page.value = pageCount.value
    // 批量态勾选对账：列表已变（单条撤销/外部撤销）时摘掉失效 token，
    // 免得整批执行撞 404 出假 ✗ 明细
    if (bulkMode.value) {
      const alive = new Set((shares.value).map((s) => s.token))
      // 本表 row-key 恒为 token（string），RowKey 联合里的 number 分支不会出现
      checkedKeys.value = checkedKeys.value.filter((k) => alive.has(k as string))
    }
  } catch { /* 拦截器处理 */ } finally {
    loading.value = false
  }
}

// 「重新分享」行操作（P-20261020-10）：过期/已消费 file 分享撤销旧记录后按
// 原配置重建；成功后刷新列表对账
const { requestReshare } = useShareReshare(fetchAll)

onMounted(() => {
  void fetchAll()
  void fetchQuickdropToken()
  void sharePlan.load()
})

async function onCopy(s: ShareInfo) {
  const url = urlOf(s)
  if (!url) return
  // copyText 带 execCommand 降级（局域网 http 访问 navigator.clipboard 不可用）
  const ok = await copyText(url)
  if (ok) message.success(t('share.linkCopied'))
  else message.error(t('common.copyFailed'))
}

function onOpen(s: ShareInfo) {
  const url = urlOf(s)
  if (url) window.open(url, '_blank', 'noopener')
}

function onRevoke(s: ShareInfo) {
  dialog.warning({
    title: t('share.revokeTitle'),
    content: t('share.revokeConfirm', { name: s.name }),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await shareApi.remove(s.token)
        message.success(t('share.revoked', { name: s.name }))
        await fetchAll()
        // 终端直播撤销同步摘 tab 红点（P-20261005-161）：分享管理页与终端
        // 面板跨视图，动作后即时对账免等 30s 轮询
        bumpTerminalLiveShares()
      } catch { /* 拦截器处理 */ }
    },
  })
}

// ── 批量撤销（P-20261005-226）：试验性链接积累后逐条撤销 = N 次确认弹窗，
// 多选态一次确认整批清。执行走既有逐条撤销 API 前端循环 + 失败隔离逐项报告
//（fetchAll 失败隔离先例同款：部分失败不中断整批，通知中心留 ✓/✗ 逐条明细）；
// 批量轮换一期不做（撤销是卫生主场景）──
const bulkMode = ref(false)
// NDataTable checked-row-keys（row-key=token）：勾选真值单点，跨页/筛选切换保持续存
const checkedKeys = ref<Array<string | number>>([])
const bulkBusy = ref(false)

function enterBulkMode() {
  bulkMode.value = true
  checkedKeys.value = []
}

function exitBulkMode() {
  bulkMode.value = false
  checkedKeys.value = []
}

/** 确认文案所选清单：全列会撑爆弹窗——头 5 条名 + 「等 N 条」注记 */
const BULK_NAME_PREVIEW = 5
function bulkConfirmNames(picked: ShareInfo[]): string {
  const head = picked.slice(0, BULK_NAME_PREVIEW).map((s) => `「${s.name}」`).join('')
  return picked.length > BULK_NAME_PREVIEW
    ? head + t('share.bulk.moreNames', { n: picked.length - BULK_NAME_PREVIEW })
    : head
}

/** 逐项失败原因：拦截器已生成友好文案（userMessage）直接复用；无响应的
 *  网络层失败回落原始 message 兜底展示 */
function bulkErrText(e: unknown): string {
  if (e instanceof AppError && e.userMessage) return e.userMessage
  return e instanceof Error ? e.message : String(e)
}

function onBulkRevoke() {
  const picked = shares.value.filter((s) => checkedKeys.value.includes(s.token))
  if (picked.length === 0) return
  dialog.warning({
    title: t('share.bulk.revokeTitle'),
    content: t('share.bulk.revokeConfirm', { n: picked.length, names: bulkConfirmNames(picked) }),
    positiveText: t('share.bulk.revoke'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => runBulkRevoke(picked),
  })
}

async function runBulkRevoke(picked: ShareInfo[]) {
  bulkBusy.value = true
  const results: { name: string; ok: boolean; reason: string }[] = []
  try {
    // 串行循环：撤销是轻请求且批量是低频卫生操作，串行不 hammer 服务端，
    // 逐项结果天然有序；单项失败只记账不中断（失败隔离）
    for (const s of picked) {
      try {
        await shareApi.remove(s.token, { silent: true })
        results.push({ name: s.name, ok: true, reason: '' })
      } catch (e) {
        results.push({ name: s.name, ok: false, reason: bulkErrText(e) })
      }
    }
  } finally {
    bulkBusy.value = false
  }
  const ok = results.filter((r) => r.ok).length
  const fail = results.length - ok
  const allOk = fail === 0
  const toastKey = allOk ? 'share.bulk.done' : 'share.bulk.partial'
  const toastParams = allOk ? { n: ok } : { ok, fail }
  if (allOk) message.success(t(toastKey, toastParams))
  else message.warning(t(toastKey, toastParams))
  // 逐项明细入通知中心（fetchAll 同款 ✓/✗ 行）：toast 只报摘要，逐条可对账
  void notificationStore.add({
    type: allOk ? 'success' : 'warning',
    category: 'system',
    title: t(toastKey, toastParams),
    body: results.map((r) => (r.ok ? `✓ ${r.name}` : `✗ ${r.name}：${r.reason}`)).join('\n'),
  })
  await fetchAll()
  // 撤销可能涉及终端直播/快照链：tab 红点即时对账（与单条撤销同款）
  bumpTerminalLiveShares()
  checkedKeys.value = []
}

// onRotate 轮换短链（泄露应对一步化）：确认后调 rotate，成功即刷新列表并把
// 新链送剪贴板（一步到「新链可分发」，不用再手动复制）；复制失败仍提示轮换
// 成功——列表里随时可再复制，不打断主流程
function onRotate(s: ShareInfo) {
  dialog.warning({
    title: t('share.rotate.title'),
    content: t('share.rotate.confirm', { name: s.name }),
    positiveText: t('share.rotate.confirmAction'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        // 拦截器已解包 envelope：返回值即 {data: ...}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await shareApi.rotate(s.token)
        const next = res?.data as ShareInfo | undefined
        await fetchAll()
        // 直播轮换即换链（旧 token 断流）：终端 tab 徽标即时对账新 token（P-20261005-161）
        bumpTerminalLiveShares()
        const url = next ? sharePlan.urlOf(next.token) : ''
        if (url && await copyText(url)) {
          message.success(t('share.rotate.doneCopied', { name: next?.name ?? s.name }))
        } else {
          message.success(t('share.rotate.done', { name: next?.name ?? s.name }))
        }
      } catch { /* 拦截器处理 */ }
    },
  })
}

// onRefresh 原地刷新冻结快照（P-20261005-177，仅 frozen 行出现）：保 token
// 换内容——已分发出去的链接全部继续有效（与 rotate 换链语义正交并存）。
// 确认框交代两件事：副本重拷为项目当前内容 + 30 天保留期重置（③刷新即
// TTL 重置注记）；成功后刷新列表（倒计时/大小列即时对账）+ 轻 toast。敏感
// 扫描对新副本跑，命中未确认走 confirmSensitiveFiles 确认后带 override 重放
//（与创建同一契约，服务端拦下时旧副本原样、内容未变）
function onRefresh(s: ShareInfo) {
  dialog.warning({
    title: t('share.frozen.refreshTitle'),
    content: t('share.frozen.refreshConfirm', { name: s.name }),
    positiveText: t('share.frozen.refreshAction'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        // 拦截器已解包 envelope：返回值即 {data?, warnings?, scanTruncated?}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const first: any = await shareApi.refresh(s.token)
        const warns = (first?.warnings || []) as string[]
        if (warns.length) {
          if (!(await confirmSensitiveFiles(warns, first?.scanTruncated === true))) return
          await shareApi.refresh(s.token, true)
        }
        await fetchAll()
        message.success(t('share.frozen.refreshDone', { name: s.name }))
      } catch { /* 拦截器处理 */ }
    },
  })
}

// ── 行内 QR 快捷（P-20261003-282 / P-20261020-6）：访客短链转二维码，发
// 手机扫码即达——码内容走 useShareAddressPlan 的同一份 URL（回环入口下
// 自动改用局域网候选），面板内附三色可达性徽标与链接手动兜底
const showQr = ref(false)
const qrTarget = ref<ShareInfo | null>(null)

function onQr(s: ShareInfo) {
  qrTarget.value = s
  showQr.value = true
}

// ── 有效期调整（P-20261020-5）：行内入口，复用既有
// POST /api/share/{token}/expiry（错误映射同族）；snippet 固定 24h 窗口
// 服务端拒绝调整，故该形态不渲染入口。弹层自包含（ShareTtlModal），
// 保存成功回调刷新列表让倒计时即时对账
const showTtl = ref(false)
const ttlTarget = ref<ShareInfo | null>(null)

function onTtl(s: ShareInfo) {
  ttlTarget.value = s
  showTtl.value = true
}

// ── 访问口令门（P-20261006-25）：行内入口 + 设置/更换/移除弹层 ──
// 弹层为页面内 NModal（带输入框的表单交互，与 dialog.warning 的纯确认弹窗
// 分工）：输入新口令保存即设置/更换；已设口令的行可一键移除。「同时轮换」
// 默认勾选——改口令的动机多是口令可能外泄，旧链+旧访客会话一并作废才是
// 完整应对（不勾 = 短链保持不变，仅换门）。
// 保存成功后就地提供「复制邀请信息」（P-20261020-6）：链接（轮换后的新
// token）+ 刚输入的明文口令 + 有效期；明文只存活在弹层打开期间，关闭即清。
const showPass = ref(false)
const passTarget = ref<ShareInfo | null>(null)
const passValue = ref('')
const passRotate = ref(true)
const passInviteUrl = ref('')
const passInviteSecret = ref('')
const passInviteShare = ref<ShareInfo | null>(null)

function clearPassInvite() {
  passInviteUrl.value = ''
  passInviteSecret.value = ''
  passInviteShare.value = null
}
// 关闭弹层（取消/右上角/保存后关闭）即丢弃明文口令，之后无路径可回显
watch(showPass, (v) => { if (!v) clearPassInvite() })

function onPass(s: ShareInfo) {
  passTarget.value = s
  passValue.value = ''
  passRotate.value = true
  clearPassInvite()
  showPass.value = true
}

async function onPassSave() {
  const s = passTarget.value
  if (!s || !passValue.value) return
  try {
    // 拦截器已解包 envelope：响应 data 为最终记录（rotate 后带新 token）。
    // 没有记录就不做邀请（尤其轮换后旧 token 已失效，猜一个新链接等于发死链）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await shareApi.setPassphrase(s.token, passValue.value, passRotate.value)
    const next = res?.data as ShareInfo | undefined
    if (!next) {
      message.success(t('share.pass.saved'))
      passValue.value = ''
      await fetchAll()
      return
    }
    passTarget.value = next
    // 先快照明文再清输入框：邀请文案用「本次保存的口令」，与已发送链接一致
    passInviteSecret.value = passValue.value
    passInviteShare.value = next
    passInviteUrl.value = sharePlan.urlOf(next.token)
    passValue.value = ''
    message.success(t('share.pass.saved'))
    await fetchAll()
    // 「同时轮换」勾选会换单链（直播旧访客一并失效）：徽标即时对账（P-20261005-161）
    if (passRotate.value) bumpTerminalLiveShares()
  } catch { /* 拦截器处理 */ }
}

const passInviteText = computed(() => {
  const s = passInviteShare.value
  if (!s || !passInviteUrl.value || !passInviteSecret.value) return ''
  return buildShareInviteText({
    url: passInviteUrl.value,
    passphrase: passInviteSecret.value,
    expiresText: s.expiresAt ? formatDateTime(s.expiresAt) : undefined,
    viewOnce: s.viewOnce === true,
  }, {
    link: t('share.invite.link'),
    passphrase: t('share.invite.passphrase'),
    expires: t('share.invite.expires'),
    permanent: t('share.invite.permanent'),
    viewOnce: t('share.invite.once'),
  })
})

async function onCopyPassInvite() {
  if (!passInviteText.value) return
  const ok = await copyText(passInviteText.value)
  if (ok) message.success(t('share.invite.copied'))
  else message.error(t('common.copyFailed'))
}

function onPassRemove() {
  const s = passTarget.value
  if (!s) return
  dialog.warning({
    title: t('share.pass.removeTitle'),
    content: t('share.pass.removeConfirm', { name: s.name }),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await shareApi.setPassphrase(s.token, '', false)
        message.success(t('share.pass.removed'))
        clearPassInvite()
        showPass.value = false
        await fetchAll()
      } catch { /* 拦截器处理 */ }
    },
  })
}

// ── 访客留言面板（P-20261006-13）：行内「留言 N」入口 + 只读列表面板 ──
// 留言是访客单向回流（回复是 IM 的活，不做成聊天），主人侧能力 = 看 +
// 出清（单删/清空）。计数以列表打开时的服务端数据为准（角标是冗余投影）
const showMsg = ref(false)
const msgTarget = ref<ShareInfo | null>(null)
const msgList = ref<ShareMessage[]>([])
const msgLoading = ref(false)

async function onMsg(s: ShareInfo) {
  msgTarget.value = s
  showMsg.value = true
  msgLoading.value = true
  try {
    // 拦截器已解包 envelope：返回值即 {data: [...]}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await shareApi.listMessages(s.token)
    msgList.value = (res?.data || []) as ShareMessage[]
  } catch {
    msgList.value = []
  } finally {
    msgLoading.value = false
  }
}

/** 处置后同步本地角标（免整列表重拉——计数是冗余投影，本地可推导） */
function setMsgCount(token: string, n: number) {
  const row = shares.value.find((x) => x.token === token)
  if (row) row.messages = Math.max(0, n)
}

async function onDeleteMsg(m: ShareMessage) {
  const s = msgTarget.value
  if (!s) return
  try {
    await shareApi.deleteMessage(s.token, m.id)
    msgList.value = msgList.value.filter((x) => x.id !== m.id)
    setMsgCount(s.token, msgList.value.length)
    message.success(t('share.msg.deleted'))
  } catch { /* 拦截器处理 */ }
}

async function onClearMsgs() {
  const s = msgTarget.value
  if (!s) return
  dialog.warning({
    title: t('share.msg.clearTitle'),
    content: t('share.msg.clearConfirm', { name: s.name, n: msgList.value.length }),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await shareApi.clearMessages(s.token)
        msgList.value = []
        setMsgCount(s.token, 0)
        message.success(t('share.msg.cleared'))
      } catch { /* 拦截器处理 */ }
    },
  })
}

function msgNick(m: ShareMessage): string {
  return m.nickname || t('share.msg.anon')
}

// ── 协作通道（P-20261024-1）：开关动作 + 收件面板 + 直通握手 owner 半边 ──
// 分享无编辑面（全仓零 PUT/PATCH）——开关/批准/收回全部动作化行内端点。
// 开关是暴露面变更（开 = 访客面多两个上传/输入位），直通开启另带确认弹层
//（服务端 confirm 硬闸的前端对应摩擦）
const showDrops = ref(false)
const dropsTarget = ref<ShareInfo | null>(null)
const dropsList = ref<ShareDropItem[]>([])
const dropsLoading = ref(false)
const dropsBusy = ref('')

async function onDrops(s: ShareInfo) {
  dropsTarget.value = s
  showDrops.value = true
  await reloadDrops()
}

/** reloadDrops 收件清单重拉（打开面板 + 面板内「刷新」钮共用；素材到达是
 *  服务端广播事件，面板在场时手动刷新对账——不做常驻轮询，低频面克制） */
async function reloadDrops() {
  const s = dropsTarget.value
  if (!s) return
  dropsLoading.value = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await shareApi.listDrops(s.token)
    dropsList.value = (res?.data || []) as ShareDropItem[]
  } catch {
    dropsList.value = []
  } finally {
    dropsLoading.value = false
  }
}

/** 复制绝对路径（贴进会话的原料——主人也可手动粘贴给 agent） */
async function onCopyDropPath(m: ShareDropItem) {
  if (await copyText(m.absPath)) message.success(t('share.drop.pathCopied'))
  else message.error(t('common.copyFailed'))
}

/** 标已消费（已自行处理——已消费 24h 清，TTL 消费语义的手动出口） */
async function onConsumeDrop(m: ShareDropItem) {
  const s = dropsTarget.value
  if (!s) return
  dropsBusy.value = m.id
  try {
    await shareApi.consumeDrop(s.token, m.id)
    m.consumedAt = new Date().toISOString()
    message.success(t('share.drop.consumed'))
  } catch { /* 拦截器处理 */ } finally {
    dropsBusy.value = ''
  }
}

async function onDeleteDrop(m: ShareDropItem) {
  const s = dropsTarget.value
  if (!s) return
  dropsBusy.value = m.id
  try {
    await shareApi.deleteDrop(s.token, m.id)
    dropsList.value = dropsList.value.filter((x) => x.id !== m.id)
    message.success(t('share.drop.deleted'))
  } catch { /* 拦截器处理 */ } finally {
    dropsBusy.value = ''
  }
}

/** 协作通道开关（动作化行内端点）：开 = 暴露访客上传位 + 受限留言档；
 *  关 = 回收（存量素材保留可读）。开关即审计面，成功后刷新列表投影 */
async function onCollabToggle(s: ShareInfo) {
  try {
    const next = !s.collab
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await shareApi.setCollab(s.token, next)
    applyRow(res?.data)
    message.success(t(next ? 'share.collab.on' : 'share.collab.off'))
    void fetchAll()
  } catch { /* 拦截器处理 */ }
}

/** 直通输入档开关（第二档独立开关）：开启走确认弹层（管理面摩擦——
 *  访客将可申请向锚定 agent 会话直接输入）；关闭即回收（确认不需要——
 *  回收永远是安全方向）。dialog.warning 返回 DialogReactive 非 Promise，
 *  结果分流走 onPositive/onNegativeClick 回调（GitBranchesSection 同款） */
function onDirectInputToggle(s: ShareInfo) {
  if (!s.directInput) {
    dialog.warning({
      title: t('share.direct.enableTitle'),
      content: t('share.direct.enableConfirm', { name: s.name }),
      positiveText: t('share.direct.enable'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => { void applyDirectInput(s, true) },
    })
    return
  }
  void applyDirectInput(s, false)
}

/** applyDirectInput 直通开关落盘（on=true 携 confirm——服务端硬闸的前端对应
 *  摩擦；false 回收方向不需要）；成功后徽标与列表投影即时对账 */
async function applyDirectInput(s: ShareInfo, on: boolean) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await shareApi.setDirectInput(s.token, on, on)
    applyRow(res?.data)
    message.success(t(on ? 'share.direct.on' : 'share.direct.off'))
    bumpDirectInputShares()
    void fetchAll()
  } catch { /* 拦截器处理 */ }
}

// ── 可写分享开关（P-20261106-8「对方可直接输入」模式） ──
// 泄露半径从「看输出」抬到「打 shell」——开启走三步：警示确认（远程协助
// 语义 + 主人随时可收回）→ 口令门强制（未设口令先补设，token 链接会在
// 聊天中转发，一道口令是成比例补偿）→ 落盘携 confirm（服务端硬闸）。
// 关闭零摩擦（回收永远是安全方向：上行连接即刻断开、访客页回落只读）

/** onWritableToggle 可写开关行内入口（仅 kind=terminal 行挂菜单项） */
async function onWritableToggle(s: ShareInfo) {
  if (s.writable) {
    await applyWritable(s, false)
    return
  }
  const confirmed = await confirmDialog({
    title: t('share.writable.enableTitle'),
    content: t('share.writable.enableConfirm', { name: s.name }),
    type: 'warning',
  })
  if (!confirmed) return
  let passphrase = ''
  if (!s.hasPassphrase) {
    // 口令门强制（修订点5）：无门记录先补设——promptDialog password 档
    // 打码输入；取消 = 放弃开启（半途摩擦不是开启失败）
    const pass = await promptDialog({
      title: t('share.writable.passTitle'),
      label: t('share.writable.passLabel'),
      inputType: 'password',
      placeholder: t('share.writable.passPh'),
      hint: t('share.writable.passHint'),
      validate: (v) => (v.length > 0 ? null : t('share.writable.passRequired')),
      confirmText: t('share.writable.enable'),
    })
    if (pass == null) return
    passphrase = pass
  }
  await applyWritable(s, true, passphrase)
}

/** applyWritable 单条开关落盘：on=true 携 confirm+passphrase（服务端三闸
 *  对应面）；ttlHint=true 提示缩短 TTL（响应级约定，提示非强制） */
async function applyWritable(s: ShareInfo, on: boolean, passphrase = '') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await shareApi.setWritable(s.token, on, on, passphrase)
    applyRow(res?.data)
    message.success(t(on ? 'share.writable.on' : 'share.writable.off'))
    if (on && res?.ttlHint) message.warning(t('share.writable.ttlHint'), { duration: 5000 })
    bumpDirectInputShares()
    void fetchAll()
  } catch { /* 拦截器处理 */ }
}

/** 一键收回访客输入（可写分享的 wtyping 在场行）：动作与开关关闭同一下游
 *  （WritableDown——断上行连接 + 访客页回落只读），徽标随 bump 即时摘 */
async function onRevokeWritable(s: ShareInfo) {
  await applyWritable(s, false)
}

/** onBulkWritable 批量开/关可写（管理列表多选）：调专用批量端点（逐条独立
 *  结算——无口令条目 passphrase_required 跳过，开启方向不摊薄口令补偿），
 *  逐项明细入通知中心（runBulkRevoke 同款对账面） */
async function onBulkWritable(on: boolean) {
  const picked = shares.value.filter((s) => checkedKeys.value.includes(s.token))
  if (picked.length === 0) return
  const confirmed = await confirmDialog({
    title: t(on ? 'share.writable.bulkOnTitle' : 'share.writable.bulkOffTitle'),
    content: t(on ? 'share.writable.bulkOnConfirm' : 'share.writable.bulkOffConfirm',
      { n: picked.length, names: bulkConfirmNames(picked) }),
    type: on ? 'warning' : 'info',
  })
  if (!confirmed) return
  bulkBusy.value = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await shareApi.batchWritable(picked.map((s) => s.token), on, on)
    const rows = (res?.data || []) as Array<{ token: string; ok: boolean; reason?: string }>
    const ok = rows.filter((r) => r.ok).length
    const fail = rows.length - ok
    const nameOf = (r: { token: string }) => picked.find((s) => s.token === r.token)?.name || r.token
    // 摘要键用可写专用词条（share.bulk.done/partial 是批量撤销语义的文案，
    // 复用会让可写开关报「已撤销 N 条分享」——文案与动作错位）
    const doneKey = on ? 'share.writable.bulkDoneOn' : 'share.writable.bulkDoneOff'
    if (fail === 0) message.success(t(doneKey, { n: ok }))
    else message.warning(t('share.writable.bulkPartial', { ok, fail }))
    void notificationStore.add({
      type: fail === 0 ? 'success' : 'warning',
      category: 'system',
      title: t(fail === 0 ? doneKey : 'share.writable.bulkPartial', { n: ok, ok, fail }),
      body: rows.map((r) => (r.ok ? `✓ ${nameOf(r)}` : `✗ ${nameOf(r)}：${r.reason || 'failed'}`)).join('\n'),
    })
  } catch { /* 拦截器处理 */ } finally {
    bulkBusy.value = false
  }
  bumpDirectInputShares()
  await fetchAll()
}

/** 批准在途申请（直通握手 owner 半边）：agent 会话限定判定在服务端，
 *  无在途申请 409 如实提示 */
async function onApproveDirect(s: ShareInfo) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await shareApi.approveDirect(s.token)
    message.success(t('share.direct.granted', { nick: res?.data?.nick || '' }))
    bumpDirectInputShares()
    void fetchAll()
  } catch { /* 拦截器处理 */ }
}

/** 一键收回持权（管理器行内入口；通知中心持权卡/会话侧徽标/回收端点
 *  三路入口共用同一端点） */
async function onRevokeDirect(s: ShareInfo) {
  try {
    await shareApi.revokeDirect(s.token)
    message.success(t('share.direct.revoked'))
    bumpDirectInputShares()
    void fetchAll()
  } catch { /* 拦截器处理 */ }
}

/** applyRow 用动作响应的最终记录就地更新行（免整列表重拉；本组动作不动
 *  token，直接合并即可） */
function applyRow(next?: unknown) {
  const rec = next as ShareInfo | undefined
  if (!rec?.token) return
  const idx = shares.value.findIndex((x) => x.token === rec.token)
  if (idx >= 0) shares.value[idx] = { ...shares.value[idx]!, ...rec }
}

// ── 快投递 quickdrop 卡（P-20261006-51）：投递凭据 scd_ token 生命周期 ──
// 生成即轮换（明文仅在轮换响应里出现一次，回显拼好的投递页链接供复制），
// 撤销后链接即刻失效。与 share 管理列表同卡风格（bg-surface + 主题变量）
const qdToken = ref<QuickdropTokenMeta>({ exists: false, prefix: '', createdAt: '', rotatedAt: '' })
// 明文只在轮换响应出现一次：回显完整链接（含 scd_ 明文）供复制，关闭即不再可读
const qdPlainUrl = ref('')
const qdBusy = ref(false)

async function fetchQuickdropToken() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await quickdropApi.getToken()
    qdToken.value = (res?.data || { exists: false, prefix: '', createdAt: '', rotatedAt: '' }) as QuickdropTokenMeta
  } catch { /* 拦截器处理 */ }
}

async function onCreateQdToken() {
  qdBusy.value = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await quickdropApi.createToken()
    const plain = (res?.data?.token as string) || ''
    qdToken.value = (res?.data?.meta || qdToken.value) as QuickdropTokenMeta
    qdPlainUrl.value = plain ? buildDropUrl(plain) : ''
    message.success(t('share.quickdrop.created'))
  } catch { /* 拦截器处理 */ } finally {
    qdBusy.value = false
  }
}

async function onRevokeQdToken() {
  dialog.warning({
    title: t('share.quickdrop.revokeTitle'),
    content: t('share.quickdrop.revokeConfirm'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await quickdropApi.revokeToken()
        qdToken.value = { exists: false, prefix: '', createdAt: '', rotatedAt: '' }
        qdPlainUrl.value = ''
        message.success(t('share.quickdrop.revoked'))
      } catch { /* 拦截器处理 */ }
    },
  })
}

async function onCopyQd(text: string) {
  if (await copyText(text)) {
    message.success(t('share.quickdrop.copied'))
  } else {
    message.error(t('common.copyFailed'))
  }
}


function nameCell(row: ShareInfo) {
  // 未知 kind 回落文件/目录通用图标（升级兼容：旧前端遇新 kind 不崩，只少专属徽标）
  const icon = row.kind === 'snippet' ? TextOutline
    : row.kind === 'terminal' ? TerminalOutline
      : row.kind === 'terminal-frozen' ? TimeOutline
        : row.kind === 'cast' ? PlayCircleOutline
          : row.kind === 'session' ? ChatbubblesOutline
            : row.isDir ? FolderOutline : DocumentOutline
  const color = row.kind === 'snippet' ? 'var(--accent-purple)'
    : row.kind === 'terminal' ? 'var(--accent-green, var(--accent-blue))'
      : row.kind === 'terminal-frozen' ? 'var(--accent-orange)'
        : row.kind === 'cast' ? 'var(--accent-blue)'
          : row.kind === 'session' ? 'var(--accent-purple)'
            : row.isDir ? 'var(--accent-blue-light)' : 'var(--text-secondary)'
  const nodes = [
    h(NIcon, { size: 16, color }, { default: () => h(icon) }),
    h('span', { class: 'nm', title: row.terminalId || row.recordingId || row.sessionId || row.path || row.name }, row.name),
  ]
  // 口令门标记（P-20261006-25）：🔒 提示「这条链不是裸链接，访客还需口令」
  // ——分发前核对是否已带门与撤销/轮换决策同属关键语境
  if (row.hasPassphrase) {
    nodes.push(h(NIcon, {
      size: 13, color: 'var(--accent-orange)',
      title: t('share.pass.badgeTip'),
      'data-testid': 'sm-pass-lock',
    }, { default: () => h(LockClosedOutline) }))
  }
  return h('div', { class: 'sc-share-name' }, nodes)
}

// 列宽集中声明（P-20261020-9）：scroll-x 与列定义同源，改列宽不必再手工
// 对账滚动宽度。旧版固定列合计 834px 且不设 scroll-x，名称/项目/路径三列在
// 1024~1366 主区被压成几个字；这里给文本列明确宽度，放不下就横向滚动而不是
// 压扁——操作列 fixed:right 保证横向滚动时「更多」始终在手边。
const SHARE_COL_WIDTH = {
  name: 170,
  project: 110,
  path: 190,
  kind: 100,
  frozenBytes: 88,
  created: 156,
  hits: 84,
  lastAccess: 104,
  // 复制/打开/二维码 3 个 tiny 图标 + 「更多」（留言计数角标可能两位数）留足
  actions: 150,
} as const
// 勾选列仅批量模式渲染，naive-ui 内建宽度约 48px——滚动宽度随之增量
const BULK_SELECTION_WIDTH = 48
const tableScrollX = computed(() => Object.values(SHARE_COL_WIDTH).reduce((sum, w) => sum + w, 0)
  + (bulkMode.value ? BULK_SELECTION_WIDTH : 0))
// 表头排序交互占位比较器：真实排序已由 useShareManagerList 在分页前完成
// （paged 即全局有序切片）。NDataTable 仍会对 data 做一次内部排序——返回 0
// 保持传入顺序，否则 descend 会把「—」缺省行翻到页首，破坏全局「缺省恒末位」
const preSorted = () => 0

const columns = computed<DataTableColumns<ShareInfo>>(() => [
  // 勾选列只在批量模式渲染（RemoteFilePane 同款内建 selection 列）：表头全选
  // 只作用于表内行，筛选行挡住不可见行——「筛选后全选=选可见集」天然成立。
  // fixed:left 让窄屏横向滚动时勾选列仍可见，批量操作不被滚走
  ...(bulkMode.value ? [{ type: 'selection' as const, fixed: 'left' as const }] : []),
  { title: t('share.colName'), key: 'name', width: SHARE_COL_WIDTH.name, render: nameCell },
  { title: t('share.colProject'), key: 'projectName', width: SHARE_COL_WIDTH.project, render: (r) => h('span', { class: 'sc-share-dim' }, r.projectName) },
  { title: t('share.colPath'), key: 'path', width: SHARE_COL_WIDTH.path, render: (r) => h('span', { class: 'sc-share-path', title: r.paths?.length ? r.paths.join('\n') : (r.terminalId || r.recordingId || r.sessionId || r.path) }, r.paths?.length ? t('share.batch.pathSummary', { n: r.paths.length }) : (r.path || (r.kind === 'snippet' ? t('share.snippet.pathEmpty') : r.kind === 'terminal' ? (r.terminalId || t('share.terminal.pathEmpty')) : r.kind === 'terminal-frozen' ? (r.terminalId || t('share.termFrozen.pathEmpty')) : r.kind === 'cast' ? (r.terminalId || r.recordingId || t('share.cast.pathEmpty')) : r.kind === 'session' ? (r.sessionId || t('share.session.pathEmpty')) : t('share.rootPath')))) },
  {
    title: t('share.colType'), key: 'kind', width: SHARE_COL_WIDTH.kind,
    render: (r) => {
      const badge = r.kind === 'snippet'
        ? h(NTag, { size: 'small', bordered: false, type: 'warning' }, { default: () => t('share.snippet.typeBadge') })
        : r.kind === 'terminal'
          ? h(NTag, { size: 'small', bordered: false, type: 'success' }, { default: () => t('share.terminal.typeBadge') })
          : r.kind === 'terminal-frozen'
            ? h(NTag, { size: 'small', bordered: false, type: 'primary', 'data-testid': 'sm-termfrozen-badge' },
                { default: () => t('share.termFrozen.typeBadge') })
            : r.kind === 'cast'
              ? h(NTag, { size: 'small', bordered: false, type: 'info', 'data-testid': 'sm-cast-badge' },
                  { default: () => t('share.cast.typeBadge') })
              : r.kind === 'session'
                ? h(NTag, { size: 'small', bordered: false, type: 'info', 'data-testid': 'sm-session-badge' },
                    { default: () => t('share.session.typeBadge') })
                : h(NTag, { size: 'small', bordered: false, type: r.isDir ? 'info' : 'default' },
                    { default: () => (r.isDir ? t('share.typeDir') : t('share.typeFile')) })
      // 冻结快照徽标（P-20261003-320）：与形态徽标并列——「这条链是定格副本，
      // 不随项目漂移」是撤销/轮换决策的关键语境。
      const extra = []
      if (r.frozen) {
        extra.push(h(NTag, { size: 'small', bordered: false, type: 'primary', 'data-testid': 'sm-frozen-badge' },
          { default: () => t('share.frozen.typeBadge') }))
      }
      // 批量徽标（P-20261008-1）：path 列只给项数略写，类型列显式标注集合形态
      if (r.paths?.length) {
        extra.push(h(NTag, { size: 'small', bordered: false, type: 'info', 'data-testid': 'sm-batch-badge' },
          { default: () => t('share.batch.typeBadge', { n: r.paths!.length }) }))
      }
      // 健康徽标（P-20261020-10）：异常行（目标/项目/快照缺失）显红标——
      // 此前坏链在列表里与正常行无差别，撤销/重分享决策缺信号。ok 行不挂
      // 绿标（正常是默认态，满屏绿标只增噪音）；异常计数在工具栏另有入口
      if (shareHealth(r) !== 'ok') {
        extra.push(h(NTag, {
          size: 'small', bordered: false, type: 'error',
          title: healthTip(r),
          'data-testid': 'sm-health-badge',
          'data-health': shareHealth(r),
        }, { default: () => healthLabel(r) }))
      }
      // 一次性徽标 + 失效态（P-20261006-27）：「看一眼即焚」是撤销/再分发
      // 决策的关键语境；consumed = 已被查看且宽限窗走完（服务端投影，前端
      // 不复制宽限窗判定），挂「已失效」标与倒计时「已过期」文案区分
      if (r.viewOnce) {
        extra.push(h(NTag, { size: 'small', bordered: false, type: 'warning', title: t('share.viewOnce.badgeTip'), 'data-testid': 'sm-viewonce-badge' },
          { default: () => t('share.viewOnce.typeBadge') }))
      }
      // 未过滤徽标（P-20261106-9）：创建时显式关闭了敏感值遮蔽——每个管理面
      // 一眼可辨的出域级标记（error 色与退役访问/消费失效同档显著）；遮蔽开
      //（缺省）不挂，存量行零噪音
      if (r.unfiltered) {
        extra.push(h(NTag, { size: 'small', bordered: false, type: 'error', title: t('share.unfiltered.badgeTip'), 'data-testid': 'sm-unfiltered-badge' },
          { default: () => t('share.unfiltered.typeBadge') }))
      }
      if (r.consumed) {
        extra.push(h(NTag, { size: 'small', bordered: false, type: 'error', title: t('share.viewOnce.consumedTip'), 'data-testid': 'sm-consumed-badge' },
          { default: () => t('share.viewOnce.consumedBadge') }))
      }
      // 退役访问徽标（P-20261008-2）：轮换作废的旧链接退役后仍被踩——零误报
      // 的外泄确认信号，warning 色对齐通知告警形态；有命中才挂（无退役史/
      // 旧记录行零噪音），tooltip 携最近命中相对时间（复用 30s tick 刷新）
      if (r.retiredHits) {
        extra.push(h(NTag, {
          size: 'small', bordered: false, type: 'warning',
          title: t('share.retired.badgeTip', { n: r.retiredHits, time: relativeAgo(r.lastRetiredAt) || '—' }),
          'data-testid': 'sm-retired-badge',
        }, { default: () => t('share.retired.badge', { n: r.retiredHits }) }))
      }
      if (extra.length === 0) return badge
      return h('div', { class: 'sc-share-type-col' }, [badge, ...extra])
    },
  },
  // 有效期列（P-20261020-10 从类型列拆出）：倒计时是独立检索维度，拆列后
  // 可排序；无有效期行显「—」（缺省值排序恒末位）
  {
    title: t('share.colExpires'), key: 'expiresAt', width: 132,
    sortOrder: sortOrderFor('expiresAt'),
    sorter: preSorted,
    render: (r) => r.expiresAt
      ? h('span', { class: 'sc-share-countdown', 'data-testid': 'sm-countdown' }, countdownText(r))
      : h('span', { class: 'sc-share-never' }, '—'),
  },
  // 快照体积列（P-20261005-176）：有快照在盘的行显该份目录字节量（冻结文件
  // 分享/终端输出快照），可排序找大头；无快照行弱化「—」
  {
    title: t('share.colFrozenBytes'), key: 'frozenBytes', width: SHARE_COL_WIDTH.frozenBytes,
    sortOrder: sortOrderFor('frozenBytes'),
    sorter: preSorted,
    render: (r) => r.frozenBytes == null
      ? h('span', { class: 'sc-share-never' }, '—')
      : h('span', {
          class: 'sc-share-frozen-bytes',
          'data-testid': 'sm-frozen-bytes',
        }, formatBytes(r.frozenBytes)),
  },
  {
    title: t('share.colCreated'), key: 'createdAt', width: SHARE_COL_WIDTH.created,
    sortOrder: sortOrderFor('createdAt'),
    sorter: preSorted,
    render: (r) => h('span', { class: 'sc-share-dim' }, formatDateTime(r.createdAt)),
  },
  // 访问指标两列（P-20261002-14）：0 次/从未访问显「未访问」弱化样式——
  // 暴露量为 0 与有过暴露是召回决策的分界，弱化但可见
  {
    title: t('share.colHits'), key: 'hits', width: SHARE_COL_WIDTH.hits,
    sortOrder: sortOrderFor('hits'),
    sorter: preSorted,
    render: (r) => h('span', {
      class: r.hits ? 'sc-share-hits' : 'sc-share-never',
      'data-testid': 'sm-hits',
      title: r.hits ? t('share.hitsTip', { n: r.hits }) : t('share.neverAccessed'),
    }, r.hits ? String(r.hits) : t('share.neverAccessed')),
  },
  {
    title: t('share.colLastAccess'), key: 'lastAccessAt', width: SHARE_COL_WIDTH.lastAccess,
    sortOrder: sortOrderFor('lastAccessAt'),
    sorter: preSorted,
    render: (r) => h('span', {
      class: r.lastAccessAt ? 'sc-share-dim' : 'sc-share-never',
      title: r.lastAccessAt ? formatDateTime(r.lastAccessAt) : t('share.neverAccessed'),
    }, r.lastAccessAt ? lastAccessText(r) : '—'),
  },
  {
    // 行操作收口（P-20261020-9）：复制/打开/二维码是分发高频动作保留为图标；
    // 口令/留言/刷新/轮换/撤销进「更多」下拉（带文字标签，触屏与低发现性场景
    // 可读）。全部既有动作保留，撤销仍走原确认弹窗（语义不变）
    title: t('share.colActions'), key: 'actions', width: SHARE_COL_WIDTH.actions, fixed: 'right',
    render: (r) => h('div', { class: 'sc-share-actions' }, [
      actionBtn(t('share.copyLink'), CopyOutline, !urlOf(r), () => onCopy(r)),
      actionBtn(t('share.open'), OpenOutline, !urlOf(r), () => onOpen(r)),
      actionBtn(t('share.qr.action'), QrCodeOutline, !urlOf(r), () => onQr(r)),
      moreBtn(r),
    ]),
  },
])

// 异常行整行弱警示（P-20261020-10）：坏链与正常行扫读可辨，撤销是主处置；
// data-health 供 e2e/agent 快照断言（正常行也带，便于全量对账）
function rowProps(row: ShareInfo) {
  const health = shareHealth(row)
  return {
    class: health === 'ok' ? '' : 'sm-row-abnormal',
    'data-health': health,
  }
}

/** 留言菜单项文案：有留言带计数（「有人看了还在问」的回流信号） */
function msgMenuLabel(r: ShareInfo): string {
  const n = r.messages ?? 0
  return n > 0 ? t('share.msg.actionN', { n }) : t('share.msg.action')
}

/** 「更多」菜单项：低频管理与危险动作收口；frozen 行才给原地刷新
 * （live 活视图随项目漂移无需刷新，snippet/terminal 无项目源，服务端同口径） */
function moreOptionsFor(r: ShareInfo): Array<DropdownOption | DropdownDividerOption> {
  const icon = (i: typeof CopyOutline) => () => h(NIcon, null, { default: () => h(i) })
  const options: Array<DropdownOption | DropdownDividerOption> = [
    { label: t('share.pass.action'), key: 'pass', icon: icon(LockClosedOutline) },
    { label: msgMenuLabel(r), key: 'msg', icon: icon(ChatbubbleEllipsesOutline) },
  ]
  // 有效期（P-20261020-5）：仅 file 形态提供；snippet/terminal/cast/session
  // 各自固定窗口，产品口径不提供选择
  if (r.kind === 'file') {
    options.push({ label: t('share.ttl.action'), key: 'ttl', icon: icon(TimeOutline) })
  }
  if (canLocate(r)) {
    options.push({ label: t('share.locate.action'), key: 'locate', icon: icon(LocateOutline) })
  }
  if (canReshare(r)) {
    options.push({ label: t('share.reshare.action'), key: 'reshare', icon: icon(RepeatOutline) })
  }
  if (r.frozen) {
    options.push({ label: t('share.frozen.refreshAction'), key: 'refresh', icon: icon(RefreshOutline) })
  }
  // 协作通道（P-20261024-1）：开关全形态可开（素材上行不依赖分享形态）；
  // 直通输入档仅 terminal 直播行（锚定会话语义）；收件箱入口在 collab 开启
  // 后出现；持权在场挂「收回」危险项，待批申请挂「批准」项
  options.push({
    label: r.collab ? t('share.collab.menuOn') : t('share.collab.menuOff'),
    key: 'collab',
    icon: icon(CloudCircleOutline),
    props: r.collab ? { style: 'color: var(--accent)' } : undefined,
  })
  if (r.kind === 'terminal') {
    options.push({
      label: r.directInput ? t('share.direct.menuOn') : t('share.direct.menuOff'),
      key: 'directInput',
      icon: icon(CloudUploadOutline),
      props: r.directInput ? { style: 'color: var(--accent)' } : undefined,
    })
    // 可写分享（P-20261106-8）：仅 terminal 直播行（组合语义——frozen/cast/
    // session 天然只读）；wtyping 在场行挂「收回访客输入」危险项（与直通
    // 持权卡同族的一键收回面）
    options.push({
      label: r.writable ? t('share.writable.menuOn') : t('share.writable.menuOff'),
      key: 'writable',
      icon: icon(CreateOutline),
      props: r.writable ? { style: 'color: var(--accent)' } : undefined,
    })
  }
  if (r.collab) {
    options.push({ label: t('share.drop.menu'), key: 'drops', icon: icon(FolderOutline) })
  }
  if (r.direct?.pending) {
    options.push({
      label: t('share.direct.approveAction', { nick: r.direct.nick || '' }),
      key: 'approveDirect',
      icon: icon(HandLeftOutline),
    })
  }
  if (r.direct?.held) {
    options.push({
      label: t('share.direct.revokeAction', { nick: r.direct.nick || '' }),
      key: 'revokeDirect',
      icon: icon(HandLeftOutline),
      props: { style: 'color: var(--accent-red)' },
    })
  }
  if (r.wtyping && (r.wtyping.visitors ?? 0) > 0) {
    options.push({
      label: t('share.writable.revokeAction', { n: r.wtyping.visitors }),
      key: 'revokeWritable',
      icon: icon(HandLeftOutline),
      props: { style: 'color: var(--accent-red)' },
    })
  }
  options.push(
    // 轮换会立即让旧链接失效（不可逆）：KeyOutline 与同菜单的刷新/重新分享两枚环形箭头
    // 拉开形状差异（P-20261022-1；禁用变体清单含 SyncOutline）
    { label: t('share.rotate.action'), key: 'rotate', icon: icon(KeyOutline) },
    { type: 'divider', key: 'actions-divider' },
    {
      label: t('share.revoke'), key: 'revoke', icon: icon(TrashOutline),
      props: { style: 'color: var(--accent-red)' },
    },
  )
  return options
}

function onMoreSelect(r: ShareInfo, key: string | number) {
  switch (key) {
    case 'pass': onPass(r); break
    case 'msg': void onMsg(r); break
    case 'ttl': onTtl(r); break
    case 'locate': locateTarget(r); break
    case 'reshare': void requestReshare(r, projectIds.value); break
    case 'refresh': onRefresh(r); break
    case 'rotate': onRotate(r); break
    case 'revoke': onRevoke(r); break
    case 'collab': void onCollabToggle(r); break
    case 'directInput': void onDirectInputToggle(r); break
    case 'writable': void onWritableToggle(r); break
    case 'drops': void onDrops(r); break
    case 'approveDirect': void onApproveDirect(r); break
    case 'revokeDirect': void onRevokeDirect(r); break
    case 'revokeWritable': void onRevokeWritable(r); break
  }
}

/**
 * 「更多」触发钮：图标 + 双提示（title 悬停 / aria-label 读屏——按钮无文本）。
 * 有访客留言时角标计数挂在钮上：低频动作收进菜单后，留言回流信号仍需一眼可见
 */
function moreBtn(r: ShareInfo) {
  const n = r.messages ?? 0
  return h(NDropdown, {
    trigger: 'click',
    placement: 'bottom-end',
    options: moreOptionsFor(r),
    onSelect: (key: string | number) => onMoreSelect(r, key),
  }, {
    default: () => h(NButton, {
      size: 'tiny', quaternary: true,
      title: t('share.moreActions'),
      'aria-label': t('share.moreActions'),
      'data-testid': 'sm-more-btn',
    }, {
      icon: () => h(NIcon, null, { default: () => h(EllipsisHorizontalOutline) }),
      default: () => (n > 0 ? h('span', { class: 'sc-msg-count', 'data-testid': 'sm-msg-count' }, String(n)) : null),
    }),
  })
}

function actionBtn(tooltip: string, icon: typeof CopyOutline, disabled: boolean, onClick: () => void, type?: 'error', testid?: string) {
  return h(NTooltip, null, {
    trigger: () => h(NButton, {
      size: 'tiny', quaternary: true, disabled, type,
      'aria-label': tooltip,
      ...(testid ? { 'data-testid': testid } : {}),
      onClick,
    }, { icon: () => h(NIcon, null, { default: () => h(icon) }) }),
    default: () => tooltip,
  })
}
</script>

<template>
  <div class="share-manager">
    <!-- 工具栏：与主应用面板体系同风格（无独立渐变皮肤） -->
    <div class="sm-toolbar">
      <NIcon
        size="18"
        class="sm-toolbar-icon"
      >
        <ShareSocialOutline />
      </NIcon>
      <div class="sm-toolbar-text">
        <h2>{{ t('share.managerTitle') }}</h2>
        <p>{{ t('share.managerDesc') }}</p>
      </div>
      <div class="sm-toolbar-actions">
        <!-- 冻结快照占用行（P-20261005-176）：>80% 转橙色预警档（撞 413 的
             提前量），tooltip 给出处置动作（撤销旧冻结链） -->
        <NTag
          v-if="showFrozenUsage"
          :type="frozenUsageWarn ? 'warning' : 'default'"
          size="small"
          round
          :bordered="false"
          :title="frozenUsageWarn ? t('share.frozenUsage.warnTip') : undefined"
          data-testid="sm-frozen-usage"
        >
          {{ frozenUsageText }}
        </NTag>
        <!-- 异常分享快捷入口（P-20261020-10）：坏链数量常驻可见，点击直接
             过滤到异常集合——管理器打开即知「有 N 条链接已坏」 -->
        <NTag
          v-if="abnormalCount > 0"
          type="error"
          size="small"
          round
          :bordered="false"
          class="sm-health-warn"
          data-testid="sm-health-warn"
          role="button"
          tabindex="0"
          @click="filterAbnormal"
          @keydown.enter="filterAbnormal"
        >
          {{ t('share.health.count', { n: abnormalCount }) }}
        </NTag>
        <NTag
          :type="status.running ? 'success' : 'warning'"
          size="small"
          round
          :bordered="false"
        >
          {{ status.running ? t('share.statusRunning') : t('share.statusDown') }}
        </NTag>
        <!-- 分享链接可达性徽标（P-20261020-2）：复制/打开/二维码同一地址
             计划的全局投影；红/黄/绿与二维码接力同语义，title 承载处置指引 -->
        <div
          v-if="status.running"
          class="sm-reach"
          data-testid="sm-share-reach"
        >
          <ShareReachBadge
            :state="basePlan.state"
            :source="basePlan.source"
          />
        </div>
        <!-- 新建分享（P-20261020-8）：管理器从只读列表变成可发起——打开文件树
             回项目根并聚焦，由用户自己选目标（不造路径输入） -->
        <NButton
          size="small"
          type="primary"
          secondary
          data-testid="sm-new-share"
          @click="onNewShare"
        >
          <template #icon>
            <NIcon><AddOutline /></NIcon>
          </template>
          {{ t('share.newShare.action') }}
        </NButton>
        <!-- 批量管理入口（P-20261005-226）：多选态开关；无分享时禁用 -->
        <NButton
          v-if="!bulkMode"
          size="small"
          quaternary
          :disabled="shares.length === 0"
          data-testid="sm-bulk-enter"
          @click="enterBulkMode"
        >
          <template #icon>
            <NIcon><CheckboxOutline /></NIcon>
          </template>
          {{ t('share.bulk.enter') }}
        </NButton>
        <NButton
          size="small"
          quaternary
          data-testid="sm-toolbar-refresh-btn"
          @click="fetchAll"
        >
          <template #icon>
            <NIcon><RefreshOutline /></NIcon>
          </template>
          {{ t('common.refresh') }}
        </NButton>
      </div>
    </div>

    <!-- 服务未就绪提示（可行动文案，不直出后端错误） -->
    <div
      v-if="!loading && !status.running"
      class="sm-warn"
    >
      {{ t('share.serviceDownHint') }}
    </div>

    <!-- 快投递卡（P-20261006-51）：手机 → 工作台 agent 的最轻通道。
         凭据生成/轮换/撤销 + 投递页链接复制（链接 = 本工作台地址 /drop/<token>，
         手机浏览器书签存它即可投递；明文只在轮换响应出现一次） -->
    <div
      class="sm-card sm-qd-card"
      data-testid="qd-card"
    >
      <div class="sm-qd-head">
        <NIcon
          size="16"
          color="var(--accent-blue)"
        >
          <PaperPlaneOutline />
        </NIcon>
        <span class="sm-qd-title">{{ t('share.quickdrop.title') }}</span>
        <span class="sm-qd-desc">{{ t('share.quickdrop.desc') }}</span>
        <span style="flex: 1" />
        <template v-if="qdToken.exists">
          <NButton
            v-if="qdPlainUrl"
            size="small"
            data-testid="qd-copy-plain"
            @click="onCopyQd(qdPlainUrl)"
          >
            <template #icon>
              <NIcon><CopyOutline /></NIcon>
            </template>
            {{ t('share.quickdrop.copyUrl') }}
          </NButton>
          <NButton
            size="small"
            :loading="qdBusy"
            data-testid="qd-rotate"
            @click="onCreateQdToken"
          >
            {{ t('share.quickdrop.rotate') }}
          </NButton>
          <NButton
            size="small"
            quaternary
            type="error"
            data-testid="qd-revoke"
            @click="onRevokeQdToken"
          >
            {{ t('share.quickdrop.revoke') }}
          </NButton>
        </template>
        <NButton
          v-else
          size="small"
          type="primary"
          secondary
          :loading="qdBusy"
          data-testid="qd-generate"
          @click="onCreateQdToken"
        >
          {{ t('share.quickdrop.generate') }}
        </NButton>
      </div>
      <div class="sm-qd-body">
        <code
          v-if="qdPlainUrl"
          class="sm-qd-url"
          data-testid="qd-plain-url"
        >{{ qdPlainUrl }}</code>
        <code
          v-else-if="qdToken.exists"
          class="sm-qd-url sm-qd-masked"
        >…/drop/&lt;scd_{{ qdToken.prefix }}***&gt;</code>
        <span
          v-else
          class="sm-qd-hint"
        >{{ t('share.quickdrop.noneHint') }}</span>
      </div>
    </div>

    <!-- 列表 + 分页 -->
    <div class="sm-card">
      <!-- 批量操作条（P-20261005-226）：独立于列表空态分支——整批撤完列表转空
           时「退出批量」仍可达，批量态不悬死 -->
      <div
        v-if="bulkMode"
        class="sm-bulk-bar"
        data-testid="sm-bulk-bar"
      >
        <span
          class="sm-bulk-count"
          data-testid="sm-bulk-count"
        >{{ t('share.bulk.selected', { n: checkedKeys.length }) }}</span>
        <span style="flex: 1" />
        <NButton
          size="small"
          quaternary
          data-testid="sm-bulk-exit"
          @click="exitBulkMode"
        >
          {{ t('share.bulk.exit') }}
        </NButton>
        <NButton
          size="small"
          type="warning"
          secondary
          :disabled="checkedKeys.length === 0"
          :loading="bulkBusy"
          data-testid="sm-bulk-writable-on"
          @click="onBulkWritable(true)"
        >
          <template #icon>
            <NIcon><CreateOutline /></NIcon>
          </template>
          {{ t('share.writable.bulkOn') }}
        </NButton>
        <NButton
          size="small"
          secondary
          :disabled="checkedKeys.length === 0"
          :loading="bulkBusy"
          data-testid="sm-bulk-writable-off"
          @click="onBulkWritable(false)"
        >
          <template #icon>
            <NIcon><CreateOutline /></NIcon>
          </template>
          {{ t('share.writable.bulkOff') }}
        </NButton>
        <NButton
          size="small"
          type="error"
          secondary
          :disabled="checkedKeys.length === 0"
          :loading="bulkBusy"
          data-testid="sm-bulk-revoke"
          @click="onBulkRevoke"
        >
          <template #icon>
            <NIcon><TrashOutline /></NIcon>
          </template>
          {{ t('share.bulk.revoke') }}
        </NButton>
      </div>
      <NSpin
        v-if="loading && shares.length === 0"
        size="small"
        class="sm-loading"
      />
      <NEmpty
        v-else-if="shares.length === 0"
        :description="t('share.empty')"
        class="sm-empty"
      >
        <!-- 空态下一步动作（P-20261020-8）：没有分享时也给出可行动入口 -->
        <template #extra>
          <NButton
            size="small"
            type="primary"
            secondary
            data-testid="sm-new-share-empty"
            @click="onNewShare"
          >
            <template #icon>
              <NIcon><AddOutline /></NIcon>
            </template>
            {{ t('share.newShare.action') }}
          </NButton>
        </template>
      </NEmpty>
      <template v-else>
        <!-- 列表头过滤行：搜索 + 类别徽标点选（file|snippet）+ 过滤态计数 -->
        <div class="sm-filter-row">
          <NInput
            v-model:value="search"
            size="small"
            clearable
            :placeholder="t('share.filter.placeholder')"
            class="sm-filter-input"
            data-testid="sm-filter-search"
          >
            <template #prefix>
              <NIcon :size="13">
                <SearchOutline />
              </NIcon>
            </template>
          </NInput>
          <div
            class="sm-filter-kinds"
            data-testid="sm-filter-kinds"
          >
            <NTag
              size="small"
              round
              checkable
              :checked="kindFilter === ''"
              @update:checked="onKindChecked('', $event)"
            >
              {{ t('share.filter.all') }}
            </NTag>
            <NTag
              size="small"
              round
              checkable
              :checked="kindFilter === 'file'"
              @update:checked="onKindChecked('file', $event)"
            >
              {{ t('share.filter.file') }}
            </NTag>
            <NTag
              size="small"
              round
              checkable
              :checked="kindFilter === 'snippet'"
              @update:checked="onKindChecked('snippet', $event)"
            >
              {{ t('share.filter.snippet') }}
            </NTag>
            <NTag
              size="small"
              round
              checkable
              :checked="kindFilter === 'terminal'"
              @update:checked="onKindChecked('terminal', $event)"
            >
              {{ t('share.filter.terminal') }}
            </NTag>
            <NTag
              size="small"
              round
              checkable
              :checked="kindFilter === 'terminal-frozen'"
              @update:checked="onKindChecked('terminal-frozen', $event)"
            >
              {{ t('share.filter.termFrozen') }}
            </NTag>
            <NTag
              size="small"
              round
              checkable
              :checked="kindFilter === 'cast'"
              @update:checked="onKindChecked('cast', $event)"
            >
              {{ t('share.filter.cast') }}
            </NTag>
            <NTag
              size="small"
              round
              checkable
              :checked="kindFilter === 'session'"
              @update:checked="onKindChecked('session', $event)"
            >
              {{ t('share.filter.session') }}
            </NTag>
          </div>
          <!-- 状态筛选（P-20261020-10）：活跃/已过期/已消费/异常，与类别筛选
               并列叠加（AND）；过期与异常可重叠（坏链在两种视角下都该可见） -->
          <div
            class="sm-filter-status"
            data-testid="sm-filter-status"
          >
            <span class="sm-filter-label">{{ t('share.filter.statusLabel') }}</span>
            <NTag
              size="small"
              round
              checkable
              :checked="statusFilter === 'active'"
              data-testid="sm-status-active"
              @update:checked="onStatusChecked('active', $event)"
            >
              {{ t('share.filter.statusActive') }}
            </NTag>
            <NTag
              size="small"
              round
              checkable
              :checked="statusFilter === 'expired'"
              data-testid="sm-status-expired"
              @update:checked="onStatusChecked('expired', $event)"
            >
              {{ t('share.filter.statusExpired') }}
            </NTag>
            <NTag
              size="small"
              round
              checkable
              :checked="statusFilter === 'consumed'"
              data-testid="sm-status-consumed"
              @update:checked="onStatusChecked('consumed', $event)"
            >
              {{ t('share.filter.statusConsumed') }}
            </NTag>
            <NTag
              size="small"
              round
              checkable
              :checked="statusFilter === 'abnormal'"
              data-testid="sm-status-abnormal"
              @update:checked="onStatusChecked('abnormal', $event)"
            >
              {{ t('share.filter.statusAbnormal') }}
            </NTag>
          </div>
          <span
            v-if="isFiltering"
            class="sm-filter-count"
            data-testid="sm-filter-count"
          >{{ visibleShares.length }}/{{ shares.length }}</span>
        </div>
        <!-- 过滤无命中（过滤行仍渲染，清空或切类别即恢复） -->
        <div
          v-if="visibleShares.length === 0"
          class="sm-no-match"
        >
          {{ t('share.filter.noMatch') }}
        </div>
        <div
          v-else
          class="sm-table"
        >
          <NDataTable
            v-model:checked-row-keys="checkedKeys"
            :columns="columns"
            :data="paged"
            :row-key="(r: ShareInfo) => r.token"
            :scroll-x="tableScrollX"
            :row-props="rowProps"
            size="small"
            :bordered="false"
            :bottom-bordered="false"
            :single-line="false"
            @update:sorter="onSorter"
          />
        </div>
        <div
          v-if="pageCount > 1"
          class="sm-pager"
        >
          <NPagination
            v-model:page="page"
            :page-count="pageCount"
            :page-size="pageSize"
            size="small"
          />
          <span class="sm-total">{{ isFiltering
            ? t('share.filter.count', { n: visibleShares.length, total: shares.length })
            : t('share.totalCount', { n: shares.length }) }}</span>
        </div>
      </template>
    </div>

    <!-- 有效期调整弹层（P-20261020-5）：与创建弹层/结果卡共用档位控件；
         保存走既有 expiry 端点，成功后 fetchAll 刷新行内倒计时 -->
    <ShareTtlModal
      v-model:show="showTtl"
      :share="ttlTarget"
      @saved="fetchAll"
    />

    <!-- 访问口令弹层（P-20261006-25）：设置/更换（输入非空保存）+ 移除（已设
         口令的行）+ 联动轮换勾选（默认开——改口令多因口令可能外泄） -->
    <NModal
      v-model:show="showPass"
      preset="card"
      class="sm-pass-modal"
      :title="t('share.pass.title')"
      :mask-closable="false"
      data-testid="sm-pass-modal"
    >
      <div
        v-if="passTarget"
        class="sm-pass-body"
      >
        <p class="sm-pass-desc">
          {{ passTarget.hasPassphrase ? t('share.pass.hasDesc', { name: passTarget.name }) : t('share.pass.noDesc', { name: passTarget.name }) }}
        </p>
        <NInput
          v-model:value="passValue"
          type="password"
          show-password-on="click"
          clearable
          :placeholder="t('share.pass.inputPlaceholder')"
          :maxlength="64"
          class="sm-pass-input"
          data-testid="sm-pass-input"
          @keyup.enter="onPassSave"
        >
          <template #prefix>
            <NIcon :size="14">
              <LockClosedOutline />
            </NIcon>
          </template>
        </NInput>
        <NCheckbox
          v-model:checked="passRotate"
          class="sm-pass-rotate"
          data-testid="sm-pass-rotate"
        >
          {{ t('share.pass.rotateLabel') }}
        </NCheckbox>
        <p class="sm-pass-note">
          {{ t('share.pass.rotateNote') }}
        </p>
        <!-- 保存成功后的就地邀请（P-20261020-6）：链接 + 刚输入的明文口令
             一次复制；不展示口令本身，关闭弹层即清 -->
        <div
          v-if="passInviteUrl"
          class="sm-pass-invite"
          data-testid="sm-pass-invite"
        >
          <p class="sm-pass-invite-title">
            {{ t('share.pass.inviteReady') }}
          </p>
          <NInput
            :value="passInviteUrl"
            readonly
            size="small"
            data-testid="sm-pass-invite-url"
            @focus="(e: FocusEvent) => (e.target as HTMLInputElement)?.select()"
          />
          <p class="sm-pass-invite-note">
            {{ t('share.invite.secretNote') }}
          </p>
          <NButton
            size="small"
            type="primary"
            data-testid="sm-pass-invite-copy"
            @click="onCopyPassInvite"
          >
            <template #icon>
              <NIcon><CopyOutline /></NIcon>
            </template>
            {{ t('share.invite.copy') }}
          </NButton>
        </div>
      </div>
      <template #footer>
        <div class="sm-pass-foot">
          <NButton
            v-if="passTarget?.hasPassphrase"
            size="small"
            quaternary
            type="error"
            data-testid="sm-pass-remove"
            @click="onPassRemove"
          >
            {{ t('share.pass.remove') }}
          </NButton>
          <span class="sp" />
          <NButton
            size="small"
            quaternary
            @click="showPass = false"
          >
            <!-- 保存成功后已无「取消」语义（口令已落库），按钮改叫关闭 -->
            {{ passInviteUrl ? t('common.close') : t('common.cancel') }}
          </NButton>
          <NButton
            size="small"
            type="primary"
            :disabled="!passValue"
            data-testid="sm-pass-save"
            @click="onPassSave"
          >
            {{ t('share.pass.save') }}
          </NButton>
        </div>
      </template>
    </NModal>

    <!-- 分享二维码弹层（P-20261003-282 / P-20261020-6）：码内容与行内
         复制/打开共用地址计划；面板自带三色可达性徽标、局域网候选切换与
         链接手动兜底 -->
    <NModal
      v-model:show="showQr"
      preset="card"
      class="sm-qr-modal"
      :title="t('share.qr.title')"
      data-testid="sm-qr-modal"
    >
      <div
        v-if="qrTarget"
        class="sm-qr-body"
      >
        <p class="sm-qr-desc">
          {{ t('share.qr.desc', { name: qrTarget.name }) }}
        </p>
        <ShareQrPanel
          :token="qrTarget.token"
          :active="showQr"
          :size="220"
          testid-prefix="sm-qr"
        />
      </div>
    </NModal>

    <!-- 访客留言面板（P-20261006-13）：只读回流列表 + 单删/清空出清通道。
         回复不做（IM 的活），面板顶部一句边界说明防「为什么不能回复」困惑 -->
    <NModal
      v-model:show="showMsg"
      preset="card"
      class="sm-msg-modal"
      :title="msgTarget ? t('share.msg.title', { name: msgTarget.name }) : t('share.msg.action')"
      data-testid="sm-msg-modal"
    >
      <div class="sm-msg-body">
        <p class="sm-msg-tip">
          {{ t('share.msg.readonlyTip') }}
        </p>
        <NSpin
          v-if="msgLoading"
          size="small"
          class="sm-msg-loading"
        />
        <NEmpty
          v-else-if="msgList.length === 0"
          :description="t('share.msg.empty')"
          class="sm-msg-empty"
          data-testid="sm-msg-empty"
        />
        <div
          v-else
          class="sm-msg-list"
          data-testid="sm-msg-list"
        >
          <div
            v-for="m in msgList"
            :key="m.id"
            class="sm-msg-item"
            data-testid="sm-msg-item"
          >
            <div class="sm-msg-meta">
              <span class="sm-msg-nick">{{ msgNick(m) }}</span>
              <span class="sm-msg-time">{{ formatDateTime(m.createdAt) }}</span>
              <NButton
                size="tiny"
                quaternary
                type="error"
                class="sm-msg-del"
                :aria-label="t('share.msg.delete')"
                data-testid="sm-msg-del"
                @click="onDeleteMsg(m)"
              >
                <template #icon>
                  <NIcon :size="14">
                    <TrashOutline />
                  </NIcon>
                </template>
              </NButton>
            </div>
            <div class="sm-msg-text">
              {{ m.text }}
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="sm-msg-foot">
          <NButton
            v-if="msgList.length > 0"
            size="small"
            quaternary
            type="error"
            data-testid="sm-msg-clear"
            @click="onClearMsgs"
          >
            {{ t('share.msg.clear') }}
          </NButton>
          <span class="sp" />
          <NButton
            size="small"
            quaternary
            @click="showMsg = false"
          >
            {{ t('common.close') }}
          </NButton>
        </div>
      </template>
    </NModal>

    <!-- 协作收件面板（P-20261024-1）：已收素材清单 + 复制路径/标已消费/单删。
         绝对路径是主人侧唯一出口（访客响应零路径泄露），「交给当前会话/新会话
         处理」主链路在通知中心行内动作——面板承担对账与手动取用 -->
    <NModal
      v-model:show="showDrops"
      preset="card"
      class="sm-msg-modal"
      :title="dropsTarget ? t('share.drop.title', { name: dropsTarget.name }) : t('share.drop.menu')"
      data-testid="sm-drop-modal"
    >
      <div class="sm-msg-body">
        <p class="sm-msg-tip">
          {{ t('share.drop.tip') }}
        </p>
        <NSpin
          v-if="dropsLoading"
          size="small"
          class="sm-msg-loading"
        />
        <NEmpty
          v-else-if="dropsList.length === 0"
          :description="t('share.drop.empty')"
          class="sm-msg-empty"
          data-testid="sm-drop-empty"
        />
        <div
          v-else
          class="sm-msg-list"
          data-testid="sm-drop-list"
        >
          <div
            v-for="m in dropsList"
            :key="m.id"
            class="sm-msg-item"
            :class="{ 'sm-drop-sensitive': m.sensitive }"
            data-testid="sm-drop-item"
          >
            <div class="sm-msg-meta">
              <span
                class="sm-drop-kind"
                :data-kind="m.kind"
              >{{ m.kind === 'image' ? t('share.drop.kindImage') : t('share.drop.kindFile') }}</span>
              <span class="sm-msg-nick">{{ m.name }}</span>
              <span class="sm-msg-time">{{ formatBytes(m.size) }} · {{ m.nick || t('share.msg.anon') }} · {{ formatDateTime(m.at) }}</span>
              <NTag
                v-if="m.sensitive"
                size="tiny"
                type="warning"
                class="sm-drop-tag"
              >
                {{ t('share.drop.sensitive') }}
              </NTag>
              <NTag
                v-else-if="m.consumedAt"
                size="tiny"
                type="success"
                class="sm-drop-tag"
              >
                {{ t('share.drop.used') }}
              </NTag>
            </div>
            <div
              class="sm-drop-path"
              :title="m.absPath"
            >
              {{ m.absPath }}
            </div>
            <div class="sm-drop-acts">
              <NButton
                size="tiny"
                quaternary
                data-testid="sm-drop-copy"
                @click="onCopyDropPath(m)"
              >
                {{ t('share.drop.copyPath') }}
              </NButton>
              <NButton
                v-if="!m.consumedAt"
                size="tiny"
                quaternary
                :loading="dropsBusy === m.id"
                data-testid="sm-drop-consume"
                @click="onConsumeDrop(m)"
              >
                {{ t('share.drop.markUsed') }}
              </NButton>
              <NButton
                size="tiny"
                quaternary
                type="error"
                :loading="dropsBusy === m.id"
                data-testid="sm-drop-del"
                @click="onDeleteDrop(m)"
              >
                {{ t('share.msg.delete') }}
              </NButton>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="sm-msg-foot">
          <NButton
            size="small"
            quaternary
            data-testid="sm-drop-refresh"
            @click="reloadDrops"
          >
            {{ t('common.refresh') }}
          </NButton>
          <span class="sp" />
          <NButton
            size="small"
            quaternary
            @click="showDrops = false"
          >
            {{ t('common.close') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.share-manager {
  height: 100%;
  overflow: auto;
  padding: 18px 22px;
  background: var(--bg-canvas);
  display: flex;
  flex-direction: column;
}
.sm-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 18px;
  border-radius: 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
}
.sm-toolbar-icon { color: var(--accent-blue); }
/* 窄屏（P-20261020-9）：标题区给一个可换行下限，动作组整体落到下一行，
   不再把描述文本压成竖排 */
.sm-toolbar-text { flex: 1 1 220px; min-width: 0; }
.sm-toolbar-text h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text-primary); }
.sm-toolbar-text p { margin: 2px 0 0; font-size: 12px; color: var(--text-secondary); }
.sm-toolbar-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.sm-reach { flex-shrink: 0; }

.sm-warn {
  margin-top: 12px;
  padding: 9px 14px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--accent-orange);
  background: var(--bg-warning);
  border: 1px solid var(--border-default);
}
.sm-card {
  flex: 1;
  min-height: 0;
  /* 横向溢出交给表内 scroll-x，卡片本身不被内容撑宽（窄屏页面零横向滚动） */
  min-width: 0;
  margin-top: 12px;
  border-radius: 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  padding: 4px 10px 8px;
  display: flex;
  flex-direction: column;
}
.sm-loading { display: block; margin: 48px auto; }
.sm-empty { padding: 48px 0; }

/* 列表头过滤行：搜索 + 类别徽标 + 过滤态计数。7 个类别徽标在窄屏必须换行，
   否则把搜索框挤到 min-width 且整行横向溢 */
.sm-filter-row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 6px 6px;
}
.sm-filter-input { flex: 0 1 280px; min-width: 160px; }
.sm-filter-kinds { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.sm-filter-status { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sm-filter-label { color: var(--text-muted); font-size: 11.5px; }
.sm-filter-count { color: var(--text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.sm-health-warn { cursor: pointer; }
.sm-no-match { padding: 36px 0; text-align: center; color: var(--text-secondary); font-size: 12.5px; }

/* 异常行（P-20261020-10）：低饱和警示底 + 左侧强调条，撤销是主处置 */
.sm-card :deep(.sm-row-abnormal td) { background: var(--bg-warning); }
.sm-card :deep(.sm-row-abnormal td:first-child) { box-shadow: inset 2px 0 0 var(--accent-orange); }

/* 批量操作条（P-20261005-226）：多选态操作行——计数 + 退出/撤销 */
.sm-bulk-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 6px;
  border-bottom: 1px solid var(--border-subtle);
}
.sm-bulk-count { color: var(--text-secondary); font-size: 12.5px; font-variant-numeric: tabular-nums; }

/* 数据表内部样式（NDataTable 渲染树在子组件内，需 :deep） */
.sm-table { min-width: 0; }
.sm-card :deep(.sc-share-name) { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sm-card :deep(.sc-share-name .nm) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.sm-card :deep(.sc-share-dim) { color: var(--text-secondary); font-size: 12.5px; }
.sm-card :deep(.sc-share-path) {
  color: var(--text-secondary);
  font-size: 12.5px;
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
  max-width: 260px;
}
.sm-card :deep(.sc-share-actions) { display: flex; align-items: center; gap: 2px; }
/* 类型徽标/冻结/一次性/倒计时纵向堆叠（既有形态）；max-width 收紧防多徽标
   行在 100px 列内横向撑破到下一列 */
.sm-card :deep(.sc-share-type-col) { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; max-width: 100%; min-width: 0; }
.sm-card :deep(.sc-share-type-col .n-tag) { max-width: 100%; }
.sm-card :deep(.sc-share-countdown) { max-width: 100%; font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
/* 访问指标两列：有暴露显计数（tabular-nums 对齐），未访问弱化 */
.sm-card :deep(.sc-share-hits) { font-variant-numeric: tabular-nums; color: var(--text-primary); }
.sm-card :deep(.sc-share-never) { color: var(--text-muted); font-size: 12px; }
/* 快照体积列（P-20261005-176）：tabular-nums 对齐便于扫量级找大头 */
.sm-card :deep(.sc-share-frozen-bytes) { font-variant-numeric: tabular-nums; color: var(--text-secondary); font-size: 12.5px; white-space: nowrap; }

.sm-pager {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 14px;
  padding-top: 8px;
  border-top: 1px solid var(--border-default);
}
.sm-total { color: var(--text-secondary); font-size: 12px; }

/* 访问口令弹层（P-20261006-25） */
.sm-pass-body { min-width: 340px; }
.sm-pass-desc { margin: 0 0 12px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; }
.sm-pass-input { margin-bottom: 12px; }
.sm-pass-rotate { display: flex; }
.sm-pass-note { margin: 6px 0 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.6; }
.sm-pass-foot { display: flex; align-items: center; gap: 8px; }
.sm-pass-foot .sp { flex: 1; }
/* 保存成功后的就地邀请（P-20261020-6）：弱化容器 + 可读链接 + 明文销毁提示 */
.sm-pass-invite {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-hover);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sm-pass-invite-title { margin: 0; font-size: 12.5px; font-weight: 500; color: var(--text-primary); }
.sm-pass-invite-note { margin: 0; font-size: 11.5px; color: var(--accent-orange); line-height: 1.6; }

/* 分享二维码弹层（P-20261003-282） */
.sm-qr-body { display: flex; flex-direction: column; align-items: center; }
.sm-qr-desc { margin: 0 0 12px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; }

/* 访客留言面板（P-20261006-13） */
.sm-card :deep(.sc-msg-count) { font-size: 11px; font-variant-numeric: tabular-nums; line-height: 1; }
.sm-msg-body { min-width: 420px; max-width: 560px; }
.sm-msg-tip { margin: 0 0 10px; font-size: 11.5px; color: var(--text-muted); line-height: 1.6; }
.sm-msg-loading { display: block; margin: 32px auto; }
.sm-msg-empty { padding: 28px 0; }
.sm-msg-list {
  max-height: 46vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sm-msg-item {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--bg-canvas);
}
.sm-msg-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.sm-msg-nick { font-size: 12px; font-weight: 600; color: var(--accent-blue); }
.sm-msg-time { font-size: 11px; color: var(--text-muted); }
.sm-msg-del { margin-left: auto; }
.sm-msg-text { font-size: 12.5px; color: var(--text-primary); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.sm-msg-foot { display: flex; align-items: center; gap: 8px; }
/* 协作收件面板（P-20261024-1） */
.sm-drop-kind {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 0 4px;
}
.sm-drop-path {
  font-size: 11px;
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin: 2px 0 4px;
}
.sm-drop-acts { display: flex; gap: 6px; }
.sm-drop-sensitive { border-color: var(--accent-orange); }
.sm-drop-tag { margin-left: 4px; }
.sm-msg-foot .sp { flex: 1; }

/* 快投递卡（P-20261006-51）：与管理列表卡同族风格，紧凑单卡不参与列表滚动 */
.sm-qd-card {
  flex: none;
  display: block;
  padding: 10px 12px;
}
.sm-qd-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sm-qd-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.sm-qd-desc { font-size: 12px; color: var(--text-secondary); }
.sm-qd-body { margin-top: 8px; display: flex; align-items: center; }
.sm-qd-url {
  font-size: 12px; font-family: var(--font-mono);
  color: var(--text-primary); background: var(--bg-canvas);
  border: 1px solid var(--border-subtle); border-radius: 6px; padding: 4px 8px;
  max-width: 100%; overflow-wrap: anywhere;
}
.sm-qd-masked { color: var(--text-muted); }
.sm-qd-hint { font-size: 12px; color: var(--text-muted); }
</style>
