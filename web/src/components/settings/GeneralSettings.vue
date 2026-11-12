<script setup lang="ts">
// 通用设置分区（P-20261003-265 自 SettingsModal 拆出，纯搬运）：自动拉取/AI 智能体选型/
// 运行时状态/自定义智能体/任务模板/项目规则/审批守护与超时/工作区备份。
// 父子契约与 Appearance/Terminal/Git 等分区一致——:show 触发自加载，
// defineExpose({ load, save, isDirty }) 供弹窗「保存」链与关闭护栏调用；
// open-file：项目规则「编辑」发起文件深链后请宿主收起弹窗（编辑器在弹窗之下）
import { ref, computed, watch, onMounted } from 'vue'
import { NButton, NCheckbox, NInput, NInputNumber, NSelect, NSpin, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { settingsApi } from '../../api/client'
import {
  parseSessionContext,
  serializeSessionContext,
  SESSION_CONTEXT_ALL,
  type SessionContextOption,
} from '../../utils/sessionContextSummary'
import { useContextWarnStore, CONTEXT_WARN_MIN, CONTEXT_WARN_MAX } from '../../stores/contextWarn'
import { LOW_REMAINING_PCT } from '../../utils/sessionRelay'
import { normalizeExternalAccessUrl } from '../../utils/networkAddress'
import { OPS_ATOM_IDS, useOpsAtomPrefs, type FrontendAtomId } from '../../stores/opsAtomPrefs'
import { confirmDialog } from '../../composables/useDialog'
import CustomAgentsManager from './CustomAgentsManager.vue'
import AgentTaskTemplateManager from './AgentTaskTemplateManager.vue'
import ProjectRulesManager from './ProjectRulesManager.vue'
import WorkspaceBackup from './WorkspaceBackup.vue'
import SettingsTransferSection from './SettingsTransferSection.vue'
import SettingModifiedMark from './SettingModifiedMark.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'open-file'): void }>()

const { t } = useI18n()
const message = useMessage()

// 上下文警示阈值（P-20261006-33）：设备本地偏好直写行——滑条即写 contextWarn
// store（localStorage）即时生效，不入本分区「保存」链与 isDirty（同 font store 行
// 惯例）；恢复默认 = 写回出厂档（store 内清 key 回归缺省跟随语义）
const contextWarn = useContextWarnStore()

// 通用分区各行出厂默认（镜像服务端 GET /settings 的空值回落，server/api/system/settings.go
// GetSettings 与本组件 load 的 `||` 兜底同口径）：行级「已修改」标记
// （P-20261003-171）的对比基准。恢复 = 复位本地 pending 值，仍走「保存」链整体落盘，
// isDirty 关闭护栏语义不变
const GENERAL_DEFAULTS = {
  autoFetch: false,
  fetchInterval: '300',
  externalAccessUrl: '',
  sharePublicBaseUrl: '',
  agentProvider: 'auto',
  agentGuard: true,
  agentApprovalMode: 'ask',
  approvalRecording: false,
  approvalTimeoutMin: 0,
  uiSnapshotEnabled: true,
  opsAtomDownload: true,
  opsAtomClipboard: true,
  opsAtomOpen: true,
  opsAtomReload: true,
  sessionContext: 'git',
  shareDefaultTTL: 'permanent',
  agentNamingNoteEnabled: true,
  agentAutoNameEnabled: true,
  previewCompatMode: false,
} as const

const autoFetchEnabled = ref(false)
const fetchIntervalStr = ref('300')
// 外部访问地址（P-20261019-10）：Tailscale/反代接入时手机可达的 origin；
// 空=不启用（二维码按当前地址/局域网 IP 自动选址）。保存前本地校验+归一，
// 服务端同规则兜底（config.NormalizeExternalAccessURL）
const externalAccessUrl = ref('')
// 分享链接外发基址（P-20261020-2）：分享 URL = 该 origin + /s/<token>；
// 空=自动选址（外部访问地址 > 当前非回环地址 > 局域网候选 > sharePort 回退）。
// 与外部访问地址同一套 origin 校验（normalizeExternalAccessUrl），保存前本地
// 校验 + 服务端同规则兜底
const sharePublicBaseUrl = ref('')
// AI 底层智能体选型：auto + 服务端已注册的 Provider 名动态成项（新增 Provider 自动出现）
const agentProvider = ref('auto')
const agentGuard = ref(true)
// 高危操作审批档位（P-20261003-316 四档）：ask=每次询问（默认）/
// allow-session=会话级放行 / allow-24h=放行 24 小时（到期自动恢复）/
// allow=永久放行（历史「完全允许」，不再弹审批卡片）
const agentApprovalMode = ref<'ask' | 'allow-session' | 'allow-24h' | 'allow'>('ask')
// allow-24h 当前到期时刻（GET 镜像，剩余时限提示渲染源；空串=无）
const agentApprovalExpiresAt = ref('')
// 审批窗口过程实况录制（P-20261001-15，默认关——隐私边界）
const approvalRecording = ref(false)
// 审批等待超时自动拒绝（P-20261003-45）：分钟数，0=不超时（存量行为）。
// null=输入框被清空，按 0 语义保存（读写两侧统一归一）
const approvalTimeoutMin = ref<number | null>(0)
// 用户 UI 现场上报（P-20261004-52，默认开）：关=停止上报+agent 读取端点查无
const uiSnapshotEnabled = ref(true)
// frontend 原子管制（P-20261023-4，默认开）：agent 经操作通道触发的浏览器即时
// 效应按原子可关。本地编辑副本语义同分区其余行（确认保存时才经 opsAtomPrefs.set
// 落地 + userPrefs 漫游），恢复钮复位 pending 值仍走「保存」链
const opsAtomStore = useOpsAtomPrefs()
const opsAtomLocal = ref<Record<FrontendAtomId, boolean>>({ download: true, clipboard: true, open: true, reload: true })
function resetOpsAtomLocal() {
  for (const id of OPS_ATOM_IDS) opsAtomLocal.value[id] = opsAtomStore.enabled(id)
}
// 新建文件分享默认有效期（P-20261020-5）：永久（缺省，存量行为零变化）/
// 1d/7d/30d。创建请求未显式选择有效期时服务端应用；仅影响 live 文件分享
const shareDefaultTTL = ref<string>('permanent')
const shareDefaultTtlOptions = computed(() => [
  { label: t('share.ttl.permanent'), value: 'permanent' },
  { label: t('share.ttl.oneDay'), value: '1d' },
  { label: t('share.ttl.sevenDays'), value: '7d' },
  { label: t('share.ttl.thirtyDays'), value: '30d' },
])
// 会话启动上下文（P-20261006-47）：新建 agent 会话自动附带的「工作台背景资料」
// 多选（git 状态摘要= P-176 既有默认 / 项目笔记首段 / TODO 概要 / 环境画像），
// 全不勾 = none 显式全关。pending 值行（走「保存」链整体落盘），恢复钮只复位本地勾选
const sessionContextOptions = SESSION_CONTEXT_ALL
const sessionContextSelected = ref<SessionContextOption[]>(parseSessionContext(''))
// 会话命名系统注记注入（P-20261023-3，默认开）：带 prompt 创建会话时尾部附
// 命名指令注记——任务演化改名注入层的用户开关（服务端创建漏斗消费）
const agentNamingNoteEnabled = ref(true)
// 会话自动命名（P-20261111-6 S2，默认开）：claude 会话首条用户消息落盘后服务
// 端按其总结会话名（agent_autoname.go 观察器）——本提案目的即行为变化，存量
// 升级后开始自动命名（whatsnew 随版本段落告知）；关闭回落纯手动改名
const agentAutoNameEnabled = ref(true)
// 预览面板同源兼容模式（P-20261019-1，默认关 = 沙箱隔离）：开启是安全姿态
// 降级（预览内容获得本应用权限），勾选时红色警示显式确认后才进 pending 值，
// 仍走本分区「保存」链落盘；PreviewPanel 经 settings.changed 广播跟随重建
const previewCompatMode = ref(false)
/** 勾选拦截：开启必经确认（取消/关闭弹层即回弹不勾），关闭无风险直落 */
async function onPreviewCompatToggle(checked: boolean) {
  if (!checked) {
    previewCompatMode.value = false
    return
  }
  const ok = await confirmDialog({
    title: t('settings.previewCompatConfirmTitle'),
    content: t('settings.previewCompatConfirmBody'),
    type: 'error',
    confirmText: t('settings.previewCompatConfirmYes'),
  })
  previewCompatMode.value = ok
}
/** 勾选项标签（i18n 键运行时拼装走键表映射，不裸拼模板串） */
const SESSION_CONTEXT_LABEL_KEYS: Record<SessionContextOption, string> = {
  git: 'settings.sessionContextOptGit',
  notes: 'settings.sessionContextOptNotes',
  todos: 'settings.sessionContextOptTodos',
  env: 'settings.sessionContextOptEnv',
}
function toggleSessionContext(option: SessionContextOption, checked: boolean) {
  const set = new Set(sessionContextSelected.value)
  if (checked) set.add(option)
  else set.delete(option)
  sessionContextSelected.value = [...set]
}
const agentApprovalModeOptions = computed(() => [
  { label: t('settings.agentApprovalModeAsk'), value: 'ask' },
  { label: t('settings.agentApprovalModeSession'), value: 'allow-session' },
  { label: t('settings.agentApprovalMode24h'), value: 'allow-24h' },
  { label: t('settings.agentApprovalModeAllow'), value: 'allow' },
])
/** allow-24h 剩余时限提示（当前在档且有到期时刻时显示；未在档/无时限显重算提示） */
const approval24hHint = computed(() => {
  if (agentApprovalMode.value !== 'allow-24h') return ''
  const ms = agentApprovalExpiresAt.value ? new Date(agentApprovalExpiresAt.value).getTime() - Date.now() : 0
  if (ms > 0) {
    const totalMin = Math.ceil(ms / 60_000)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    const left = h > 0 ? t('approval.badge.remainingHM', { h, m }) : t('approval.badge.remainingM', { m })
    return t('settings.agentApprovalMode24hRemaining', { remaining: left })
  }
  return t('settings.agentApprovalMode24hHint')
})
// ============== 运行时状态区（B5）：可用性/版本/安装命令 ==============
interface RuntimeStatus { name: string; displayName?: string; available: boolean; version: string; defaultCommand: string; customCommand: string }
const agentRuntimes = ref<RuntimeStatus[]>([])
// 加载失败标记：拉取失败/为空时显示空态+重试，而非整区静默消失（用户无从得知/安装运行时）
const agentRuntimesFailed = ref(false)
// 探测在途标记：列表为空但在途时显示检测中，而非把「加载中」误渲染成「加载失败」
const runtimesLoading = ref(false)
const copiedRuntime = ref('')
async function loadAgentRuntimes(refresh = false) {
  runtimesLoading.value = true
  try {
    const res: any = await (await import('../../api/domains/terminal')).terminalApi.listAgentRuntimes(
      // refresh=1：手动「运行时检测」——服务端先失效 userbin 解析与版本探测
      // 两层缓存再重探，刚安装/卸载/修复的运行时即刻如实呈现（P-20261003-79）
      refresh ? { params: { refresh: 1 } } : undefined,
    )
    agentRuntimes.value = res?.data || []
    // 成功但列表为空同样按失败态处理：本机至少应有 shell 运行时可报
    agentRuntimesFailed.value = agentRuntimes.value.length === 0
  } catch {
    agentRuntimesFailed.value = true
  } finally {
    runtimesLoading.value = false
  }
}
function installCmd(name: string): string {
  return name === 'claude' ? 'npm install -g @anthropic-ai/claude-code'
    : name === 'codex' ? 'npm install -g @openai/codex'
      : name === 'dsh' ? 'npm install -g @deepseek-ai/dsh'
        : ''
}
/** 在新终端会话中执行安装命令（B5）：shell 一等运行时 + launchArgs 初始命令
 *  通道——用户在自己的终端里看安装全程，服务端不静默注入可执行内容 */
const installing = ref('')
async function installInTerminal(name: string) {
  if (installing.value) return
  installing.value = name
  try {
    const { useTerminalSessionsStore } = await import('../../stores/terminal-sessions')
    const { useAgentTerminal } = await import('../../composables/useAgentTerminal')
    const info = await useTerminalSessionsStore().createAgent(
      `${name} install`, 'shell', undefined, { launchArgs: installCmd(name) },
    )
    if (info) {
      useAgentTerminal().open()
      message.success(t('settings.runtimeInstallStarted', { name }))
    } else {
      message.error(t('settings.runtimeInstallFailed'))
    }
  } finally {
    installing.value = ''
  }
}
async function copyInstallCmd(name: string) {
  const cmd = installCmd(name)
  if (!cmd) return
  try {
    await navigator.clipboard.writeText(cmd)
    copiedRuntime.value = name
    setTimeout(() => { copiedRuntime.value = '' }, 1500)
  } catch { /* 剪贴板不可用静默 */ }
}
const agentProviderOptions = ref<{ label: string; value: string }[]>([])

// === 关闭护栏：未保存修改在 × / 关闭 / Esc 任一路径都不再静默丢弃 ===
const savedGeneral = ref({ autoFetch: false, fetchInterval: '300', externalAccessUrl: '', sharePublicBaseUrl: '', agentProvider: 'auto', agentGuard: true, agentApprovalMode: 'ask', approvalRecording: false, approvalTimeoutMin: 0, uiSnapshotEnabled: true, sessionContext: 'git', shareDefaultTTL: 'permanent', agentNamingNoteEnabled: true, agentAutoNameEnabled: true, previewCompatMode: false, opsAtomDownload: true, opsAtomClipboard: true, opsAtomOpen: true, opsAtomReload: true })

async function load() {
  // frontend 原子开关住本地/漫游 store（非服务端 settings 字段），分区打开时
  // 对齐 store 现值即可（opsAtomPrefs 自建即从 localStorage 同步）；放 try 外
  // ——GET 失败时 pending 值也须对齐真值，否则关护栏拿旧编辑态误报脏
  resetOpsAtomLocal()
  try {
    const res: any = await settingsApi.get()
    autoFetchEnabled.value = res.data?.autoFetch || false
    fetchIntervalStr.value = String(res.data?.fetchInterval || 300)
    externalAccessUrl.value = res.data?.externalAccessUrl || ''
    sharePublicBaseUrl.value = res.data?.sharePublicBaseUrl || ''
    agentProvider.value = res.data?.agentProvider || 'auto'
    agentGuard.value = res.data?.agentGuard !== false
    // 服务端 GET 已按有效档位归一（24h 过期回 ask），未知值保守回落 ask
    const storedMode = res.data?.agentApprovalMode
    agentApprovalMode.value = storedMode === 'allow' || storedMode === 'allow-session' || storedMode === 'allow-24h'
      ? storedMode
      : 'ask'
    agentApprovalExpiresAt.value = res.data?.agentApprovalExpiresAt || ''
    approvalRecording.value = res.data?.approvalRecording === true
    approvalTimeoutMin.value = Number(res.data?.agentApprovalTimeoutMin) || 0
    uiSnapshotEnabled.value = res.data?.uiSnapshotEnabled !== false
    // 服务端 GET 已归一（未配置/脏值回落 permanent）
    const storedShareTtl = res.data?.shareDefaultTTL
    shareDefaultTTL.value = storedShareTtl === '1d' || storedShareTtl === '7d' || storedShareTtl === '30d'
      ? storedShareTtl
      : 'permanent'
    // 服务端 GET 已归一（空值回落 git、规范序），parse 只做 token 集合还原
    sessionContextSelected.value = parseSessionContext(res.data?.sessionContext ?? '')
    // 未配置/旧服务端缺键默认开（与创建漏斗 OrDefault 同源）
    agentNamingNoteEnabled.value = res.data?.agentNamingNoteEnabled !== false
    // 未配置/旧服务端缺键默认开（与观察器 OrDefault 同源，P-20261111-6 S2）
    agentAutoNameEnabled.value = res.data?.agentAutoNameEnabled !== false
    // 未配置/旧服务端缺键默认关（= 沙箱隔离生效，P-20261019-1）
    previewCompatMode.value = res.data?.previewCompatMode === true
    void loadAgentRuntimes()
    applyAgentProviderOptions(
      res.data?.agentProviders || [],
      res.data?.customAgents || [],
    )
  } catch { /* silent */ }
  savedGeneral.value = {
    autoFetch: autoFetchEnabled.value,
    fetchInterval: fetchIntervalStr.value,
    externalAccessUrl: externalAccessUrl.value,
    sharePublicBaseUrl: sharePublicBaseUrl.value,
    agentProvider: agentProvider.value,
    agentGuard: agentGuard.value,
    agentApprovalMode: agentApprovalMode.value,
    approvalRecording: approvalRecording.value,
    approvalTimeoutMin: approvalTimeoutMin.value ?? 0,
    uiSnapshotEnabled: uiSnapshotEnabled.value,
    opsAtomDownload: opsAtomLocal.value.download,
    opsAtomClipboard: opsAtomLocal.value.clipboard,
    opsAtomOpen: opsAtomLocal.value.open,
    opsAtomReload: opsAtomLocal.value.reload,
    sessionContext: serializeSessionContext(sessionContextSelected.value),
    shareDefaultTTL: shareDefaultTTL.value,
    agentNamingNoteEnabled: agentNamingNoteEnabled.value,
    agentAutoNameEnabled: agentAutoNameEnabled.value,
    previewCompatMode: previewCompatMode.value,
  }
}

/** 默认智能体下拉成项：auto + 服务端注册名单（新增 Provider/自定义智能体自动可配），
 * 自定义智能体展示 displayName（内置回落注册名） */
function applyAgentProviderOptions(names: string[], customAgents: { name: string; displayName?: string }[]) {
  const display = new Map(customAgents.map(a => [a.name, a.displayName || a.name]))
  agentProviderOptions.value = [
    { label: t('settings.agentProviderAuto'), value: 'auto' },
    ...names.filter(n => n !== 'auto').map(n => ({ label: display.get(n) || n, value: n })),
  ]
}

/** 自定义智能体增删改后同步：只刷新下拉与运行时状态区（不整表重载，
 * 避免通用分区里未保存的编辑被服务端值覆盖） */
async function onCustomAgentsChanged() {
  try {
    const res: any = await settingsApi.get()
    applyAgentProviderOptions(res.data?.agentProviders || [], res.data?.customAgents || [])
  } catch { /* silent */ }
  void loadAgentRuntimes()
}

function isDirty(): boolean {
  return autoFetchEnabled.value !== savedGeneral.value.autoFetch
    || fetchIntervalStr.value !== savedGeneral.value.fetchInterval
    || externalAccessUrl.value.trim() !== savedGeneral.value.externalAccessUrl
    || sharePublicBaseUrl.value.trim() !== savedGeneral.value.sharePublicBaseUrl
    || agentProvider.value !== savedGeneral.value.agentProvider
    || agentGuard.value !== savedGeneral.value.agentGuard
    || agentApprovalMode.value !== savedGeneral.value.agentApprovalMode
    || approvalRecording.value !== savedGeneral.value.approvalRecording
    || (approvalTimeoutMin.value ?? 0) !== savedGeneral.value.approvalTimeoutMin
    || uiSnapshotEnabled.value !== savedGeneral.value.uiSnapshotEnabled
    || opsAtomLocal.value.download !== savedGeneral.value.opsAtomDownload
    || opsAtomLocal.value.clipboard !== savedGeneral.value.opsAtomClipboard
    || opsAtomLocal.value.open !== savedGeneral.value.opsAtomOpen
    || opsAtomLocal.value.reload !== savedGeneral.value.opsAtomReload
    || serializeSessionContext(sessionContextSelected.value) !== savedGeneral.value.sessionContext
    || shareDefaultTTL.value !== savedGeneral.value.shareDefaultTTL
    || agentNamingNoteEnabled.value !== savedGeneral.value.agentNamingNoteEnabled
    || agentAutoNameEnabled.value !== savedGeneral.value.agentAutoNameEnabled
    || previewCompatMode.value !== savedGeneral.value.previewCompatMode
}

/** 父组件 SettingsModal「保存」链的第一步：失败时向上抛错，
 * 由弹窗统一 message.error 并保持弹窗打开（各子分区保存不被触发） */
async function save() {
  // 外部访问地址保存前本地校验：非法值抛错由 SettingsModal 统一提示并保持
  // 弹窗打开（服务端同规则二次校验，双保险）；合法值归一后落盘
  const external = normalizeExternalAccessUrl(externalAccessUrl.value)
  if (external.error) throw new Error(t('settings.externalAccessUrlInvalid'))
  externalAccessUrl.value = external.url
  // 分享外发基址与外部访问地址同规则；错误文案独立（用户要知道是哪一项）
  const shareBase = normalizeExternalAccessUrl(sharePublicBaseUrl.value)
  if (shareBase.error) throw new Error(t('settings.sharePublicBaseUrlInvalid'))
  sharePublicBaseUrl.value = shareBase.url
  await settingsApi.update({
    autoFetch: autoFetchEnabled.value,
    fetchInterval: parseInt(fetchIntervalStr.value) || 300,
    externalAccessUrl: external.url,
    sharePublicBaseUrl: shareBase.url,
    agentProvider: agentProvider.value,
    agentGuard: agentGuard.value,
    agentApprovalMode: agentApprovalMode.value,
    approvalRecording: approvalRecording.value,
    agentApprovalTimeoutMin: approvalTimeoutMin.value ?? 0,
    uiSnapshotEnabled: uiSnapshotEnabled.value,
    // 空集序列化为 none（显式全关语义），服务端白名单 + 规范序归一后落盘
    sessionContext: serializeSessionContext(sessionContextSelected.value),
    shareDefaultTTL: shareDefaultTTL.value,
    agentNamingNoteEnabled: agentNamingNoteEnabled.value,
    agentAutoNameEnabled: agentAutoNameEnabled.value,
    previewCompatMode: previewCompatMode.value,
  })
  // frontend 原子开关经 store 正门落地（localStorage + userPrefs 漫游双写在
  // set 内），与上方 settingsApi.update 同拍生效（modal「保存」链语义）
  for (const id of OPS_ATOM_IDS) opsAtomStore.set(id, opsAtomLocal.value[id])
}

// 弹窗每次打开重新拉取（n-modal 默认 display-directive="if" 内容随开关重建，
// onMounted 覆盖首开、watch 兜底常驻形态；SecuritySettings 同款双保险）
onMounted(() => {
  if (props.show) void load()
})
watch(() => props.show, (val) => {
  if (val) void load()
})

defineExpose({ load, save, isDirty })
</script>

<template>
  <label class="setting-row">
    <n-checkbox
      v-model:checked="autoFetchEnabled"
      size="small"
    />
    <div class="setting-meta">
      <div class="setting-label">{{ t('settings.autoFetchDesc') }}</div>
    </div>
    <SettingModifiedMark
      :modified="autoFetchEnabled !== GENERAL_DEFAULTS.autoFetch"
      @restore="autoFetchEnabled = GENERAL_DEFAULTS.autoFetch"
    />
  </label>
  <div
    v-if="autoFetchEnabled"
    class="setting-row"
  >
    <span class="setting-label-inline">{{ t('layout.intervalLabel') }}</span>
    <n-input
      v-model:value="fetchIntervalStr"
      size="small"
      style="width: 100px"
    />
    <span class="setting-label-inline">{{ t('layout.seconds') }}</span>
    <SettingModifiedMark
      :modified="fetchIntervalStr !== GENERAL_DEFAULTS.fetchInterval"
      @restore="fetchIntervalStr = GENERAL_DEFAULTS.fetchInterval"
    />
  </div>
  <!-- 外部访问地址（P-20261019-10）：手机不在同一 Wi-Fi 时的扫码入口；
       仅 http/https origin（无路径/参数/凭据），保存前本地校验 -->
  <div
    class="setting-row"
    style="cursor: default"
    data-testid="settings-external-access-url"
  >
    <span class="setting-label-inline">{{ t('settings.externalAccessUrl') }}</span>
    <n-input
      v-model:value="externalAccessUrl"
      size="small"
      style="width: 260px"
      :placeholder="t('settings.externalAccessUrlPlaceholder')"
      clearable
    />
    <SettingModifiedMark
      :modified="externalAccessUrl.trim() !== GENERAL_DEFAULTS.externalAccessUrl"
      @restore="externalAccessUrl = GENERAL_DEFAULTS.externalAccessUrl"
    />
  </div>
  <div
    class="setting-row"
    style="margin-top: -6px; cursor: default"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.externalAccessUrlDesc') }}
      </div>
    </div>
  </div>
  <!-- 分享链接外发基址（P-20261020-2）：分享 URL 固定为 <base>/s/<token>；
       反代/隧道只转发主端口或分享域名独立时用它。空=自动选址 -->
  <div
    class="setting-row"
    style="cursor: default"
    data-testid="settings-share-public-base-url"
  >
    <span class="setting-label-inline">{{ t('settings.sharePublicBaseUrl') }}</span>
    <n-input
      v-model:value="sharePublicBaseUrl"
      size="small"
      style="width: 260px"
      :placeholder="t('settings.sharePublicBaseUrlPlaceholder')"
      clearable
    />
    <SettingModifiedMark
      :modified="sharePublicBaseUrl.trim() !== GENERAL_DEFAULTS.sharePublicBaseUrl"
      @restore="sharePublicBaseUrl = GENERAL_DEFAULTS.sharePublicBaseUrl"
    />
  </div>
  <div
    class="setting-row"
    style="margin-top: -6px; cursor: default"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.sharePublicBaseUrlDesc') }}
      </div>
    </div>
  </div>
  <div class="setting-row">
    <span class="setting-label-inline">{{ t('settings.agentProvider') }}</span>
    <n-select
      v-model:value="agentProvider"
      :options="agentProviderOptions"
      size="small"
      style="width: 200px"
    />
    <SettingModifiedMark
      :modified="agentProvider !== GENERAL_DEFAULTS.agentProvider"
      @restore="agentProvider = GENERAL_DEFAULTS.agentProvider"
    />
  </div>
  <div
    class="setting-row"
    style="margin-top: -6px"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.agentProviderDesc') }}
      </div>
    </div>
  </div>
  <!-- 会话启动上下文（P-20261006-47）：新建 agent 会话自动附带的「工作台背景
  资料」多选（P-176 git 摘要的配置面），settings.changed 广播后 ask 链与新建
  对话框经 sessionContext store 重读跟随 -->
  <div
    class="setting-row"
    style="margin-top: 4px"
    data-testid="settings-session-context"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.sessionContextLabel') }}
      </div>
      <div class="sc-context-options">
        <n-checkbox
          v-for="opt in sessionContextOptions"
          :key="opt"
          size="small"
          :checked="sessionContextSelected.includes(opt)"
          :data-testid="`settings-session-context-${opt}`"
          @update:checked="v => toggleSessionContext(opt, v)"
        >
          {{ t(SESSION_CONTEXT_LABEL_KEYS[opt]) }}
        </n-checkbox>
      </div>
      <div
        class="setting-hint"
        data-testid="settings-session-context-hint"
      >
        {{ t('settings.sessionContextHint') }}
      </div>
    </div>
    <SettingModifiedMark
      :modified="serializeSessionContext(sessionContextSelected) !== GENERAL_DEFAULTS.sessionContext"
      @restore="sessionContextSelected = parseSessionContext(GENERAL_DEFAULTS.sessionContext)"
    />
  </div>
  <!-- 会话命名系统注记注入（P-20261023-3）：带 prompt 创建会话时服务端在
       prompt 尾部附命名指令注记（任务演化后重命名 + 先查重）——改名的驱动
       力从「指望 agent 自觉」升级为每次会话随行；默认开，关闭回落既有行为 -->
  <div
    class="setting-row"
    data-testid="settings-agent-naming-note"
  >
    <n-checkbox v-model:checked="agentNamingNoteEnabled">
      {{ t('settings.agentNamingNoteLabel') }}
    </n-checkbox>
    <SettingModifiedMark
      :modified="agentNamingNoteEnabled !== GENERAL_DEFAULTS.agentNamingNoteEnabled"
      @restore="agentNamingNoteEnabled = GENERAL_DEFAULTS.agentNamingNoteEnabled"
    />
  </div>
  <div
    class="setting-hint"
    style="margin-top: -2px"
    data-testid="settings-agent-naming-note-hint"
  >
    {{ t('settings.agentNamingNoteHint') }}
  </div>
  <!-- 会话自动命名（P-20261111-6 S2）：claude 会话首条用户消息落盘后服务端
       按其总结会话名（~40 字符截断，手动改名过永不覆盖）——多会话列表可读性；
       默认开（本提案目的即行为变化），关闭回落纯手动改名 -->
  <div
    class="setting-row"
    data-testid="settings-agent-auto-name"
  >
    <n-checkbox v-model:checked="agentAutoNameEnabled">
      {{ t('settings.agentAutoNameLabel') }}
    </n-checkbox>
    <SettingModifiedMark
      :modified="agentAutoNameEnabled !== GENERAL_DEFAULTS.agentAutoNameEnabled"
      @restore="agentAutoNameEnabled = GENERAL_DEFAULTS.agentAutoNameEnabled"
    />
  </div>
  <div
    class="setting-hint"
    style="margin-top: -2px"
    data-testid="settings-agent-auto-name-hint"
  >
    {{ t('settings.agentAutoNameHint') }}
  </div>
  <!-- 新建分享默认有效期（P-20261020-5）：创建弹层未主动改选时应用；
       缺省永久 = 存量行为零变化。仅影响 live 文件分享（frozen 固定 30 天
       默认，其余形态各有固定窗口） -->
  <div
    class="setting-row"
    data-testid="settings-share-default-ttl"
  >
    <span class="setting-label-inline">{{ t('settings.shareDefaultTTL') }}</span>
    <n-select
      v-model:value="shareDefaultTTL"
      size="small"
      style="width: 160px"
      :options="shareDefaultTtlOptions"
      data-testid="settings-share-default-ttl-select"
    />
    <SettingModifiedMark
      :modified="shareDefaultTTL !== GENERAL_DEFAULTS.shareDefaultTTL"
      @restore="shareDefaultTTL = GENERAL_DEFAULTS.shareDefaultTTL"
    />
  </div>
  <div
    class="setting-row"
    style="margin-top: -6px"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.shareDefaultTTLDesc') }}
      </div>
    </div>
  </div>
  <div
    v-if="agentRuntimes.length > 0"
    class="setting-row"
    style="margin-top: 4px"
  >
    <div class="rt-status">
      <div
        v-for="rt in agentRuntimes"
        :key="rt.name"
        class="rt-item"
      >
        <span
          class="rt-dot"
          :class="{ ok: rt.available }"
        />
        <span class="rt-name">{{ rt.displayName || rt.name }}</span>
        <span class="rt-version">{{ rt.available ? (rt.version || '—') : t('settings.runtimeNotInstalled') }}</span>
        <template v-if="!rt.available && installCmd(rt.name)">
          <n-button
            size="tiny"
            type="primary"
            :loading="installing === rt.name"
            @click="installInTerminal(rt.name)"
          >
            {{ t('settings.runtimeInstallInTerminal') }}
          </n-button>
          <n-button
            size="tiny"
            quaternary
            :title="installCmd(rt.name)"
            @click="copyInstallCmd(rt.name)"
          >
            {{ copiedRuntime === rt.name ? t('settings.runtimeCopied') : t('settings.runtimeCopyInstall') }}
          </n-button>
        </template>
      </div>
    </div>
    <!-- 手动「运行时检测」（P-20261003-79）：探测结果带 TTL 缓存
     （解析失败 30s/成功 5min + 版本 60s），刚装好/卸载后点此立即如实
     重探；加载态复用 runtimesLoading（列表非空时仅按钮进入 loading） -->
    <div
      class="setting-meta"
      style="margin-top: 4px; display: flex; justify-content: flex-end"
    >
      <n-button
        size="tiny"
        quaternary
        :loading="runtimesLoading"
        :title="t('agent.runtime.detectTip')"
        @click="loadAgentRuntimes(true)"
      >
        {{ t('agent.runtime.detect') }}
      </n-button>
    </div>
  </div>
  <div
    v-else-if="runtimesLoading"
    class="setting-row"
    style="margin-top: 4px"
  >
    <div class="setting-meta">
      <n-spin
        :size="12"
        style="margin-right: 6px"
      />
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.runtimeDetecting') }}
      </div>
    </div>
  </div>
  <div
    v-else
    class="setting-row"
    style="margin-top: 4px"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.runtimeLoadFailed') }}
      </div>
      <n-button
        size="tiny"
        quaternary
        @click="loadAgentRuntimes()"
      >
        {{ t('settings.retry') }}
      </n-button>
    </div>
  </div>
  <!-- 自定义智能体管理：任意 CLI 智能体工具自取注册名接入，变更即时生效 -->
  <CustomAgentsManager @changed="onCustomAgentsChanged" />
  <!-- 任务模板管理（P-20261002-16）：新建会话对话框的任务模板下拉数据面，
       uiState 即时落盘不走设置页「保存」链 -->
  <AgentTaskTemplateManager />
  <!-- 项目规则管理（P-20261003-181）：agent 规则文件（CLAUDE.md 等）
       存在即列/缺失从模板建；「编辑」经文件深链打开并收起设置弹窗 -->
  <ProjectRulesManager @open-file="emit('open-file')" />
  <div
    class="setting-row"
    data-testid="settings-agent-guard"
  >
    <n-checkbox v-model:checked="agentGuard">
      {{ t('settings.agentGuardLabel') }}
    </n-checkbox>
    <SettingModifiedMark
      :modified="agentGuard !== GENERAL_DEFAULTS.agentGuard"
      @restore="agentGuard = GENERAL_DEFAULTS.agentGuard"
    />
  </div>
  <div
    class="setting-row"
    style="margin-top: 4px"
    data-testid="settings-agent-approval-mode"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.agentApprovalModeLabel') }}
      </div>
      <n-select
        v-model:value="agentApprovalMode"
        size="small"
        style="width: 220px"
        :options="agentApprovalModeOptions"
      />
      <!-- 放行 24h 档位提示：在档显剩余时限，改选显保存即起算说明
           （P-20261003-316：时限档位的到期语义就地可见） -->
      <div
        v-if="approval24hHint"
        class="setting-hint"
        data-testid="settings-agent-approval-24h-hint"
      >
        {{ approval24hHint }}
      </div>
    </div>
    <SettingModifiedMark
      :modified="agentApprovalMode !== GENERAL_DEFAULTS.agentApprovalMode"
      @restore="agentApprovalMode = GENERAL_DEFAULTS.agentApprovalMode"
    />
  </div>
  <div
    class="setting-row"
    data-testid="settings-approval-recording"
  >
    <n-checkbox v-model:checked="approvalRecording">
      {{ t('settings.approvalRecordingLabel') }}
    </n-checkbox>
    <SettingModifiedMark
      :modified="approvalRecording !== GENERAL_DEFAULTS.approvalRecording"
      @restore="approvalRecording = GENERAL_DEFAULTS.approvalRecording"
    />
  </div>
  <!-- 用户 UI 现场上报（P-20261004-52）：agent「看着问」供给侧；关=停止上报
       +读取端点查无，settings.changed 广播即时生效（上报器监听重读） -->
  <div
    class="setting-row"
    data-testid="settings-ui-snapshot"
  >
    <n-checkbox v-model:checked="uiSnapshotEnabled">
      {{ t('settings.uiSnapshotLabel') }}
    </n-checkbox>
    <SettingModifiedMark
      :modified="uiSnapshotEnabled !== GENERAL_DEFAULTS.uiSnapshotEnabled"
      @restore="uiSnapshotEnabled = GENERAL_DEFAULTS.uiSnapshotEnabled"
    />
  </div>
  <div
    class="setting-row"
    style="margin-top: -6px"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.uiSnapshotHint') }}
      </div>
    </div>
  </div>
  <!-- 预览同源兼容模式（P-20261019-1）：默认关 = 预览 iframe 沙箱隔离（被预览
       页读不到主应用存储/Cookie/接口）；开启是安全姿态降级，勾选时红色警示
       显式确认（onPreviewCompatToggle 拦截），保存后预览面板经广播即时重建 -->
  <div
    class="setting-row"
    data-testid="settings-preview-compat"
  >
    <n-checkbox
      :checked="previewCompatMode"
      @update:checked="onPreviewCompatToggle"
    >
      {{ t('settings.previewCompatLabel') }}
    </n-checkbox>
    <SettingModifiedMark
      :modified="previewCompatMode !== GENERAL_DEFAULTS.previewCompatMode"
      @restore="previewCompatMode = GENERAL_DEFAULTS.previewCompatMode"
    />
  </div>
  <div
    class="setting-hint"
    style="margin-top: -2px"
    data-testid="settings-preview-compat-hint"
  >
    {{ t('settings.previewCompatHint') }}
  </div>
  <!-- frontend 原子管制（P-20261023-4 + P-20261111-3 重载）：agent 经操作通道
       触发的浏览器即时效应按原子可关（下载框/剪贴板/开标签/页面·视图重载）
       ——每次效应都带可见提示（无静默效应），关档后 agent 对应请求被忽略
       并每窗口至多一条提示 -->
  <div
    class="setting-row"
    style="margin-top: 4px"
    data-testid="settings-ops-atom-download"
  >
    <n-checkbox v-model:checked="opsAtomLocal.download">
      {{ t('settings.opsAtomDownload') }}
    </n-checkbox>
    <SettingModifiedMark
      :modified="opsAtomLocal.download !== GENERAL_DEFAULTS.opsAtomDownload"
      @restore="opsAtomLocal.download = GENERAL_DEFAULTS.opsAtomDownload"
    />
  </div>
  <div
    class="setting-row"
    data-testid="settings-ops-atom-clipboard"
  >
    <n-checkbox v-model:checked="opsAtomLocal.clipboard">
      {{ t('settings.opsAtomClipboard') }}
    </n-checkbox>
    <SettingModifiedMark
      :modified="opsAtomLocal.clipboard !== GENERAL_DEFAULTS.opsAtomClipboard"
      @restore="opsAtomLocal.clipboard = GENERAL_DEFAULTS.opsAtomClipboard"
    />
  </div>
  <div
    class="setting-row"
    data-testid="settings-ops-atom-open"
  >
    <n-checkbox v-model:checked="opsAtomLocal.open">
      {{ t('settings.opsAtomOpen') }}
    </n-checkbox>
    <SettingModifiedMark
      :modified="opsAtomLocal.open !== GENERAL_DEFAULTS.opsAtomOpen"
      @restore="opsAtomLocal.open = GENERAL_DEFAULTS.opsAtomOpen"
    />
  </div>
  <div
    class="setting-row"
    data-testid="settings-ops-atom-reload"
  >
    <n-checkbox v-model:checked="opsAtomLocal.reload">
      {{ t('settings.opsAtomReload') }}
    </n-checkbox>
    <SettingModifiedMark
      :modified="opsAtomLocal.reload !== GENERAL_DEFAULTS.opsAtomReload"
      @restore="opsAtomLocal.reload = GENERAL_DEFAULTS.opsAtomReload"
    />
  </div>
  <div
    class="setting-row"
    style="margin-top: -6px"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.opsAtomsHint') }}
      </div>
    </div>
  </div>
  <!-- 审批等待超时自动拒绝（P-20261003-45）：分钟数，0=不超时；
       越界由 n-input-number min/max 就地钳制，服务端边界同口径兜底 -->
  <div
    class="setting-row"
    style="margin-top: 4px"
  >
    <span class="setting-label-inline">{{ t('approval.timeout.settingsLabel') }}</span>
    <n-input-number
      v-model:value="approvalTimeoutMin"
      size="small"
      style="width: 120px"
      :min="0"
      :max="1440"
      :step="5"
      :show-button="true"
      data-testid="settings-approval-timeout-min"
    />
    <span class="setting-label-inline">{{ t('layout.minutes') }}</span>
    <SettingModifiedMark
      :modified="(approvalTimeoutMin ?? 0) !== GENERAL_DEFAULTS.approvalTimeoutMin"
      @restore="approvalTimeoutMin = GENERAL_DEFAULTS.approvalTimeoutMin"
    />
  </div>
  <div
    class="setting-row"
    style="margin-top: -6px"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('approval.timeout.settingsDesc') }}
      </div>
    </div>
  </div>
  <!-- 上下文警示阈值（P-20261006-33）：会话「上下文将满」警示与活跃行接力放开
       的低余量判定线（sessionRelay.isLowRemaining 注入）。长写作/重构会话调高
       给尾部结论生成留余量，长编译会话出厂 10% 够收尾；设备本地直写即时生效 -->
  <div
    class="setting-row"
    style="margin-top: 4px; cursor: default"
    data-testid="settings-context-warn-threshold"
  >
    <span class="setting-label-inline">{{ t('settings.contextWarnThreshold') }}</span>
    <input
      type="range"
      class="ctx-warn-slider"
      :value="contextWarn.pct"
      :min="CONTEXT_WARN_MIN"
      :max="CONTEXT_WARN_MAX"
      step="1"
      :aria-label="t('settings.contextWarnThreshold')"
      @input="contextWarn.set(Number(($event.target as HTMLInputElement).value))"
    >
    <span
      class="setting-label-inline ctx-warn-value"
      data-testid="settings-context-warn-value"
    >{{ contextWarn.pct }}%</span>
    <SettingModifiedMark
      :modified="contextWarn.pct !== LOW_REMAINING_PCT"
      @restore="contextWarn.set(LOW_REMAINING_PCT)"
    />
  </div>
  <div
    class="setting-row"
    style="margin-top: -6px"
  >
    <div class="setting-meta">
      <div
        class="setting-label"
        style="font-weight: 400"
      >
        {{ t('settings.contextWarnThresholdHint') }}
      </div>
    </div>
  </div>
  <WorkspaceBackup />
  <!-- 设置导出/导入（P-20261005-4）：本地设置族（字号/键位/语言/主题/通知本机
       偏好）的多设备迁移包，自包含区块即时生效不走「保存」链 -->
  <SettingsTransferSection />
</template>

<style scoped>
.setting-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 10px;
  cursor: pointer;
  font-size: 12px;
}
.setting-meta { color: var(--text-body); }
.setting-label { font-size: 12px; line-height: 1.6; }
.setting-label-inline { font-size: 12px; color: var(--text-dim); }
.setting-hint { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
.sc-context-options { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin-top: var(--space-1); }

/* 上下文警示阈值滑条（P-20261006-33）：TerminalSettings .font-slider 同款原生
   range 形态（品牌色 accent + 固定细槽高），宽度收窄——5-30 小档距无需全宽 */
.ctx-warn-slider {
  width: 160px;
  accent-color: var(--brand-accent);
  height: 4px;
}
.ctx-warn-value { color: var(--text-secondary); min-width: 32px; }

.rt-status { display: flex; flex-direction: column; gap: var(--space-1); width: 100%; }
.rt-item { display: flex; align-items: center; gap: var(--space-2); font-size: 0.85em; }
.rt-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
.rt-dot.ok { background: var(--accent-green); }
.rt-name { color: var(--text-primary); font-family: monospace; }
.rt-version { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
