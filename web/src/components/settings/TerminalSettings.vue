<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import {
  NButton, NSelect, NInputNumber, NCheckbox, NTag, NInput, NSwitch, useMessage,
} from 'naive-ui'
import { useFontStore, type TerminalCursorStyle } from '../../stores/font'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useI18n } from '../../composables/useI18n'
import { isCopyOnSelectEnabled, setCopyOnSelectEnabled } from '../../composables/useTerminalClipboard'
import { invalidatePastePrecheckCache } from '../../composables/useTerminalDangerGate'
import { termInstances } from '../../composables/useTerminalInstances'
import { terminalLru, TERMINAL_LRU_KEEP } from '../../composables/terminalLru'
import SnippetManager from './SnippetManager.vue'
import SettingModifiedMark from './SettingModifiedMark.vue'
import {
  settingsApi, terminalApi,
  type TerminalBackend, type SettingsData, type TmuxInfo, type ShellCandidate,
} from '../../api/client'

const props = defineProps<{ show: boolean }>()

const fontStore = useFontStore()
const message = useMessage()
const { t } = useI18n()

// 各行出厂默认（与后端 GET /settings 空值回落一致）：行级「已修改」标记
// （P-20261003-171）的对比基准；恢复 = 复位 pending 值，仍走「保存」链落盘
const DEFAULT_TERMINAL_BACKEND: TerminalBackend = 'auto'
const DEFAULT_HISTORY_ENABLED = true
const DEFAULT_REMOTE_TMUX = false
const DEFAULT_COPY_ON_SELECT = true
const DEFAULT_IDLE_TIMEOUT_MIN = 0

// 终端后端配置（来自后端 settingsApi）
const pendingTerminalBackend = ref<TerminalBackend>(DEFAULT_TERMINAL_BACKEND)
const tmuxAvailable = ref(false)
const isWindowsPlatform = ref(false)
let initialTerminalBackend: TerminalBackend = DEFAULT_TERMINAL_BACKEND

// 终端空闲超时自动分离（P-20261003-192，分钟粒度存储；默认 0 = 关）。
// UI 呈现 N 小时档位（提案口径），1 小时之下的更细档位仅供 API/e2e 注入
const pendingIdleTimeoutMin = ref<number>(DEFAULT_IDLE_TIMEOUT_MIN)
let initialIdleTimeoutMin: number = DEFAULT_IDLE_TIMEOUT_MIN

// 终端默认 shell（P-20261004-57）：空 = 跟随平台缺省序（历史行为）。候选来自
// 服务端探测（shell-candidates 端点，LookPath 口径），自定义路径输入兜底——
// 候选清单收不全的 shell（nushell 包装脚本等）手填，保存时服务端存在性校验
const pendingDefaultShell = ref('')
let initialDefaultShell = ''
const shellCandidates = ref<ShellCandidate[]>([])
const shellResolvedDefault = ref('')
/** 自定义档哨兵：选中时展开路径输入框（值本体存 pendingDefaultShell） */
const CUSTOM_SHELL = '__custom__'
/** 用户显式切到自定义档（与「pending 值不在候选内」两种态都展开输入框） */
const shellCustomMode = ref(false)

// 空闲分离档位（value = 分钟）：关闭 / 1 / 2 / 4 / 8 / 24 小时 / 3 天 / 7 天
const idleTimeoutOptions = computed(() => {
  const unit = t('settings.terminalIdleTimeoutUnit')
  const dayUnit = t('settings.terminalIdleTimeoutDayUnit')
  return [
    { label: t('settings.terminalIdleTimeoutOff'), value: 0 },
    { label: `1 ${unit}`, value: 60 },
    { label: `2 ${unit}`, value: 120 },
    { label: `4 ${unit}`, value: 240 },
    { label: `8 ${unit}`, value: 480 },
    { label: `24 ${unit}`, value: 1440 },
    { label: `3 ${dayUnit}`, value: 4320 },
    { label: `7 ${dayUnit}`, value: 10080 },
  ]
})

// 终端 scrollback 行数（与后端 terminalScrollbackLines 对应，需重连/新开 tab 才生效）
const DEFAULT_SCROLLBACK_LINES = 20000
const pendingScrollbackLines = ref<number>(DEFAULT_SCROLLBACK_LINES)
let initialScrollbackLines: number = DEFAULT_SCROLLBACK_LINES

// 命令历史记录开关（与后端 terminalHistoryEnabled 对应，默认开）
const pendingHistoryEnabled = ref(DEFAULT_HISTORY_ENABLED)
let initialHistoryEnabled = DEFAULT_HISTORY_ENABLED

// 高危命令粘贴预检开关（P-20261005-191，与后端 terminalPastePrecheckEnabled
// 对应，默认开）：粘贴链/palette 直达插入链写入 PTY 前对高危命令弹影响面确认卡。
// 失效联动：保存/关闭后 invalidatePastePrecheckCache 让 gate 缓存即时跟上
const DEFAULT_PASTE_PRECHECK_ENABLED = true
const pendingPastePrecheck = ref(DEFAULT_PASTE_PRECHECK_ENABLED)
let initialPastePrecheck = DEFAULT_PASTE_PRECHECK_ENABLED

// 远程终端 tmux 持久化开关（与后端 terminalRemoteTmux 对应，默认关；新会话生效）
const pendingRemoteTmux = ref(DEFAULT_REMOTE_TMUX)
let initialRemoteTmux = DEFAULT_REMOTE_TMUX

// dsh（DeepSeek Harness）Web UI 集成（P6）：上游地址/令牌/反代端口。
// dsh 反代配置变更即时重绑定监听（无需重启本系统；见 server/api/tools/dsh.go）
const DEFAULT_DSH_BASE = 'http://127.0.0.1:3080'
const DEFAULT_DSH_PROXY_PORT = 3081
const pendingDshWebBase = ref(DEFAULT_DSH_BASE)
const pendingDshWebToken = ref('')
const pendingDshLaunchCommand = ref('')
const pendingDshProxyPort = ref<number>(DEFAULT_DSH_PROXY_PORT)
const pendingDshExposeAll = ref(false)
const pendingDshNpmCommand = ref('')
let initialDshWebBase = DEFAULT_DSH_BASE
let initialDshWebToken = ''
let initialDshLaunchCommand = ''
let initialDshProxyPort = DEFAULT_DSH_PROXY_PORT
let initialDshExposeAll = false
let initialDshAllowStandalone = true
let initialDshNpmCommand = ''
const pendingDshAllowStandalone = ref(true)

// tmux 状态（单独 API 拉取，安装后刷新）
const tmuxInfo = ref<TmuxInfo | null>(null)
const tmuxInstalling = ref(false)

// 终端后端下拉选项（Windows 平台隐藏 tmux）
const terminalBackendOptions = computed(() => {
  const opts = [
    { label: t('settings.terminalBackendAuto'), value: 'auto' as TerminalBackend },
    { label: t('settings.terminalBackendNative'), value: 'native' as TerminalBackend },
  ]
  if (!isWindowsPlatform.value && tmuxAvailable.value) {
    opts.splice(1, 0, { label: t('settings.terminalBackendTmux'), value: 'tmux' as TerminalBackend })
  }
  return opts
})

// 默认 shell 下拉：跟随默认（预览服务端解析的当前生效值）+ 探测候选（不可用
// 项置灰展示保可发现性）+ 自定义路径档。候选值取解析后的完整路径（跨 PATH
// 差异确定性；getShell / ScriptForShell 对路径与裸名同价）
const defaultShellOptions = computed(() => [
  {
    label: shellResolvedDefault.value
      ? t('settings.terminalDefaultShellFollowWith', { shell: shellResolvedDefault.value })
      : t('settings.terminalDefaultShellFollow'),
    value: '',
  },
  ...shellCandidates.value.map(c => ({
    label: c.available ? `${c.name} · ${c.path}` : `${c.name} (${t('settings.terminalDefaultShellNotFound')})`,
    value: c.path || `${CUSTOM_SHELL}:${c.name}`,
    disabled: !c.available,
  })),
  { label: t('settings.terminalDefaultShellCustom'), value: CUSTOM_SHELL },
])

/** 自定义输入框可见性：用户显式切档，或已保存的自定义路径不在候选清单内 */
const defaultShellCustomActive = computed(() =>
  shellCustomMode.value ||
  (pendingDefaultShell.value !== '' && !shellCandidates.value.some(c => c.available && c.path === pendingDefaultShell.value)))

/** 下拉选中值视图：pending 值命中候选/为空（且不在自定义档）→ 原样；否则哨兵档 */
const defaultShellSelectValue = computed(() => {
  if (defaultShellCustomActive.value) return CUSTOM_SHELL
  return pendingDefaultShell.value
})

function onDefaultShellSelect(v: string) {
  shellCustomMode.value = v === CUSTOM_SHELL
  if (v !== CUSTOM_SHELL) {
    pendingDefaultShell.value = v
  }
}

function restoreDefaultShell() {
  pendingDefaultShell.value = ''
  shellCustomMode.value = false
}

async function load() {
  try {
    const res = await settingsApi.get() as unknown as { data: SettingsData }
    const data = res.data
    pendingTerminalBackend.value = (data.terminalBackend ?? 'auto') as TerminalBackend
    tmuxAvailable.value = !!data.tmuxAvailable
    isWindowsPlatform.value = String(data.platform || '').startsWith('win')
    initialTerminalBackend = pendingTerminalBackend.value
    pendingScrollbackLines.value = Number(data.terminalScrollbackLines) > 0
      ? Number(data.terminalScrollbackLines)
      : DEFAULT_SCROLLBACK_LINES
    initialScrollbackLines = pendingScrollbackLines.value
    pendingIdleTimeoutMin.value = Number(data.terminalIdleTimeoutMin) > 0
      ? Number(data.terminalIdleTimeoutMin)
      : DEFAULT_IDLE_TIMEOUT_MIN
    initialIdleTimeoutMin = pendingIdleTimeoutMin.value
    pendingDefaultShell.value = data.terminalDefaultShell || ''
    initialDefaultShell = pendingDefaultShell.value
    shellCustomMode.value = false // 重开复位自定义档（输入态不跨打开残留）
    if (typeof data.terminalHistoryEnabled === 'boolean') {
      pendingHistoryEnabled.value = data.terminalHistoryEnabled
      initialHistoryEnabled = data.terminalHistoryEnabled
    }
    if (typeof data.terminalPastePrecheckEnabled === 'boolean') {
      pendingPastePrecheck.value = data.terminalPastePrecheckEnabled
      initialPastePrecheck = data.terminalPastePrecheckEnabled
    }
    if (typeof data.terminalRemoteTmux === 'boolean') {
      pendingRemoteTmux.value = data.terminalRemoteTmux
      initialRemoteTmux = data.terminalRemoteTmux
    }
    pendingDshWebBase.value = data.dshWebBase || DEFAULT_DSH_BASE
    pendingDshWebToken.value = data.dshWebToken || ''
    pendingDshLaunchCommand.value = data.dshLaunchCommand || ''
    pendingDshProxyPort.value = Number(data.dshProxyPort) > 0
      ? Number(data.dshProxyPort)
      : 0
    initialDshWebBase = pendingDshWebBase.value
    initialDshWebToken = pendingDshWebToken.value
    initialDshLaunchCommand = pendingDshLaunchCommand.value
    initialDshProxyPort = pendingDshProxyPort.value
    pendingDshExposeAll.value = !!data.dshExposeAll
    pendingDshAllowStandalone.value = data.dshAllowStandalone === true
    pendingDshNpmCommand.value = data.dshNpmCommand || ''
    initialDshExposeAll = pendingDshExposeAll.value
    initialDshAllowStandalone = pendingDshAllowStandalone.value
    initialDshNpmCommand = pendingDshNpmCommand.value
  } catch {
    // silent：保留默认值
  }
  // shell 候选 + 当前生效默认（独立端点，失败只降级下拉为「跟随默认」档，
  // 不影响其他设置）
  try {
    const res = await terminalApi.listShellCandidates() as unknown as { data?: { candidates?: ShellCandidate[]; defaultShell?: string } }
    shellCandidates.value = res.data?.candidates || []
    shellResolvedDefault.value = res.data?.defaultShell || ''
  } catch { /* silent */ }
  // 独立拉 tmux 详情（版本/安装状态），失败不影响其他设置
  try {
    const res = await terminalApi.tmuxInfo() as unknown as { data: TmuxInfo }
    tmuxInfo.value = res.data
    // tmux 详情刷新后同步 tmuxAvailable（用户可能刚装好 tmux）
    tmuxAvailable.value = !!res.data.available
  } catch { /* silent */ }
}

// 一键安装 tmux：best-effort，可能需要 sudo（提示用户）
async function installTmux() {
  if (tmuxInstalling.value) return
  tmuxInstalling.value = true
  try {
    const res = await terminalApi.installTmux() as unknown as { data: { success: boolean; command: string; output: string; needsSudo: boolean } }
    const r = res.data
    if (r.needsSudo) {
      // 非 root 且包管理器需要 root：提示用户手动执行
      message.warning(t('settings.tmuxInstallNeedsSudo', { cmd: r.command }))
    } else if (r.success) {
      message.success(t('settings.tmuxInstallSuccess'))
      // 重新拉取 tmux 信息（验证安装结果）
      await load()
    } else {
      message.error(t('settings.tmuxInstallFailed', { output: r.output?.slice(0, 200) || '' }))
    }
  } catch (e: any) {
    // 异常文案与命令输出分开：userMessage（友好）为主，原文进 Console
    message.error(e?.userMessage || t('errors.unknown'))
  } finally {
    tmuxInstalling.value = false
  }
}

async function save() {
  const backendChanged = pendingTerminalBackend.value !== initialTerminalBackend
  const scrollbackChanged = pendingScrollbackLines.value !== initialScrollbackLines
  const idleTimeoutChanged = pendingIdleTimeoutMin.value !== initialIdleTimeoutMin
  const defaultShellChanged = pendingDefaultShell.value.trim() !== initialDefaultShell
  const historyChanged = pendingHistoryEnabled.value !== initialHistoryEnabled
  const pastePrecheckChanged = pendingPastePrecheck.value !== initialPastePrecheck
  const remoteTmuxChanged = pendingRemoteTmux.value !== initialRemoteTmux
  const dshChanged = pendingDshWebBase.value !== initialDshWebBase
    || pendingDshExposeAll.value !== initialDshExposeAll
    || pendingDshAllowStandalone.value !== initialDshAllowStandalone
    || pendingDshNpmCommand.value !== initialDshNpmCommand
    || pendingDshWebToken.value !== initialDshWebToken
    || pendingDshLaunchCommand.value !== initialDshLaunchCommand
    || pendingDshProxyPort.value !== initialDshProxyPort
  if (backendChanged || scrollbackChanged || idleTimeoutChanged || defaultShellChanged || historyChanged || pastePrecheckChanged || remoteTmuxChanged || dshChanged) {
    try {
      await settingsApi.update({
        ...(backendChanged ? { terminalBackend: pendingTerminalBackend.value } : {}),
        ...(scrollbackChanged ? { terminalScrollbackLines: pendingScrollbackLines.value } : {}),
        ...(idleTimeoutChanged ? { terminalIdleTimeoutMin: pendingIdleTimeoutMin.value } : {}),
        // shell 值 trim 后保存（服务端同口径清洗 + 存在性校验，不存在 400）
        ...(defaultShellChanged ? { terminalDefaultShell: pendingDefaultShell.value.trim() } : {}),
        ...(historyChanged ? { terminalHistoryEnabled: pendingHistoryEnabled.value } : {}),
        ...(pastePrecheckChanged ? { terminalPastePrecheckEnabled: pendingPastePrecheck.value } : {}),
        ...(remoteTmuxChanged ? { terminalRemoteTmux: pendingRemoteTmux.value } : {}),
        ...(dshChanged ? {
          dshWebBase: pendingDshWebBase.value,
          dshWebToken: pendingDshWebToken.value,
          dshLaunchCommand: pendingDshLaunchCommand.value,
          dshProxyPort: pendingDshProxyPort.value,
          dshExposeAll: pendingDshExposeAll.value,
          dshAllowStandalone: pendingDshAllowStandalone.value,
          dshNpmCommand: pendingDshNpmCommand.value,
        } : {}),
      })
      if (backendChanged) initialTerminalBackend = pendingTerminalBackend.value
      if (scrollbackChanged) initialScrollbackLines = pendingScrollbackLines.value
      if (idleTimeoutChanged) initialIdleTimeoutMin = pendingIdleTimeoutMin.value
      if (defaultShellChanged) initialDefaultShell = pendingDefaultShell.value.trim()
      if (historyChanged) initialHistoryEnabled = pendingHistoryEnabled.value
      if (pastePrecheckChanged) {
        initialPastePrecheck = pendingPastePrecheck.value
        // gate 缓存失效：粘贴链/直达链下次预检现拉（本页与他端改档都即时生效）
        invalidatePastePrecheckCache()
      }
      if (remoteTmuxChanged) initialRemoteTmux = pendingRemoteTmux.value
      if (dshChanged) {
        // 反代配置变更即时重绑定监听（base/exposeAll/端口均即时生效）
        initialDshWebBase = pendingDshWebBase.value
        initialDshWebToken = pendingDshWebToken.value
        initialDshLaunchCommand = pendingDshLaunchCommand.value
        initialDshProxyPort = pendingDshProxyPort.value
        initialDshExposeAll = pendingDshExposeAll.value
        initialDshAllowStandalone = pendingDshAllowStandalone.value
        initialDshNpmCommand = pendingDshNpmCommand.value
      }
    } catch {
      // silent：保存失败由 message API 统一处理
    }
  }
}

// resetCloseConfirm 重置「关闭终端二次确认」的「不再提示」状态
// 与 TerminalView.vue 中的 CLOSE_NO_PROMPT_KEY 保持一致
function resetCloseConfirm() {
  localStorage.removeItem('sc.terminal.closeNoConfirm')
}

// 「选中即复制」开关：立即持久化，所有已挂载终端 pane 下次 mouseup 即生效
// （isCopyOnSelectEnabled 每次 mouseup 现读，无需通知各 pane）。写路径收拢到
// setCopyOnSelectEnabled（P-20261007-1：服务端漫游链在此挂脏标记上云）
const copyOnSelect = ref(isCopyOnSelectEnabled())
function onCopyOnSelectChange(checked: boolean) {
  copyOnSelect.value = checked
  setCopyOnSelectEnabled(checked)
}

/** 行级恢复默认（P-20261003-171）：选中即复制为直写行（写即即时生效），
 *  与设置页其余直写行同款语义，不参与 isDirty 脏护栏 */
function restoreCopyOnSelect() {
  onCopyOnSelectChange(DEFAULT_COPY_ON_SELECT)
}

// 光标形态/闪烁（P-20261005-212）：font store 直写行（即时落盘，运行中会话经
// useTerminalInstances / TerminalPane 的 watch 直写 term.options 即时生效），
// 与选中即复制同款不参与 isDirty 脏护栏；修改标记对比基准 = store 导出缺省常量
const cursorStyleOptions = computed(() => [
  { label: t('settings.terminalCursorStyleBlock'), value: 'block' as const },
  { label: t('settings.terminalCursorStyleBar'), value: 'bar' as const },
  { label: t('settings.terminalCursorStyleUnderline'), value: 'underline' as const },
])

function onCursorStyleSelect(v: TerminalCursorStyle) {
  fontStore.setCursorStyle(v)
}

function onCursorBlinkChange(v: boolean) {
  fontStore.setCursorBlink(v)
}

// ── 写链路背压诊断（P-20261004-47）：只读观测面 ──
// 背压丢帧原本完全静默（无计数/无自愈），是「风暴后疑似花屏」的唯一线索。
// 这里按会话展示写链路运行态：在途（pendingWrites）/累计丢弃（droppedWrites）/
// 落定自愈次数（stormHeals）。读数来自 termInstances（本窗口挂载了 pane 的
// 会话才有写链路；别的窗口/未挂载会话不在观测面），会话名经 terminal-sessions
// store 反查、缺册回落裸 id。2s 轮询仅在面板可见时挂载——读的是内存 Map，
// 单次快照 O(会话数)，开销可忽略
interface BackpressureRow {
  id: string
  name: string
  pending: number
  dropped: number
  heals: number
}

const sessionsStore = useTerminalSessionsStore()
const bpRows = ref<BackpressureRow[]>([])
// xterm LRU 驻留观测（P-20261007-21）：活实例计数是内存大户的直接读数
// （每实例 ≈40MB 拉满），驱逐后重挂恢复不回退累计驱逐数
const lruLive = ref(0)
const lruEvicted = ref(0)
const lruKeep = TERMINAL_LRU_KEEP
let bpTimer: ReturnType<typeof setInterval> | null = null

function refreshBackpressure() {
  const rows: BackpressureRow[] = []
  termInstances.forEach((inst, id) => {
    rows.push({
      id,
      name: sessionsStore.sessions.find(s => s.id === id)?.name || id,
      pending: inst.pendingWrites ?? 0,
      dropped: inst.droppedWrites ?? 0,
      heals: inst.stormHeals ?? 0,
    })
  })
  // 按会话名稳定排序，避免 Map 迭代序漂移造成行跳动
  rows.sort((a, b) => a.name.localeCompare(b.name))
  bpRows.value = rows
  const lru = terminalLru.stats()
  lruLive.value = lru.live
  lruEvicted.value = lru.evicted
}

function startBpPolling() {
  refreshBackpressure()
  if (bpTimer === null) bpTimer = setInterval(refreshBackpressure, 2000)
}

function stopBpPolling() {
  if (bpTimer !== null) {
    clearInterval(bpTimer)
    bpTimer = null
  }
  bpRows.value = []
}

/** 丢弃/自愈读数是否值得警示：有丢弃但尚未走到落定自愈 = 屏态可能仍偏离中 */
const bpRowsAttention = computed(() => bpRows.value.some(r => r.dropped > 0 && r.heals === 0))

onMounted(() => {
  if (props.show) {
    load()
    startBpPolling()
  }
})
watch(() => props.show, (val) => {
  if (val) load()
  // 背压诊断读数随面板显隐挂载/摘除轮询（关闭即停，不留后台定时器）
  if (val) startBpPolling()
  else stopBpPolling()
})

onBeforeUnmount(stopBpPolling)

// 关闭护栏：与 save() 的变更检测同一组比较（initial* 快照由 load/save 维护）；
// 选中即复制、关闭确认重置为立即生效，不参与脏判定
function isDirty(): boolean {
  return pendingTerminalBackend.value !== initialTerminalBackend
    || pendingScrollbackLines.value !== initialScrollbackLines
    || pendingIdleTimeoutMin.value !== initialIdleTimeoutMin
    || pendingDefaultShell.value.trim() !== initialDefaultShell
    || pendingHistoryEnabled.value !== initialHistoryEnabled
    || pendingRemoteTmux.value !== initialRemoteTmux
    || pendingDshWebBase.value !== initialDshWebBase
    || pendingDshWebToken.value !== initialDshWebToken
    || pendingDshLaunchCommand.value !== initialDshLaunchCommand
    || pendingDshProxyPort.value !== initialDshProxyPort
    || pendingDshExposeAll.value !== initialDshExposeAll
    || pendingDshNpmCommand.value !== initialDshNpmCommand
}

defineExpose({ load, save, isDirty })
</script>

<template>
  <div class="terminal-settings">
    <!-- 终端字体 -->
    <div
      class="form-group"
      data-testid="settings-terminal-font-size"
    >
      <div class="form-label">
        {{ t('layout.terminalFont') }}
      </div>
      <div class="slider-row">
        <span class="slider-label">{{ t('layout.fontSize') }}</span>
        <input
          type="range"
          :value="fontStore.sizes.terminal"
          min="10"
          max="32"
          step="1"
          class="font-slider"
          @input="fontStore.setSize('terminal', parseInt(($event.target as HTMLInputElement).value))"
        >
        <span class="slider-value">{{ fontStore.sizes.terminal }}px</span>
        <SettingModifiedMark
          :modified="fontStore.sizes.terminal !== fontStore.FONT_DEFAULTS.terminal"
          @restore="fontStore.setSize('terminal', fontStore.FONT_DEFAULTS.terminal)"
        />
      </div>
    </div>

    <!-- 光标形态（P-20261005-212）：block/bar/underline 三选（xterm 原生档位）。
         直写行——写 font store 即时落盘，运行中会话 watch 即时生效，不参与 isDirty -->
    <div
      class="form-group"
      data-testid="settings-terminal-cursor"
    >
      <div class="form-label">
        {{ t('settings.terminalCursorStyle') }}
      </div>
      <div class="slider-row">
        <n-select
          :value="fontStore.cursorStyle"
          :options="cursorStyleOptions"
          size="small"
          style="width: 220px"
          data-testid="settings-terminal-cursor-style"
          @update:value="onCursorStyleSelect"
        />
        <SettingModifiedMark
          :modified="fontStore.cursorStyle !== fontStore.TERMINAL_CURSOR_STYLE_DEFAULT"
          @restore="fontStore.setCursorStyle(fontStore.TERMINAL_CURSOR_STYLE_DEFAULT)"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalCursorStyleHint') }}
      </div>
    </div>

    <!-- 光标闪烁（P-20261005-212）：关 = 静止常显（演示/录屏友好）。直写行同上 -->
    <div
      class="form-group"
      data-testid="settings-terminal-cursor-blink"
    >
      <div class="form-label">
        {{ t('settings.terminalCursorBlink') }}
      </div>
      <div class="slider-row">
        <n-switch
          :value="fontStore.cursorBlink"
          size="small"
          data-testid="settings-terminal-cursor-blink-switch"
          @update:value="onCursorBlinkChange"
        />
        <SettingModifiedMark
          :modified="fontStore.cursorBlink !== fontStore.TERMINAL_CURSOR_BLINK_DEFAULT"
          @restore="fontStore.setCursorBlink(fontStore.TERMINAL_CURSOR_BLINK_DEFAULT)"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalCursorBlinkHint') }}
      </div>
    </div>

    <!-- 终端后端 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.terminalBackend') }}
      </div>
      <div class="slider-row">
        <n-select
          v-model:value="pendingTerminalBackend"
          :options="terminalBackendOptions"
          size="small"
          style="width: 220px"
        />
        <SettingModifiedMark
          :modified="pendingTerminalBackend !== DEFAULT_TERMINAL_BACKEND"
          @restore="pendingTerminalBackend = DEFAULT_TERMINAL_BACKEND"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalBackendHint') }}
      </div>

      <!-- tmux 状态显示（仅非 Windows 平台显示，Windows 不支持 tmux） -->
      <div
        v-if="!isWindowsPlatform && tmuxInfo"
        class="tmux-status"
      >
        <span class="tmux-status-label">{{ t('settings.tmuxStatus') }}:</span>
        <n-tag
          v-if="tmuxInfo.available"
          type="success"
          size="small"
          round
        >
          {{ t('settings.tmuxInstalled') }} · {{ tmuxInfo.version }}
        </n-tag>
        <template v-else>
          <n-tag
            type="warning"
            size="small"
            round
          >
            {{ t('settings.tmuxNotInstalled') }}
          </n-tag>
          <n-button
            v-if="tmuxInfo.installable"
            size="tiny"
            type="primary"
            :loading="tmuxInstalling"
            style="margin-left: 8px"
            @click="installTmux"
          >
            {{ t('settings.tmuxInstall') }}
          </n-button>
          <span
            v-else
            class="tmux-manual-hint"
          >
            {{ t('settings.tmuxInstallManualHint') }}
          </span>
        </template>
        <div
          v-if="!tmuxInfo.available && tmuxInfo.installCommand"
          class="tmux-install-cmd"
        >
          <code>{{ tmuxInfo.installCommand }}</code>
        </div>
        <div
          v-if="!tmuxInfo.available"
          class="tmux-required-hint"
        >
          {{ t('settings.tmuxRequiredHint', { version: tmuxInfo.required }) }}
        </div>
      </div>
    </div>

    <!-- 远程终端 tmux 持久化（作用于远程控制台新建的终端会话） -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.terminalRemoteTmux') }}
      </div>
      <div class="slider-row">
        <n-checkbox v-model:checked="pendingRemoteTmux">
          {{ t('settings.terminalRemoteTmuxEnable') }}
        </n-checkbox>
        <SettingModifiedMark
          :modified="pendingRemoteTmux !== DEFAULT_REMOTE_TMUX"
          @restore="pendingRemoteTmux = DEFAULT_REMOTE_TMUX"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalRemoteTmuxHint') }}
      </div>
    </div>

    <!-- scrollback 行数 -->
    <div
      class="form-group"
      data-testid="settings-terminal-scrollback"
    >
      <div class="form-label">
        {{ t('settings.terminalScrollbackLines') }}
      </div>
      <div class="slider-row">
        <n-input-number
          v-model:value="pendingScrollbackLines"
          :min="1000"
          :max="200000"
          :step="1000"
          size="small"
          style="width: 200px"
        />
        <span class="slider-value-units">{{ t('settings.linesUnit') }}</span>
        <SettingModifiedMark
          :modified="pendingScrollbackLines !== DEFAULT_SCROLLBACK_LINES"
          @restore="pendingScrollbackLines = DEFAULT_SCROLLBACK_LINES"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalScrollbackLinesHint') }}
      </div>
    </div>

    <!-- 空闲自动分离（P-20261003-192）：无输入无输出且无连接附着的会话超时分离 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.terminalIdleTimeout') }}
      </div>
      <div class="slider-row">
        <n-select
          v-model:value="pendingIdleTimeoutMin"
          :options="idleTimeoutOptions"
          size="small"
          style="width: 220px"
          data-testid="settings-terminal-idle-timeout"
        />
        <SettingModifiedMark
          :modified="pendingIdleTimeoutMin !== DEFAULT_IDLE_TIMEOUT_MIN"
          @restore="pendingIdleTimeoutMin = DEFAULT_IDLE_TIMEOUT_MIN"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalIdleTimeoutHint') }}
      </div>
    </div>

    <!-- 默认 shell（P-20261004-57）：候选为服务端探测结果，仅新会话生效 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.terminalDefaultShell') }}
      </div>
      <div class="slider-row">
        <n-select
          :value="defaultShellSelectValue"
          :options="defaultShellOptions"
          size="small"
          style="width: 340px"
          data-testid="settings-terminal-default-shell"
          @update:value="onDefaultShellSelect"
        />
        <SettingModifiedMark
          :modified="pendingDefaultShell.trim() !== ''"
          @restore="restoreDefaultShell"
        />
      </div>
      <div
        v-if="defaultShellCustomActive"
        class="slider-row"
      >
        <n-input
          v-model:value="pendingDefaultShell"
          size="small"
          style="width: 340px"
          :placeholder="t('settings.terminalDefaultShellCustomPlaceholder')"
          data-testid="settings-terminal-default-shell-custom"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalDefaultShellHint') }}
      </div>
    </div>

    <!-- 命令历史记录 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.terminalHistoryEnabled') }}
      </div>
      <div class="slider-row">
        <n-checkbox
          v-model:checked="pendingHistoryEnabled"
          size="small"
        >
          {{ t('settings.terminalHistoryEnabledLabel') }}
        </n-checkbox>
        <SettingModifiedMark
          :modified="pendingHistoryEnabled !== DEFAULT_HISTORY_ENABLED"
          @restore="pendingHistoryEnabled = DEFAULT_HISTORY_ENABLED"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalHistoryEnabledHint') }}
      </div>
    </div>

    <!-- 高危命令粘贴预检（P-20261005-191）：粘贴链/palette 直达写入前影响面
         确认卡的总开关（默认开）。暂存行——保存链落盘，gate 缓存保存后失效 -->
    <div
      class="form-group"
      data-testid="settings-terminal-paste-precheck"
    >
      <div class="form-label">
        {{ t('settings.terminalPastePrecheck') }}
      </div>
      <div class="slider-row">
        <n-checkbox
          v-model:checked="pendingPastePrecheck"
          size="small"
        >
          {{ t('settings.terminalPastePrecheckLabel') }}
        </n-checkbox>
        <SettingModifiedMark
          :modified="pendingPastePrecheck !== DEFAULT_PASTE_PRECHECK_ENABLED"
          @restore="pendingPastePrecheck = DEFAULT_PASTE_PRECHECK_ENABLED"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalPastePrecheckHint') }}
      </div>
    </div>

    <!-- 选中即复制（copy-on-select，全终端统一行为） -->
    <div
      class="form-group"
      data-testid="settings-terminal-copy-on-select"
    >
      <div class="form-label">
        {{ t('settings.terminalCopyOnSelect') }}
      </div>
      <div class="slider-row">
        <n-checkbox
          :checked="copyOnSelect"
          size="small"
          @update:checked="onCopyOnSelectChange"
        >
          {{ t('settings.terminalCopyOnSelectLabel') }}
        </n-checkbox>
        <SettingModifiedMark
          :modified="copyOnSelect !== DEFAULT_COPY_ON_SELECT"
          @restore="restoreCopyOnSelect"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalCopyOnSelectHint') }}
      </div>
      <!-- 分轨标注（P-20261007-1）：复制选中随账号漫游（服务端 userPrefs 单键） -->
      <div class="backend-hint">
        {{ t('settings.syncTrackRoaming') }}
      </div>
    </div>

    <!-- 关闭确认重置 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.resetCloseConfirm') }}
      </div>
      <div class="slider-row">
        <n-button
          size="tiny"
          quaternary
          @click="resetCloseConfirm"
        >
          {{ t('settings.resetCloseConfirm') }}
        </n-button>
      </div>
      <div class="backend-hint">
        {{ t('settings.resetCloseConfirmDesc') }}
      </div>
    </div>

    <!-- 写链路背压诊断（P-20261004-47）：只读观测面，无任何设置语义 -->
    <div
      class="form-group"
      data-testid="settings-terminal-backpressure"
    >
      <div class="form-label">
        {{ t('settings.terminalBackpressureTitle') }}
      </div>
      <!-- xterm LRU 驻留观测（P-20261007-21）：活实例计数 + 累计驱逐，只读 -->
      <div
        class="backend-hint"
        data-testid="settings-terminal-lru-stats"
      >
        {{ t('settings.terminalLruStats', { live: lruLive, keep: lruKeep, evicted: lruEvicted }) }}
      </div>
      <template v-if="bpRows.length > 0">
        <div
          class="bp-table"
          role="table"
        >
          <div
            class="bp-row bp-head"
            role="row"
          >
            <span
              class="bp-cell bp-name"
              role="columnheader"
            >{{ t('settings.terminalBackpressureSession') }}</span>
            <span
              class="bp-cell bp-num"
              role="columnheader"
            >{{ t('settings.terminalBackpressurePending') }}</span>
            <span
              class="bp-cell bp-num"
              role="columnheader"
            >{{ t('settings.terminalBackpressureDropped') }}</span>
            <span
              class="bp-cell bp-num"
              role="columnheader"
            >{{ t('settings.terminalBackpressureHeals') }}</span>
          </div>
          <div
            v-for="row in bpRows"
            :key="row.id"
            class="bp-row"
            role="row"
            data-testid="settings-terminal-bp-row"
            :data-session-id="row.id"
          >
            <span
              class="bp-cell bp-name"
              role="cell"
              :title="row.id"
            >{{ row.name }}</span>
            <span
              class="bp-cell bp-num"
              role="cell"
              data-testid="settings-terminal-bp-pending"
            >{{ row.pending }}</span>
            <span
              class="bp-cell bp-num"
              role="cell"
              :class="{ 'bp-warn': row.dropped > 0 }"
              data-testid="settings-terminal-bp-dropped"
            >{{ row.dropped }}</span>
            <span
              class="bp-cell bp-num"
              role="cell"
              data-testid="settings-terminal-bp-heals"
            >{{ row.heals }}</span>
          </div>
        </div>
        <div
          v-if="bpRowsAttention"
          class="backend-hint bp-attention"
        >
          {{ t('settings.terminalBackpressureAttention') }}
        </div>
      </template>
      <div
        v-else
        class="backend-hint"
      >
        {{ t('settings.terminalBackpressureEmpty') }}
      </div>
      <div class="slider-row bp-actions">
        <n-button
          size="tiny"
          quaternary
          data-testid="settings-terminal-bp-refresh"
          @click="refreshBackpressure"
        >
          {{ t('settings.terminalBackpressureRefresh') }}
        </n-button>
      </div>
      <div class="backend-hint">
        {{ t('settings.terminalBackpressureHint') }}
      </div>
    </div>

    <!-- dsh（DeepSeek Harness）Web UI 集成（P6）：主区「dsh 控制台」视图的通道配置 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.dshWebTitle') }}
      </div>
      <div class="dsh-form-row">
        <span class="dsh-field-label">{{ t('settings.dshWebBase') }}</span>
        <n-input
          v-model:value="pendingDshWebBase"
          size="small"
          :placeholder="DEFAULT_DSH_BASE"
          style="flex: 1"
        />
      </div>
      <div class="dsh-form-row">
        <span class="dsh-field-label">{{ t('settings.dshWebToken') }}</span>
        <n-input
          v-model:value="pendingDshWebToken"
          size="small"
          type="password"
          show-password-on="click"
          :placeholder="t('settings.dshWebTokenPlaceholder')"
          style="flex: 1"
        />
      </div>
      <div class="dsh-form-row">
        <span class="dsh-field-label">{{ t('settings.dshNpmCommand') }}</span>
        <n-input
          v-model:value="pendingDshNpmCommand"
          size="small"
          :placeholder="t('settings.dshNpmCommandPlaceholder')"
          style="flex: 1"
        />
      </div>
      <div class="dsh-form-row">
        <span class="dsh-field-label">{{ t('settings.dshLaunchCommand') }}</span>
        <n-input
          v-model:value="pendingDshLaunchCommand"
          size="small"
          :placeholder="t('settings.dshLaunchCommandPlaceholder')"
          style="flex: 1"
        />
      </div>
      <div class="dsh-form-row">
        <span class="dsh-field-label">{{ t('settings.dshProxyPort') }}</span>
        <n-input-number
          v-model:value="pendingDshProxyPort"
          size="small"
          :min="0"
          :max="65535"
          style="width: 140px"
        />
      </div>
      <div class="dsh-form-row">
        <span class="dsh-field-label">{{ t('settings.dshExposeAll') }}</span>
        <n-switch
          v-model:value="pendingDshExposeAll"
          size="small"
        />
      </div>
      <div class="dsh-form-row">
        <span class="dsh-field-label">{{ t('settings.dshAllowStandalone') }}</span>
        <n-switch
          v-model:value="pendingDshAllowStandalone"
          size="small"
        />
      </div>
      <div class="backend-hint">
        {{ t('settings.dshAllowStandaloneHint') }}
      </div>
      <div class="backend-hint">
        {{ t('settings.dshWebHint') }}
      </div>
    </div>

    <!-- 命令片段管理（C2）：独立子组件，列表 + 新建/编辑/删除 + 系统片段保护 -->
    <SnippetManager />
  </div>
</template>

<style scoped>
.terminal-settings {
  /* container */
}
.tmux-status {
  margin-top: var(--space-2);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.tmux-status-label {
  font-size: 12px;
  color: var(--text-dim);
}
.tmux-manual-hint {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-dim);
}
.tmux-install-cmd {
  margin-top: 6px;
  width: 100%;
}
.tmux-install-cmd code {
  font-family: var(--font-mono);
  font-size: var(--fs-meta-min, 11.5px);
  padding: var(--space-1) var(--space-2);
  background: var(--bg-canvas);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--brand-accent);
}
.tmux-required-hint {
  margin-top: var(--space-1);
  width: 100%;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-dim);
}
.form-group { margin-bottom: 18px; }
.dsh-form-row { display: flex; align-items: center; gap: var(--space-2); margin-bottom: 6px; }
.dsh-field-label { width: 90px; flex-shrink: 0; font-size: 12px; color: var(--text-secondary); }
.form-label {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: var(--space-2);
}
.slider-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 6px;
}
.slider-label {
  font-size: 12px;
  color: var(--text-dim);
  min-width: 80px;
}
.font-slider {
  flex: 1;
  accent-color: var(--brand-accent);
  height: 4px;
  max-width: 280px;
}
.slider-value {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-secondary);
  min-width: 36px;
  text-align: center;
  font-family: var(--font-mono);
}
.slider-value-units {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-dim);
}
.backend-hint {
  margin-top: 6px;
  margin-left: 0;
  padding-left: 0;
  font-size: var(--fs-meta-min, 11.5px);
  line-height: 1.5;
  color: var(--text-dim);
}
/* 写链路背压诊断（P-20261004-47）：紧凑读数表 */
.bp-table {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  overflow: hidden;
  max-width: 480px;
}
.bp-row {
  display: flex;
  align-items: center;
  padding: var(--space-1) var(--space-2);
  font-size: var(--fs-meta-min, 11.5px);
}
.bp-row + .bp-row {
  border-top: 1px solid var(--border-default);
}
.bp-head {
  color: var(--text-dim);
  background: var(--bg-canvas);
}
.bp-cell {
  flex: 1;
  min-width: 0;
}
.bp-name {
  flex: 2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-body);
}
.bp-num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.bp-warn {
  color: var(--accent-yellow);
}
.bp-attention {
  color: var(--accent-yellow);
}
.bp-actions {
  margin-top: 6px;
}
</style>
