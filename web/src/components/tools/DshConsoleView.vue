<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NModal, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { confirmDialog } from '../../composables/useDialog'
import { useDshVersions } from '../../composables/useDshVersions'
import { settingsApi } from '../../api/client'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { safeStorage } from '../../utils/storage'
import DshConsoleToolbar from './dsh/DshConsoleToolbar.vue'
import DshConsoleBody from './dsh/DshConsoleBody.vue'
import DshTargetsModal from './dsh/DshTargetsModal.vue'
import DshVersionsModal from './dsh/DshVersionsModal.vue'
import type { DshTarget } from './dsh/types'

/**
 * dsh 控制台主区视图（P6）：iframe 嵌入本机 dsh（DeepSeek Harness）Web UI。
 *
 * - 嵌入通道：默认后端回环反代（结构性保证 iframe 可用——剥帧限制头 + 注入
 *   token，与 dsh 自身的帧策略无关）；iframe src 取自 /api/tools/dsh/url
 * - v-show 保活：切走再切回不重载，dsh 页面路由/输入原地保留
 * - dsh 未运行：状态探测 available=false → 显示引导空态 + 重试（业界惯例：
 *   端口面板式双兜底，「在新标签打开」始终可用）
 * - 主题：不做任何注入/滤镜——dsh 观感由用户在 dsh 设置里自选主题（浅色/
 *   深色/跟随系统），与 SC 主题解耦（SC 提供 DeepSeek Light/Dark 观感对齐
 *   主题可选，见 web/src/themes/dsh-*.ts）
 *
 * 区块拆分（P-20261001-20）：工具栏/嵌入体/目标管理/版本管理各自的渲染层
 * 在 ./dsh/ 子组件，本文件持有探测轮询、启动/重启、暴露开关与键盘等宿主逻辑。
 */
const props = withDefaults(defineProps<{ maximizable?: boolean }>(), { maximizable: true })
const { t } = useI18n()
const message = useMessage()
const layout = usePanelLayout()

// 最大化：仅独立视口（项目页主区）可最大化；首页浮层本就全屏无需
const maximized = computed(() => props.maximizable && layout.dshMaximized.value)
function toggleMaximized() {
  layout.dshMaximized.value = !layout.dshMaximized.value
}

const targetUrl = ref('')
const available = ref<boolean | null>(null) // null = 探测中
const latencyMs = ref<number | null>(null)
const iframeKey = ref(0)
const loading = ref(true)
/** 令牌状态（后端带令牌探测 dsh 首页判定）：unset=未配置 / stale=已失效
 *  （dsh 每次启动更换令牌）/ valid / unknown。失效时嵌入区上方出引导横幅，
 *  替代此前直接透传 dsh 英文鉴权页、无任何行动入口的体验 */
type DshTokenState = 'valid' | 'unset' | 'stale' | 'unknown' | ''
const tokenState = ref<DshTokenState>('')
const tokenNeedsAuth = computed(() => available.value === true && (tokenState.value === 'unset' || tokenState.value === 'stale'))

// ============== 多目标（本机 + 外部 dsh）与暴露策略 ==============
const targets = ref<DshTarget[]>([])
const activeTargetId = ref('') // '' = 本机默认目标
const exposeAll = ref(false) // 是否已开放所有 IP 访问（默认收紧：仅本系统内嵌可用）
const proxyDegraded = ref(false)
const proxyDegradedReason = ref('')
/** 配置指纹：开关/绑定面变更经 30s 轮询发现后自动重载（开关即时生效闭环） */
const lastConfigFp = ref('')
/** 反代对外协议（跟随主服务）。https 时自签证书需浏览器接受一次：
 * iframe 内不显示「继续前往」页，须先在新标签打开反代地址接受 */
const proxyScheme = ref('')
/** 反代已成功服务过请求 = 证书已被接受（证书被拒的请求到不了服务端） */
const tlsServedOnce = ref(true)
/** 手动关闭提示：按反代源记忆，不随会话丢失 */
const certHintDismissed = ref(false)

// https 反代的证书接受入口（targetUrl 的源，剥查询参数）
const certAcceptUrl = computed(() => {
  if (proxyScheme.value !== 'https' || !targetUrl.value) return ''
  try { return new URL(targetUrl.value).origin } catch { return '' }
})
const certHintDismissKey = computed(() => `dsh-cert-hint-dismissed:${certAcceptUrl.value}`)
const certHintVisible = computed(() =>
  proxyScheme.value === 'https' && !!certAcceptUrl.value && !tlsServedOnce.value && !certHintDismissed.value,
)
function dismissCertHint() {
  certHintDismissed.value = true
  safeStorage.setItem(certHintDismissKey.value, '1')
}

// 浏览器不在 SC 本机且未开放所有 IP → 回环代理地址对该浏览器不可达
const localOnly = computed(() => {
  const h = window.location.hostname
  const browserLoopback = ['127.0.0.1', '::1', 'localhost'].includes(h)
  return !browserLoopback && !exposeAll.value
})

const targetOptions = computed(() => [
  { label: t('dshConsole.localTarget'), value: '' },
  ...targets.value.map(tg => ({ label: tg.name, value: tg.id })),
])

function switchTarget(id: string) {
  if (id === activeTargetId.value) return
  activeTargetId.value = id
  void probeAndLoad()
}

/** 工具栏展示用地址：掩去 token 查询参数（凭据不上屏） */
const displayUrl = computed(() => targetUrl.value.replace(/([?&])token=[^&]*/, '$1token=…'))

let pollTimer: ReturnType<typeof setInterval> | null = null

let probeSeq = 0
async function probeAndLoad() {
  const seq = ++probeSeq
  loading.value = true
  try {
    const res = (await settingsApi.dshToolInfo(
      activeTargetId.value ? { target: activeTargetId.value } : undefined,
    )) as unknown as {
      data?: {
        url?: string
        available?: boolean
        exposeAll?: boolean
        degraded?: boolean
        degradedReason?: string
        tokenState?: DshTokenState
        proxyScheme?: string
        tlsServedOnce?: boolean
      }
    }
    if (seq !== probeSeq) return // 过期响应丢弃：快速切目标/并发刷新时不回写旧状态
    const d = res?.data || {}
    targetUrl.value = d.url || ''
    available.value = !!d.available
    tokenState.value = d.tokenState ?? ''
    exposeAll.value = !!d.exposeAll
    proxyDegraded.value = !!d.degraded
    proxyDegradedReason.value = d.degradedReason || ''
    proxyScheme.value = d.proxyScheme || 'http'
    if (d.tlsServedOnce !== undefined) tlsServedOnce.value = !!d.tlsServedOnce
    lastConfigFp.value = `${d.exposeAll}|${d.degraded}`
    iframeKey.value++ // 重载 iframe（保活场景下仅手动刷新/重试时触发）
    // iframe 实际加载完成由 @load 复位 loading；8s 超时兜底防白屏无反馈
    window.setTimeout(() => { if (seq === probeSeq) loading.value = false }, 8000)
  } catch {
    if (seq === probeSeq) available.value = false
  } finally {
    if (seq === probeSeq) loading.value = false
  }
}

// ============== 版本检查与升级（状态与逻辑在 useDshVersions，渲染在 DshVersionsModal） ==============
const versions = useDshVersions({ reload: probeAndLoad })

async function loadTargets() {
  try {
    const res = (await settingsApi.dshTargetsList()) as unknown as { data?: DshTarget[] }
    targets.value = res?.data || []
  } catch { /* 保持上次列表 */ }
}

const showTargetManager = ref(false)
function openTargetManager() {
  showTargetManager.value = true
  void loadTargets()
}

/** 目标管理弹窗删掉的是当前激活目标：回落本机目标并重新探测 */
function onActiveTargetRemoved() {
  activeTargetId.value = '' // 后端未知 ID 同语义
  void probeAndLoad()
}

// ============== 一键启动（后端拉起 dsh + 自动捕获 launch token 写回设置） ==============
const launching = ref(false)
const launchHint = ref('')

// 令牌失效/未配置横幅的恢复动作：重启 dsh 进程 → 重新捕获新令牌。
// 复用升级链路的 upgrade/restart（stopDsh 三路覆盖 + launchAndWait 捕获），
// 危险性（结束 dsh 进程、中断进行中任务）经确认弹窗显式告知
const restarting = ref(false)
async function restartDshForToken() {
  if (restarting.value) return
  const ok = await confirmDialog({
    title: t('dshConsole.restartTitle'),
    content: t('dshConsole.restartBody'),
    type: 'warning',
    confirmText: t('dshConsole.restartOk'),
  })
  if (!ok) return
  restarting.value = true
  launchHint.value = t('dshConsole.restarting')
  try {
    const res = await settingsApi.dshUpgradeRestart() as unknown as {
      data?: { available?: boolean; tokenCaptured?: boolean }
    }
    if (res?.data?.available) {
      launchHint.value = ''
    } else {
      launchHint.value = t('dshConsole.restartFailed')
    }
    await probeAndLoad()
    // 新令牌已捕获但探测仍报失效：上游端口被一个非本系统拉起的旧 dsh 占着
    // （stopDsh 按设计不杀未知来源进程）——给出可行动指引而非无限僵持
    if (res?.data?.tokenCaptured && tokenState.value !== 'valid') {
      launchHint.value = t('dshConsole.restartPortBusy')
    }
  } catch {
    launchHint.value = t('dshConsole.restartFailed')
  } finally {
    restarting.value = false
  }
}

async function launchDsh() {
  if (launching.value) return
  launching.value = true
  launchHint.value = t('dshConsole.launchingHint')
  try {
    const res = (await settingsApi.dshLaunch()) as unknown as {
      data?: { available?: boolean; spawned?: boolean; tokenCaptured?: boolean; logPath?: string; logTail?: string; ownHint?: string }
    }
    const d = res?.data
    if (d?.available) {
      // dsh 已在运行时一键启动是空操作（不重启、不换令牌）：如实告知，避免
      // 「点了启动鉴权页依旧」的困惑（令牌失效态横幅的常见路径）
      if (d.spawned === false && d.tokenCaptured === false) {
        launchHint.value = t('dshConsole.launchAlreadyRunning')
      } else {
        launchHint.value = ''
      }
      await probeAndLoad()
    } else {
      // 后端随响应回传启动日志尾部（命令不存在/端口冲突等直接可见，不必翻日志文件）
      const parts: string[] = []
      const reason = (d?.logTail || '').trim()
      if (reason) {
        parts.push(t('dshConsole.launchFailedReason', { reason, path: d?.logPath || '' }))
        // 命令不存在 → 给出安装/配置指引（新部署机器最常见的失败形态）
        if (/not found|No such file|command not found|不是内部或外部命令|无法将.*项识别/i.test(reason)) {
          parts.push(t('dshConsole.installHint'))
        }
      } else {
        parts.push(t('dshConsole.launchFailed', { path: d?.logPath || '' }))
      }
      const ownHint = (d?.ownHint || '').trim()
      if (ownHint) parts.push(ownHint) // 后端对 ~/.dsh 不可写等场景的可行动建议
      launchHint.value = parts.join('\n')
    }
  } catch {
    launchHint.value = t('dshConsole.launchNoCommand')
  } finally {
    launching.value = false
  }
}

function closeConsole() {
  layout.dshMaximized.value = false
  layout.showDshConsole.value = false
}

// ============== 新标签单独访问：需要开放所有 IP（脱离系统锁保护需显式同意） ==============
const showExposeDialog = ref(false)

function openInNewTab() {
  if (!targetUrl.value) return
  if (!exposeAll.value) {
    showExposeDialog.value = true
    return
  }
  window.open(targetUrl.value, '_blank', 'noopener')
}

/** 开放所有 IP 并打开：调设置接口即时重绑定监听，重取 URL 后开新标签 */
async function enableExposeAndOpen() {
  try {
    await settingsApi.update({ dshExposeAll: true })
    exposeAll.value = true
    await probeAndLoad()
    showExposeDialog.value = false
    if (targetUrl.value) window.open(targetUrl.value, '_blank', 'noopener')
  } catch { /* 拦截器统一处理 */ }
}

// ============== 本机 dsh 一键重启（安装插件/改配置后生效） ==============
// 复用 token 横幅的重启确认文案；完成后 probeAndLoad 重载 iframe 接管新进程
const processRestarting = ref(false)
async function restartDshProcess() {
  if (processRestarting.value) return
  // 单次询问（不静默执行）：点击后先弹确认告知后果，用户确认才重启
  const ok = await confirmDialog({
    title: t('dshConsole.restartTitle'),
    content: t('dshConsole.restartBody'),
    type: 'warning',
    confirmText: t('dshConsole.restartOk'),
  })
  if (!ok) return
  processRestarting.value = true
  try {
    const res = await settingsApi.dshRestart() as unknown as {
      data?: { available?: boolean; tokenCaptured?: boolean }
    }
    if (res?.data?.available) {
      message.success(t('dshConsole.restartDone'))
    } else {
      message.warning(t('dshConsole.restartFailed'))
    }
    await probeAndLoad()
  } catch { /* 拦截器统一处理 */ } finally {
    processRestarting.value = false
  }
}

// 「嵌入通道不可达」提示条的一键开放：开放后重载 iframe（不开新标签）
const exposing = ref(false)
async function enableExposeAndReload() {
  if (exposing.value) return
  exposing.value = true
  try {
    await settingsApi.update({ dshExposeAll: true })
    exposeAll.value = true
    await probeAndLoad()
  } catch { /* 拦截器统一处理 */ } finally {
    exposing.value = false
  }
}

function onIframeLoad() {
  loading.value = false
}

// ============== 键盘快捷键：Ctrl/Cmd+R、F5 刷新；Esc 关闭 ==============
// 视图经 v-show 保活（隐藏仍挂载），handler 常驻但仅在 dsh 为当前主区视图时生效；
// 弹窗打开时让位。焦点在 iframe 内部时按键不经过本文档（浏览器默认行为接管）
function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) return // Layout 级已消费的 Esc（如退出终端最大化）不重复处理
  if (!layout.showDshConsole.value) return
  if (hasBlockingOverlay()) return
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'r')) {
    e.preventDefault()
    void probeAndLoad()
    return
  }
  if (e.key === 'Escape') {
    if (maximized.value) {
      layout.dshMaximized.value = false // 最大化时 Esc 先还原，再按一次才关闭
      return
    }
    layout.showDshConsole.value = false
  }
}

onMounted(() => {
  try { certHintDismissed.value = localStorage.getItem(certHintDismissKey.value) === '1' } catch { /* 隐私模式等 */ }
  void probeAndLoad()
  void loadTargets()
  void versions.checkVersions() // 升级角标靠这条数据点亮：只在打开面板时查会先有鸡还是先有蛋
  document.addEventListener('keydown', onKeydown)
  // 轻量状态轮询（30s）：驱动头部状态点 + 配置指纹变化检测（暴露开关/绑定面
  // 在设置页变更后，此处发现即自动重载嵌入，开关即时生效的闭环）
  pollTimer = setInterval(async () => {
    try {
      const res = (await settingsApi.dshToolInfo(
        activeTargetId.value ? { target: activeTargetId.value } : undefined,
      )) as unknown as {
        data?: {
          available?: boolean
          exposeAll?: boolean
          degraded?: boolean
          tokenState?: DshTokenState
          proxyScheme?: string
          tlsServedOnce?: boolean
        }
      }
      const d = res?.data || {}
      available.value = !!d.available
      if (d.tokenState) tokenState.value = d.tokenState
      if (d.proxyScheme) proxyScheme.value = d.proxyScheme
      if (d.tlsServedOnce !== undefined) tlsServedOnce.value = !!d.tlsServedOnce
      const fp = `${d.exposeAll}|${d.degraded}`
      if (lastConfigFp.value && fp !== lastConfigFp.value) {
        void probeAndLoad() // 配置变了：重取 URL + 重载 iframe
      }
    } catch { /* 保持上次状态 */ }
  }, 30_000)
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    class="dsh-root"
    :class="{ 'dsh-maximized': maximized }"
  >
    <DshConsoleToolbar
      :display-url="displayUrl"
      :active-target-id="activeTargetId"
      :target-options="targetOptions"
      :available="available"
      :latency-ms="latencyMs"
      :upgrade-badge="versions.upgradeBadge.value"
      :header-version-label="versions.headerVersionLabel.value"
      :maximizable="maximizable"
      :maximized="maximized"
      :process-restarting="processRestarting"
      @switch-target="switchTarget"
      @open-target-manager="openTargetManager"
      @open-versions="versions.openVersions()"
      @restart-process="restartDshProcess"
      @refresh="probeAndLoad"
      @open-new-tab="openInNewTab"
      @toggle-maximized="toggleMaximized"
      @close="closeConsole"
    />

    <DshConsoleBody
      :local-only="localOnly"
      :exposing="exposing"
      :cert-hint-visible="certHintVisible"
      :cert-accept-url="certAcceptUrl"
      :proxy-degraded="proxyDegraded"
      :token-needs-auth="tokenNeedsAuth"
      :token-state="tokenState"
      :active-target-id="activeTargetId"
      :restarting="restarting"
      :launch-hint="launchHint"
      :target-url="targetUrl"
      :iframe-key="iframeKey"
      :loading="loading"
      :available="available"
      :launching="launching"
      @expose-and-reload="enableExposeAndReload"
      @dismiss-cert-hint="dismissCertHint"
      @restart-for-token="restartDshForToken"
      @refresh="probeAndLoad"
      @launch="launchDsh"
      @iframe-load="onIframeLoad"
    />

    <!-- 新标签单独访问引导：脱离系统锁保护需显式开放所有 IP（可随时关闭） -->
    <n-modal
      v-model:show="showExposeDialog"
      preset="dialog"
      :title="t('dshConsole.exposeRequiredTitle')"
      :positive-text="t('dshConsole.exposeEnableAndOpen')"
      :negative-text="t('common.cancel')"
      @positive-click="enableExposeAndOpen"
    >
      {{ t('dshConsole.exposeRequiredBody') }}
    </n-modal>

    <!-- 外部 dsh 目标管理面板：列表 + 添加/编辑表单（列表本体在宿主） -->
    <DshTargetsModal
      v-model:show="showTargetManager"
      :targets="targets"
      :active-target-id="activeTargetId"
      @changed="loadTargets"
      @active-removed="onActiveTargetRemoved"
    />

    <!-- 版本管理：检查更新 / 选择新版本升级 / 失败回退 -->
    <DshVersionsModal :ctrl="versions" />
  </div>
</template>

<style scoped>
.dsh-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  overflow: hidden;
}
/* 最大化：脱离文档流全屏覆盖（与首页浮层同层级；Esc 先还原再关闭） */
.dsh-root.dsh-maximized {
  position: fixed;
  inset: 0;
  z-index: 900;
  height: 100vh;
}
</style>
