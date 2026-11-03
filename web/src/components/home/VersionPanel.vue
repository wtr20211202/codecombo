<script setup lang="ts">
// 版本信息 + 检查更新 + 更新分发源的共享面板。
// 三处复用：项目页状态栏弹窗（Layout）、首页弹窗（HomeView）、设置关于页（SettingsModal）——
// 此前三处各自实现，功能不对齐（首页/关于缺检查更新与分发源配置）
import { ref, computed, onMounted } from 'vue'
import { useMessage, NTooltip, NIcon, NSwitch } from 'naive-ui'
import { shouldShowToast } from '../../utils/toastDedupe'
import { InformationCircleOutline } from '@vicons/ionicons5'
import { settingsApi, updateApi } from '../../api/client'
import { copyText } from '../../utils/clipboard'
import { useI18n } from '../../composables/useI18n'
import { useNotificationStore } from '../../stores/notification'

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

// ---- 检查更新（自包含轮询） ----
interface UpdateCheckResult {
  currentVersion: string
  latestVersion?: string
  hasUpdate: boolean
  changelog?: string
  downloadUrl?: string
  fileSize?: number
}
interface UpdateStatusResult {
  status: string
  progress: number
  total: number
  version: string
  error?: string
  result?: string
  resultError?: string
}

const updateInfo = ref<UpdateCheckResult | null>(null)
const updateStatus = ref<UpdateStatusResult | null>(null)
const updatePolling = ref(false)

// 后端 progress/total 是字节；进度条需要百分比（历史实现把字节直接当 % 宽度）
const updateProgressPercent = computed(() => {
  const p = updateStatus.value?.progress ?? 0
  const total = updateStatus.value?.total ?? 0
  if (p <= 0 || total <= 0) return 0
  return Math.min(100, Math.round((p / total) * 100))
})

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

async function checkUpdate() {
  try {
    const res = await updateApi.check()
    updateInfo.value = res.data || res
    if (updateInfo.value?.hasUpdate || updateInfo.value?.latestVersion) {
      const latest = updateInfo.value.latestVersion || ''
      emit('update-detected', latest)
      notificationStore.add({
        type: 'info',
        category: 'system',
        title: t('notification.event.updateAvailable'),
        body: latest ? `v${latest}` : undefined,
      })
    } else if (!updateSourceUrl.value) {
      // 无分发源时 hasUpdate:false 实为"无源可查"——不入状态机：
      // 若存入 updateInfo，面板会渲染「已是最新版本」，与提示自相矛盾
      updateInfo.value = null
      if (shouldShowToast('update.noSourceHint')) {
        message.warning(t('update.noSourceHint'))
      }
    }
  } catch {
    updateInfo.value = null
  }
}

function pollUpdateStatus() {
  let interval = 2000
  const maxInterval = 30000
  const terminalStatuses = ['success', 'failed', 'rolled_back']

  async function poll() {
    if (!updatePolling.value) return
    try {
      const res = await updateApi.status({ silent: true })
      updateStatus.value = res.data || res
      const status: string = updateStatus.value?.status || updateStatus.value?.result || ''
      if (terminalStatuses.includes(status)) {
        updatePolling.value = false
        if (status === 'success') {
          message.success(t('update.success'))
          notificationStore.add({ type: 'success', category: 'system', title: t('notification.event.updateCompleted') })
        } else if (status === 'rolled_back') {
          message.warning(t('update.rolledBack'))
          notificationStore.add({ type: 'warning', category: 'system', title: t('notification.event.updateFailed'), body: t('update.rolledBack') })
        } else {
          message.error(t('update.failed'))
          notificationStore.add({ type: 'error', category: 'system', title: t('notification.event.updateFailed') })
        }
        return
      }
      interval = Math.min(interval * 1.5, maxInterval)
      setTimeout(poll, interval)
    } catch {
      if (updatePolling.value) setTimeout(poll, interval)
    }
  }
  void poll()
}

async function startUpdate() {
  try {
    await updateApi.apply()
    updatePolling.value = true
    updateStatus.value = null
    // 接入通知中心：与"从中心更新"同语义——更新启动即留档，
    // 用户关掉本面板后仍能从通知中心获知进展入口
    notificationStore.add({ type: 'info', category: 'system', title: t('update.updateStarted') })
    pollUpdateStatus()
  } catch { /* 拦截器处理 */ }
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

async function loadUpdateSource() {
  try {
    const res = await settingsApi.get({ silent: true })
    const data = res.data as { updateURL?: string; updateChecks?: boolean; updateChannel?: string } | undefined
    updateSourceUrl.value = data?.updateURL || ''
    updateChecks.value = data?.updateChecks !== false
    updatePrerelease.value = data?.updateChannel === 'prerelease'
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

async function saveUpdateChecks(v: boolean) {
  updateChecksSaving.value = true
  try {
    await settingsApi.update({ updateChecks: v })
    message.success(t('update.autoCheckSaved'))
  } catch {
    // 失败回滚开关展示态（拦截器已出错误提示）
    loadUpdateSource()
  } finally {
    updateChecksSaving.value = false
  }
}

async function saveUpdatePrerelease(v: boolean) {
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

onMounted(() => { void loadUpdateSource() })
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
        <div
          v-if="updateInfo.changelog"
          class="version-changelog"
        >
          <span class="version-label">{{ t('update.changelog') }}</span>
          <span class="version-value prewrap">{{ updateInfo.changelog }}</span>
        </div>
        <button
          v-if="!updatePolling"
          class="panel-btn primary"
          @click="startUpdate"
        >
          {{ t('update.updateNow') }}
        </button>
      </div>
      <div
        v-else-if="updateInfo && !updateInfo.hasUpdate"
        class="version-update-info"
      >
        <span class="muted">{{ t('update.alreadyLatest') }}</span>
      </div>
      <div
        v-if="updatePolling || (updateStatus && ['success','failed','rolled_back'].includes(updateStatus.status || updateStatus.result || ''))"
        class="version-update-progress"
      >
        <div class="version-row">
          <span class="version-label">{{ t('update.status') }}</span>
          <span class="version-value">{{ updateStatus?.status ? t('update.' + updateStatus.status) : t('update.updating') }}</span>
        </div>
        <div
          v-if="updateProgressPercent > 0"
          class="version-progress-bar"
        >
          <div
            class="version-progress-fill"
            :style="{ width: updateProgressPercent + '%' }"
          />
        </div>
        <div
          v-if="updateProgressPercent > 0"
          class="version-row"
        >
          <span class="version-value muted">{{ updateProgressPercent }}%（{{ formatBytes(updateStatus?.progress ?? 0) }} / {{ formatBytes(updateStatus?.total ?? 0) }}）</span>
        </div>
      </div>
      <!-- 检查更新按钮：未检查过或无更新时始终可再查——检查后按钮消失会导致
           刚配置分发源等场景下无法重新检查 -->
      <button
        v-if="!updatePolling && (!updateInfo || !updateInfo.hasUpdate)"
        class="panel-btn"
        @click="checkUpdate"
      >
        {{ updateInfo ? t('update.recheck') : t('update.checkUpdate') }}
      </button>
    </div>

    <!-- 自动检查更新：24h 定时检查 + 新版本推通知（P-20261103-1）。
         更新源自带官方默认，这里只露开关——不联网检查的用户在此关闭 -->
    <div class="version-source-section">
      <div class="version-row">
        <span class="version-label">{{ t('update.autoCheckLabel') }}</span>
        <n-switch
          size="small"
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
.version-changelog { display: flex; flex-direction: column; gap: 4px; }
.version-update-progress { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.version-progress-bar { width: 100%; height: 4px; background: var(--border-default); border-radius: 2px; overflow: hidden; }
.version-progress-fill { height: 100%; background: var(--accent-blue); border-radius: 2px; transition: width 0.3s ease; }
.panel-btn {
  width: 100%; padding: 8px 0; border: 1px solid var(--border-default); border-radius: 6px;
  background: transparent; color: var(--text-secondary); font-size: 13px; cursor: pointer;
  transition: all var(--motion-base); margin-top: 10px;
}
.panel-btn:hover { border-color: var(--accent-blue); color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 8%, transparent); }
.panel-btn.primary { background: var(--accent-blue); border-color: var(--accent-blue); color: var(--bg-primary); font-weight: 600; }
.panel-btn.primary:hover { opacity: 0.85; background: var(--accent-blue); color: var(--bg-primary); }
.panel-btn.inline { width: auto; padding: 7px 16px; margin-top: 0; flex-shrink: 0; }
.version-source-section { display: flex; flex-direction: column; gap: 6px; padding: 14px 20px 20px; }
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
