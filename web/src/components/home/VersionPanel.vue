<script setup lang="ts">
// 版本信息 + 检查更新 + 更新分发源的共享面板。
// 三处复用：项目页状态栏弹窗（Layout）、首页弹窗（HomeView）、设置关于页（SettingsModal）——
// 此前三处各自实现，功能不对齐（首页/关于缺检查更新与分发源配置）
import { ref, computed, onMounted } from 'vue'
import { useMessage, NTooltip, NIcon, NSwitch } from 'naive-ui'
import { shouldShowToast } from '../../utils/toastDedupe'
import { InformationCircleOutline, LogoGithub, CheckmarkCircleOutline } from '@vicons/ionicons5'
import UpdateProgressBlock from './UpdateProgressBlock.vue'
import UpdateCompanionWarning from './UpdateCompanionWarning.vue'
import { settingsApi, updateApi } from '../../api/client'
import { copyText } from '../../utils/clipboard'
import { confirmDialog } from '../../composables/useDialog'
import { useI18n } from '../../composables/useI18n'
import { useNotificationStore } from '../../stores/notification'
import { useUpdateProgressStore } from '../../stores/updateProgress'
import { useUpdateCheckStore } from '../../stores/updateCheck'
import type { UpdateProxyStatusPayload } from '../../api/domains/system'

export interface VersionBuildInfo {
  version: string
  commit: string
  buildTime: string
  goVersion: string
  platform: string
}

const props = defineProps<{ buildInfo: VersionBuildInfo | null }>()
// 检测到可用更新时通知外层（项目页状态栏版本号绿点高亮）
const emit = defineEmits<{ (e: 'update-detected', latest: string): void }>()

const message = useMessage()
const { t } = useI18n()
const notificationStore = useNotificationStore()
// 自更新进度（P-20261109-10）：轮询上移全局 store，面板与 App 层徽标同源消费
const progress = useUpdateProgressStore()
// 前端自动检查电路（P-20261109-6）：「自动检查更新」开关保存成功即同帧起停表
const updateCheckStore = useUpdateCheckStore()

async function copyCommitId() {
  if (props.buildInfo?.commit) {
    if (await copyText(props.buildInfo.commit)) {
      message.success(t('settings.copied'))
    } else {
      message.error(t('common.copyFailed'))
    }
  }
}

// dev 构建无注入元数据：unknown 显示为 —（中文界面下混排英文单词观感突兀）
function metaValue(v: string): string {
  return v === 'unknown' ? '—' : v
}

// ---- 检查更新 ----
interface UpdateCheckResult {
  currentVersion: string
  latestVersion?: string
  hasUpdate: boolean
  changelog?: string
  downloadUrl?: string
  fileSize?: number
  // 检查失败分类（P-20261106 beta.2 误报实锚）：后端不再吞错，前端据标志诚实呈现
  channelEmpty?: boolean
  sourceMissing?: boolean
  checkError?: string
  // 伴随校验资产拉取失败旗标（P-20261109-9）：有更新但此刻更新必被校验拒绝
  //（后端与 ApplyUpdate 同源判定，只在真会被拒时置位）——面板即时提示，
  // 「立即更新」保持可点（点击后端会 skipCache 重拉一次）
  companionFetchFailed?: boolean
  companionFetchError?: string
}

const updateInfo = ref<UpdateCheckResult | null>(null)
// 检查中态：请求期禁用按钮 + 文案切换（GitHub API 1~3s 内给即时反馈，顺带防连点并发）
const checking = ref(false)

// 已是最新态的回显版本：统一取「当前版本」而非 latest——hasUpdate=false 含
// 「当前高于最新」形态（dev 构建领先官方 tag），回显 latest 会写出
// 「已是最新 v<更旧版本>」的自相矛盾文案
const upToDateVersion = computed(() => updateInfo.value?.currentVersion || props.buildInfo?.version || '')

// 「立即更新」可点：无在途更新且本会话未刚更新成功（成功后本页仍是旧版本的
// 检查结果，再点必 400「已是最新」）
const canStartUpdate = computed(() => !progress.inFlight && progress.outcome?.phase !== 'success')

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

async function checkUpdate(opts?: { manual?: boolean }) {
  if (checking.value) return
  checking.value = true
  try {
    const res = await updateApi.check()
    updateInfo.value = res.data || res
    const info = updateInfo.value
    if (info?.hasUpdate) {
      // 判断只认后端 hasUpdate（semver 对比）——旧「latest !== current」字符串
      // 兜底会把「当前高于最新」形态误判成有新版，造成通知绿点说有新版、
      // 面板说已是最新的矛盾面
      const latest = info.latestVersion || ''
      emit('update-detected', latest)
      notificationStore.add({
        type: 'info',
        category: 'system',
        title: t('notification.event.updateAvailable'),
        body: latest ? `v${latest}` : undefined,
      })
    } else if (info?.channelEmpty) {
      // stable 通道无正式版（GitHub 正式通道恒排预发布）——不入状态机：
      // 若存入 updateInfo，面板会渲染「已是最新版本」，与提示自相矛盾
      updateInfo.value = null
      if (shouldShowToast('update.channelEmptyHint')) {
        message.info(t('update.channelEmptyHint'))
      }
    } else if (info?.sourceMissing) {
      // 自更新源已内置官方仓库；真缺源仅剩「配置的非法分发源被 Init 拒绝」一途
      updateInfo.value = null
      if (shouldShowToast('update.sourceMissingHint')) {
        message.warning(t('update.sourceMissingHint'))
      }
    } else if (info?.checkError) {
      // 其余检查失败（网络/DNS/限流）如实呈现，不再吞成「未配置源」
      updateInfo.value = null
      if (shouldShowToast('update.checkFailedHint')) {
        message.warning(t('update.checkFailedHint', { reason: info.checkError }))
      }
    } else if (opts?.manual && shouldShowToast('update.alreadyLatest')) {
      // 已是最新：手动路径显式挂 manual 标记才出 toast（shouldShowToast 5s 窗
      // 防多入口叠加），不依赖「按钮恰是唯一调用方」的巧合；自动检查
      // （前端 6h / 服务端 24h）已是最新 = 零 toast 零通知守住不打扰现状
      message.success(t('update.alreadyLatest'))
    }
    // else（非手动路径已是最新 / 手动但处 5s 去重窗内）：updateInfo 留存，
    // 面板照常渲染「已是最新」成功块——面板态是主反馈，toast 只是一次性补充
  } catch {
    updateInfo.value = null
  } finally {
    checking.value = false
  }
}

// 发起更新：受理/跟踪/失败推断全在 updateProgress store（P-20261109-10）——
// 服务端异步受理即 202，进度由 store 轮询，开始/失败/完成通知服务端单一发射；
// 受理结论未知（超时/断网）或跨标签 409 由 store 探实况接管，不再「前端报
// 失败、服务端在换包」全盲。明确拒绝（已是最新/npm 形态/伴随校验资产重拉后仍
// 未取到等）由本面板自出反馈（见 catch）
//
// applying = 受理请求在途：伴随资产拉取失败时服务端先 skipCache 重拉再裁决受理
//（P-20261109-9，受理前同步段，失败路径最长约 20s）——期间按钮禁用并切文案，
// 给出即时反馈、防连点并发（同 checking 守卫）
const applying = ref(false)

async function startUpdate() {
  if (applying.value) return
  applying.value = true
  try {
    // silent：被拒反馈由面板自出。拦截器的错误 toast 只在项目页外壳注入 message
    // API 后才有（useErrorDisplayInit），首页/设置入口被拒时原本零反馈——伴随
    // 资产重拉仍失败的真实原因就送不到用户眼前（P-20261109-9）。面板自出则三入口
    // 一致且不与拦截器双弹；错误中心入账不受 silent 影响
    await progress.start(updateInfo.value?.latestVersion || '', { silent: true })
  } catch (e) {
    // 文案取拦截器已算好的本地化 userMessage（KNOWN_ERROR_I18N：伴随资产拉取失败
    // 带逐资产原因、npm 形态更新指引等），兜底通用失败；原因可能较长，悬停保活
    const userMessage = (e as { userMessage?: string } | null)?.userMessage
    message.error(userMessage || t('update.failed'), { duration: 8000, keepAliveOnHover: true })
    // 被拒后静默同步告警块：服务端受理前已 skipCache 重拉并刷新缓存——伴随失败
    // 原因随之更新（或首次在受理时才暴露），恢复则告警消失
    void syncCompanionState()
  } finally {
    applying.value = false
  }
}

// 面板告警块同步：只更新仍有更新的检查结果，不走 checkUpdate——那条会重复发
// 「发现新版本」通知；失败静默保留上次状态（toast 已如实报过）
async function syncCompanionState() {
  try {
    const res = await updateApi.check({ silent: true })
    const info: UpdateCheckResult | undefined = res.data || res
    if (info?.hasUpdate) updateInfo.value = info
  } catch { /* 静默 */ }
}

// ---- 本机优雅重启（P-20261106 页面重启链）：真正需要重启的少数设置
//（监听器类）与人工兜底，页面一键完成无须进服务管理器 ----
const restarting = ref(false)

async function restartApp() {
  const ok = await confirmDialog({
    title: t('update.restartApp'),
    content: t('update.restartConfirm'),
    type: 'warning',
  })
  if (!ok) return
  restarting.value = true
  try {
    await updateApi.restart()
  } catch {
    message.error(t('update.restartFailed'))
    restarting.value = false
    return
  }
  message.info(t('update.restartStarted'))
  // 轮询健康回归（监听短暂离线后回来，30s 上限）
  const deadline = Date.now() + 30000
  const poll = window.setInterval(async () => {
    try {
      await updateApi.healthPing({ timeout: 2000, silent: true })
      window.clearInterval(poll)
      restarting.value = false
      message.success(t('update.restartDone'))
    } catch {
      if (Date.now() > deadline) {
        window.clearInterval(poll)
        restarting.value = false
        message.warning(t('update.restartTimeout'))
      }
    }
  }, 2000)
}

// ---- 自动检查更新 + 更新分发源 ----
// 自更新源已内置官方仓库（P-20261103-1 零配置），面板只露自动检查开关；
// 分发源字段重定界为中心分发（跨平台子实例缓存转发），自更新不再消费它
const updateSourceUrl = ref('')
const updateSourceSaving = ref(false)
const updateChecks = ref(true)
const updateChecksSaving = ref(false)
const updatePrerelease = ref(false)
const updatePrereleaseSaving = ref(false)
// 更新链出站代理（P-20261109-12）：公司代理/本地 clash 两类 CN 网络场景，
// 显式配置优先于环境变量；保存即热化（服务端重装出站状态与更新源）
const updateProxy = ref('')
const updateProxySaving = ref(false)
// 系统代理自动探测开关（P-20261110-1 S6）：默认关（存量零变化）；显式与 env 都
// 未给出代理时更新链改用探测到的系统代理。保存走既有设置保存链（服务端装配点
// 同步探测一次），失败按服务端真值回滚
const updateProxyAutoDetect = ref(false)
const updateProxyAutoDetectSaving = ref(false)
// 当前生效档位（P-20261110-1 S6）：读 proxy-status（服务端与实际选路同源裁决，
// 地址已脱敏）。端点失败静默降级为不展示，不阻断面板其余功能
const proxyStatus = ref<UpdateProxyStatusPayload | null>(null)

async function loadProxyStatus() {
  try {
    const res = await updateApi.proxyStatus({ silent: true })
    proxyStatus.value = (res as unknown as { data?: UpdateProxyStatusPayload })?.data || null
  } catch {
    proxyStatus.value = null
  }
}

// 档位文案 + 脱敏地址（direct 档无地址只显档位名）
const proxyTierText = computed(() => {
  const s = proxyStatus.value
  if (!s) return ''
  const keys: Record<string, string> = {
    explicit: 'update.proxyTierExplicit',
    env: 'update.proxyTierEnv',
    sysdetect: 'update.proxyTierSysdetect',
    direct: 'update.proxyTierDirect',
  }
  const label = t(keys[s.tier] || 'update.proxyTierDirect')
  return s.proxy ? `${label} · ${s.proxy}` : label
})

async function loadUpdateSource() {
  try {
    const res = await settingsApi.get({ silent: true })
    const data = res.data as { updateURL?: string; updateChecks?: boolean; updateChannel?: string; updateProxy?: string; updateProxyAutoDetect?: boolean } | undefined
    updateSourceUrl.value = data?.updateURL || ''
    updateChecks.value = data?.updateChecks !== false
    updatePrerelease.value = data?.updateChannel === 'prerelease'
    updateProxy.value = data?.updateProxy || ''
    updateProxyAutoDetect.value = data?.updateProxyAutoDetect === true
  } catch { /* silent */ }
}

async function saveUpdateSource() {
  const v = updateSourceUrl.value.trim()
  if (v && !/^https?:\/\//.test(v)) {
    message.error(t('update.sourceUrlInvalid'))
    return
  }
  updateSourceSaving.value = true
  try {
    await settingsApi.update({ updateURL: v })
    message.success(t('update.sourceUrlSaved'))
  } catch { /* 拦截器处理 */ } finally {
    updateSourceSaving.value = false
  }
}

// 开关乐观翻转（P-20261109-6 顺带修复）：n-switch 以 :value 受控，不回写展示态
// 则保存成功后开关仍停在旧位（再点一次又提交同一值，界面上关不掉也开不回）；
// 失败经 loadUpdateSource 按服务端真值回滚
async function saveUpdateChecks(v: boolean) {
  updateChecks.value = v
  updateChecksSaving.value = true
  try {
    await settingsApi.update({ updateChecks: v })
    // 前端 6h 自动检查电路同帧跟随：关即停表（零自动检查请求），开即按冷启动
    // 节律重新起表——不等 settings.changed 广播往返（他端/他标签页走广播重读）
    updateCheckStore.applyAutoCheckSetting(v)
    message.success(t('update.autoCheckSaved'))
  } catch {
    // 失败回滚开关展示态（拦截器已出错误提示）
    loadUpdateSource()
  } finally {
    updateChecksSaving.value = false
  }
}

async function saveUpdatePrerelease(v: boolean) {
  updatePrerelease.value = v
  updatePrereleaseSaving.value = true
  try {
    await settingsApi.update({ updateChannel: v ? 'prerelease' : 'stable' })
    message.success(t('update.prereleaseSaved'))
  } catch {
    loadUpdateSource()
  } finally {
    updatePrereleaseSaving.value = false
  }
}

async function saveUpdateProxy() {
  const v = updateProxy.value.trim()
  // 客户端早反馈只挡明显错拼；权威校验在服务端（http/https/socks5/socks5h + 补端口）
  if (v && !/^(https?|socks5h?):\/\//.test(v)) {
    message.error(t('update.proxyInvalid'))
    return
  }
  updateProxySaving.value = true
  try {
    await settingsApi.update({ updateProxy: v })
    message.success(t('update.proxySaved'))
    // 出站态保存即热化（服务端装配点重装配+探测）：档位展示跟随刷新
    void loadProxyStatus()
  } catch {
    // 失败回滚输入框展示态（拦截器已出错误提示）
    loadUpdateSource()
  } finally {
    updateProxySaving.value = false
  }
}

// 自动探测开关（P-20261110-1 S6）：保存即生效（服务端 ApplySource 单点重装配 +
// 探测一次），档位展示跟随；失败按服务端真值回滚展示态（saveUpdateChecks 同款）
async function saveUpdateAutoDetect(v: boolean) {
  updateProxyAutoDetect.value = v
  updateProxyAutoDetectSaving.value = true
  try {
    await settingsApi.update({ updateProxyAutoDetect: v })
    message.success(t('update.proxyAutoDetectSaved'))
    void loadProxyStatus()
  } catch {
    loadUpdateSource()
  } finally {
    updateProxyAutoDetectSaving.value = false
  }
}

// 挂载即同步一次更新实况：服务端在途（他页/CLI 发起、或 F5 后）即接管轮询
onMounted(() => {
  void loadUpdateSource()
  void loadProxyStatus()
  void progress.sync()
})
</script>

<template>
  <div
    v-if="buildInfo"
    class="version-panel"
  >
    <div class="version-divider">
      <span class="version-badge">v{{ buildInfo.version }}</span>
    </div>
    <div class="version-details">
      <div
        v-if="buildInfo.commit !== 'none'"
        class="version-row"
      >
        <span class="version-label">{{ t('settings.commitId') }}</span>
        <code
          class="version-commit"
          :title="t('settings.copied')"
          @click="copyCommitId"
        >{{ buildInfo.commit.substring(0, 7) }}</code>
      </div>
      <div class="version-row">
        <span class="version-label">{{ t('settings.buildTime') }}</span>
        <span class="version-value">{{ metaValue(buildInfo.buildTime) }}</span>
      </div>
      <div class="version-row">
        <span class="version-label">{{ t('settings.runtime') }}</span>
        <span class="version-value">{{ buildInfo.goVersion }} {{ buildInfo.platform }}</span>
      </div>
    </div>

    <!-- 检查更新 -->
    <div class="version-update-section">
      <div class="section-divider" />
      <div
        v-if="updateInfo?.hasUpdate"
        class="version-update-info"
      >
        <div class="version-row">
          <span class="version-label">{{ t('update.latestVersion') }}</span>
          <span class="version-value highlight">v{{ updateInfo.latestVersion }}</span>
        </div>
        <div
          v-if="updateInfo.fileSize"
          class="version-row"
        >
          <span class="version-label">{{ t('update.downloadSize') }}</span>
          <span class="version-value">{{ formatBytes(updateInfo.fileSize) }}</span>
        </div>
        <!-- 更新说明限高滚动（P-20261109-10 R11）：双语长 changelog 整段渲染曾把
             「立即更新」顶到数屏之外——限高内滚，操作区始终首屏可达 -->
        <div
          v-if="updateInfo.changelog"
          class="version-changelog"
        >
          <span class="version-label">{{ t('update.changelog') }}</span>
          <div
            class="version-changelog-body"
            data-testid="version-changelog-body"
            tabindex="0"
          >
            <span class="version-value prewrap">{{ updateInfo.changelog }}</span>
          </div>
        </div>
        <!-- 伴随校验资产未取到（P-20261109-9）：按钮保持可点（点后服务端受理前先
             skipCache 重拉）；与「立即更新」同显隐——更新在途/本会话已更新成功时
             隐藏（能被受理说明重拉已成功，留着即自相矛盾） -->
        <UpdateCompanionWarning
          v-if="updateInfo.companionFetchFailed && canStartUpdate"
          :reason="updateInfo.companionFetchError"
        />
        <button
          v-if="canStartUpdate"
          class="panel-btn primary"
          data-testid="version-update-now"
          :disabled="applying"
          @click="startUpdate"
        >
          {{ applying ? t('update.updating') : t('update.updateNow') }}
        </button>
      </div>
      <!-- 已是最新成功块：与 hasUpdate 块同构的显著终态（对勾 + 正文色 + 版本号）。
           此前单行 .muted 灰字与下方静态说明文字同形，被读成「没有任何反馈」 -->
      <div
        v-else-if="updateInfo && !updateInfo.hasUpdate"
        class="version-update-info"
      >
        <div class="version-uptodate">
          <n-icon
            size="16"
            class="version-uptodate-icon"
          >
            <CheckmarkCircleOutline />
          </n-icon>
          <span
            v-if="upToDateVersion"
            class="version-uptodate-text"
          >{{ t('update.alreadyLatestWithVersion', { version: upToDateVersion }) }}</span>
          <span
            v-else
            class="version-uptodate-text"
          >{{ t('update.alreadyLatest') }}</span>
        </div>
      </div>
      <!-- 更新进度/结局（P-20261109-10）：数据在全局 updateProgress store，面板
           只是消费方之一（App 层徽标同源）——关面板/切路由/F5 后重开照常恢复 -->
      <UpdateProgressBlock />
      <!-- 检查更新按钮：未检查过或无更新时始终可再查——检查后按钮消失会导致
           刚配置分发源等场景下无法重新检查；checking 期禁用（防连点并发） -->
      <button
        v-if="!progress.inFlight && (!updateInfo || !updateInfo.hasUpdate)"
        class="panel-btn"
        :disabled="checking"
        @click="checkUpdate({ manual: true })"
      >
        {{ checking ? t('update.checking') : (updateInfo ? t('update.recheck') : t('update.checkUpdate')) }}
      </button>
      <!-- 本机优雅重启（P-20261106）：页面一键完成，无须进服务管理器 -->
      <button
        class="panel-btn"
        :disabled="restarting"
        @click="restartApp"
      >
        {{ restarting ? t('update.restarting') : t('update.restartApp') }}
      </button>
    </div>

    <!-- 自动检查更新：24h 定时检查 + 新版本推通知（P-20261103-1）。
         更新源自带官方默认，这里只露开关——不联网检查的用户在此关闭；
         一个开关同时门控服务端 24h 定时器与前端 6h 自动检查电路（P-20261109-6） -->
    <div class="version-source-section">
      <div class="version-row">
        <span class="version-label">{{ t('update.autoCheckLabel') }}</span>
        <n-switch
          size="small"
          data-testid="version-autocheck-switch"
          :value="updateChecks"
          :disabled="updateChecksSaving"
          @update:value="saveUpdateChecks"
        />
      </div>
      <div class="version-row">
        <span class="version-value muted">{{ t('update.autoCheckHint') }}</span>
      </div>
      <!-- 预发布通道（P-20261103-3）：开启后检查口径含 beta/rc -->
      <div class="version-row">
        <span class="version-label">{{ t('update.prereleaseLabel') }}</span>
        <n-switch
          size="small"
          :value="updatePrerelease"
          :disabled="updatePrereleaseSaving"
          @update:value="saveUpdatePrerelease"
        />
      </div>
      <div class="version-row">
        <span class="version-value muted">{{ t('update.prereleaseHint') }}</span>
      </div>
      <!-- 更新链出站代理（P-20261109-12）：公司代理/本地 clash 场景，检查与
           下载全走代理；留空 = 环境变量（HTTPS_PROXY）感知。placeholder 只放
           短示例（长文案输入框显示不全），完整说明收进 ⓘ 悬浮提示 -->
      <div class="version-row">
        <span class="version-label">{{ t('update.proxyLabel') }}</span>
        <!-- z-index 需高于宿主弹窗 overlay（9999），否则 tooltip 被遮住 -->
        <n-tooltip
          trigger="hover"
          placement="top-start"
          :z-index="10000"
          :style="{ maxWidth: '320px' }"
        >
          <template #trigger>
            <n-icon
              size="13"
              class="version-info-icon"
            >
              <InformationCircleOutline />
            </n-icon>
          </template>
          <div class="version-tooltip-body">
            {{ t('update.proxyHint') }}
          </div>
        </n-tooltip>
      </div>
      <div class="version-source-row">
        <input
          v-model="updateProxy"
          class="version-source-input"
          :placeholder="t('update.proxyPlaceholder')"
          spellcheck="false"
        >
        <button
          class="panel-btn inline"
          :disabled="updateProxySaving"
          @click="saveUpdateProxy"
        >
          {{ updateProxySaving ? t('common.saving') : t('common.save') }}
        </button>
      </div>
      <div class="version-row">
        <span class="version-value muted">{{ t('update.proxyHintShort') }}</span>
      </div>
      <!-- 系统代理自动探测开关（P-20261110-1 S6）：显式与 env 都未给出代理时，
           更新链改用探测到的桌面系统代理；保存即生效（服务端装配点同步探测） -->
      <div class="version-row">
        <span class="version-label">{{ t('update.proxyAutoDetectLabel') }}</span>
        <n-switch
          size="small"
          data-testid="version-proxy-autodetect-switch"
          :value="updateProxyAutoDetect"
          :disabled="updateProxyAutoDetectSaving"
          @update:value="saveUpdateAutoDetect"
        />
      </div>
      <div class="version-row">
        <span class="version-value muted">{{ t('update.proxyAutoDetectHint') }}</span>
      </div>
      <!-- 当前生效档位（P-20261110-1 S6）：读 proxy-status（与实际选路同源裁决，
           地址已脱敏）；端点失败静默降级为不展示，不阻断面板其余功能 -->
      <div
        v-if="proxyStatus"
        class="version-row"
        data-testid="version-proxy-tier"
      >
        <span class="version-label">{{ t('update.proxyTierLabel') }}</span>
        <span class="version-value">{{ proxyTierText }}</span>
      </div>
    </div>

    <!-- 更新分发源：本机作为中心时，跨平台子实例从该地址缓存转发二进制。
         自更新源已内置官方仓库，此字段只服务中心分发语义。
         placeholder 只放短示例（长文案在输入框里显示不全），完整说明收进 ⓘ 悬浮提示 -->
    <div class="version-source-section">
      <div class="version-row">
        <span class="version-label">{{ t('update.sourceUrlLabel') }}</span>
        <!-- z-index 需高于宿主弹窗 overlay（9999），否则 tooltip 被遮住在
             首页/项目页弹窗内不可见（设置关于页在 n-modal 内不受影响） -->
        <n-tooltip
          trigger="hover"
          placement="top-start"
          :z-index="10000"
          :style="{ maxWidth: '320px' }"
        >
          <template #trigger>
            <n-icon
              size="13"
              class="version-info-icon"
            >
              <InformationCircleOutline />
            </n-icon>
          </template>
          <div class="version-tooltip-body">
            {{ t('update.sourceUrlHint') }}
          </div>
        </n-tooltip>
      </div>
      <div class="version-source-row">
        <input
          v-model="updateSourceUrl"
          class="version-source-input"
          :placeholder="t('update.sourceUrlPlaceholder')"
          spellcheck="false"
        >
        <button
          class="panel-btn inline"
          :disabled="updateSourceSaving"
          @click="saveUpdateSource"
        >
          {{ updateSourceSaving ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </div>

    <!-- 开源仓库 Star 引导（P-20261103-4）：版本面板是用户与产品身份交互的
         自然位置，低调单行不做弹窗/不打扰；打开步骤之后收尾 -->
    <div class="version-star-section">
      <n-icon
        size="14"
        class="version-star-icon"
      >
        <LogoGithub />
      </n-icon>
      <span class="version-star-text">{{ t('update.starText') }}</span>
      <a
        class="version-star-link"
        href="https://github.com/wtr20211202/codecombo"
        target="_blank"
        rel="noopener"
      >{{ t('update.starAction') }}</a>
    </div>
  </div>
</template>

<style scoped>
.version-panel { display: flex; flex-direction: column; }
.version-divider { display: flex; justify-content: center; padding: 14px 0 10px; }
.version-badge {
  font-size: 20px; font-weight: 700; color: var(--accent-blue);
  background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
  padding: 4px 14px; border-radius: 6px;
}
.version-details { display: flex; flex-direction: column; gap: 8px; padding: 0 20px; }
.version-row { display: flex; align-items: baseline; gap: 10px; font-size: 13px; }
.version-label { color: var(--text-dim); flex-shrink: 0; min-width: 64px; }
.version-value { color: var(--text-primary); word-break: break-all; }
.version-value.highlight { color: var(--accent-green); font-weight: 600; }
.version-value.prewrap { white-space: pre-wrap; }
.version-commit {
  font-family: var(--font-mono, monospace); font-size: 12px; color: var(--accent-blue);
  background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
  padding: 2px 8px; border-radius: 4px; cursor: pointer;
}
.version-commit:hover { background: color-mix(in srgb, var(--accent-blue) 16%, transparent); }
.muted { font-size: 12px; color: var(--text-dim); }
.version-update-section { padding: 0 20px; }
.section-divider { height: 1px; background: var(--border-default); margin: 14px 0 12px; }
.version-update-info { display: flex; flex-direction: column; gap: 10px; }
/* 已是最新成功块：图标走状态语义色（--status-success），文字走正文色——
   均为语义名（色彩红线），对比度由六主题既有色对守（check-theme-contrast） */
.version-uptodate { display: flex; align-items: center; gap: 8px; }
.version-uptodate-icon { color: var(--status-success); flex-shrink: 0; }
.version-uptodate-text { color: var(--text-primary); font-size: 13px; font-weight: 600; }
.version-changelog { display: flex; flex-direction: column; gap: 4px; }
/* 更新说明限高内滚（R11）：~8 行可见，超出滚动；描边示意可滚区域 */
.version-changelog-body {
  max-height: 160px; overflow-y: auto;
  padding: 6px 8px; border: 1px solid var(--border-default); border-radius: 6px;
  background: var(--bg-primary);
}
.version-changelog-body:focus-visible { outline: 1px solid var(--accent-blue); }
.panel-btn {
  width: 100%; padding: 8px 0; border: 1px solid var(--border-default); border-radius: 6px;
  background: transparent; color: var(--text-secondary); font-size: 13px; cursor: pointer;
  transition: all var(--motion-base); margin-top: 10px;
}
.panel-btn:hover { border-color: var(--accent-blue); color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 8%, transparent); }
/* 禁用态（检查中/重启中）：压低存在感并中和 hover 反馈，避免「看着能点」 */
.panel-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.panel-btn:disabled:hover { border-color: var(--border-default); color: var(--text-secondary); background: transparent; }
.panel-btn.primary { background: var(--accent-blue); border-color: var(--accent-blue); color: var(--bg-primary); font-weight: 600; }
.panel-btn.primary:hover { opacity: 0.85; background: var(--accent-blue); color: var(--bg-primary); }
/* 主按钮禁用（apply 在途）：压过上面同权重的 primary:hover，悬停不再被抬回 0.85 */
.panel-btn.primary:disabled, .panel-btn.primary:disabled:hover { opacity: 0.6; cursor: not-allowed; background: var(--accent-blue); border-color: var(--accent-blue); color: var(--bg-primary); }
.panel-btn.inline { width: auto; padding: 7px 16px; margin-top: 0; flex-shrink: 0; }
.version-source-section { display: flex; flex-direction: column; gap: 6px; padding: 14px 20px 20px; }
.version-star-section {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 20px 16px; margin-top: 2px;
  border-top: 1px solid var(--border-default);
  font-size: 12.5px;
}
.version-star-icon { color: var(--text-dim); flex-shrink: 0; }
.version-star-text { color: var(--text-dim); }
.version-star-link { color: var(--accent-blue); text-decoration: none; flex-shrink: 0; }
.version-star-link:hover { text-decoration: underline; }
.version-source-row { display: flex; gap: 8px; }
.version-source-input {
  flex: 1; padding: 7px 10px; border: 1px solid var(--border-default); border-radius: 6px;
  background: var(--bg-primary); color: var(--text-primary); font-size: 12px; outline: none;
}
.version-source-input:focus { border-color: var(--accent-blue); }
.version-info-icon {
  color: var(--text-dim); cursor: pointer; flex-shrink: 0; position: relative; top: 1px;
}
.version-info-icon:hover { color: var(--accent-blue); }
</style>
