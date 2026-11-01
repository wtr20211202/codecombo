<script setup lang="ts">
// OAuth Device Flow 登录弹窗：展示 user_code + 倒计时 + 浏览器授权 + 后台轮询
// 启动时机：watch show=true → 调 oauthApi.start 拿 device_code/user_code/verification_uri/expires_in/interval
// 关闭/卸载：必须清理 poll timer + countdown timer，避免内存泄漏
import { ref, watch, computed, onUnmounted } from 'vue'
import { NModal, NButton, NSpace, NSpin, NAlert, NProgress } from 'naive-ui'
import { oauthApi, type OAuthStartResp } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { copyText } from '../../utils/clipboard'
import { useMessage } from 'naive-ui'

const props = defineProps<{
  show: boolean
  platform: 'github' | 'gitea'
  host: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  success: [credentialId: string, oldId?: string]
}>()

const { t } = useI18n()
const message = useMessage()

// flow：Device Flow 启动响应；null 表示尚未启动或在加载
const flow = ref<OAuthStartResp | null>(null)
// error：启动失败时展示给用户
const error = ref('')
// lastStatus：最近一次 poll 返回的状态，用于在 UI 区分 expired / denied 文案
const lastStatus = ref<'pending' | 'ok' | 'expired' | 'denied'>('pending')
// remainingSeconds：剩余有效时间（秒），countdown 每秒递减
const remainingSeconds = ref(0)

// 进度条：基于 expires_in / remainingSeconds 计算
const progressPercent = computed(() => {
  if (!flow.value) return 0
  const total = flow.value.expires_in
  if (total <= 0) return 0
  const elapsed = total - remainingSeconds.value
  return Math.min(100, Math.max(0, (elapsed / total) * 100))
})

// 定时器句柄：组件卸载或 show=false 必须清理
let pollTimer: ReturnType<typeof setInterval> | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null
// 当前轮询间隔（秒），用于检测服务端 slow_down 调整
let currentInterval = 5

// show=true 启动流程；show=false 仅清理（保留 flow，避免关闭瞬间 UI 闪烁）
watch(
  () => props.show,
  async (newShow) => {
    if (newShow) {
      await startFlow()
    } else {
      cleanup()
    }
  },
)

// 启动 Device Flow：重置状态 → 调 oauthApi.start → 启动 countdown + poll
async function startFlow() {
  // 重置状态
  flow.value = null
  error.value = ''
  lastStatus.value = 'pending'
  remainingSeconds.value = 0

  try {
    // Axios 拦截器已 unwrap response.data，这里直接拿 OAuthStartResp
    const res: any = await oauthApi.start({
      platform: props.platform,
      host: props.host,
    })
    flow.value = res as OAuthStartResp
    remainingSeconds.value = flow.value.expires_in
    currentInterval = flow.value.interval || 5
    startCountdown()
    startPolling(currentInterval)
  } catch (e: any) {
    // 启动失败：展示友好文案，不进入轮询（原文在 Console/错误面板）
    error.value = e?.userMessage || t('errors.unknown')
  }
}

// 启动倒计时：每秒减一，归零时切到 expired 状态
function startCountdown() {
  countdownTimer = setInterval(() => {
    if (remainingSeconds.value > 0) {
      remainingSeconds.value--
    } else {
      lastStatus.value = 'expired'
      cleanup()
    }
  }, 1000)
}

// 启动轮询：按 interval 秒调 oauthApi.poll
function startPolling(intervalSec: number) {
  pollTimer = setInterval(async () => {
    if (!flow.value) return
    try {
      const res: any = await oauthApi.poll(
        props.platform,
        props.host,
        flow.value.device_code,
      )
      const data = res as {
        status: 'pending' | 'ok' | 'expired' | 'denied'
        credential_id?: string
        interval?: number
      }

      if (data.status === 'ok' && data.credential_id) {
        lastStatus.value = 'ok'
        emit('success', data.credential_id)
        cleanup()
      } else if (data.status === 'expired') {
        lastStatus.value = 'expired'
        cleanup()
      } else if (data.status === 'denied') {
        lastStatus.value = 'denied'
        cleanup()
      }
      // pending：继续轮询；若服务端调整 interval（slow_down），重启 poll timer
      if (data.interval && data.interval !== currentInterval) {
        currentInterval = data.interval
        restartPolling(currentInterval)
      }
    } catch {
      // 网络错误：保留 timer 继续重试，不弹消息（避免噪声）
    }
  }, intervalSec * 1000)
}

// 用新 interval 重启 poll timer
function restartPolling(intervalSec: number) {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  startPolling(intervalSec)
}

// 清理所有定时器
function cleanup() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

// 关闭弹窗：先清理再 emit update:show=false
function close() {
  cleanup()
  emit('update:show', false)
}

// NModal update:show 回调：仅处理关闭动作
function onShowChange(v: boolean) {
  if (!v) close()
}

// 复制 user_code 到剪贴板
async function copyUserCode() {
  if (!flow.value) return
  const ok = await copyText(flow.value.user_code)
  if (ok) {
    message.success(t('common.copied'))
  } else {
    // 复制失败（如非 HTTPS 上下文）——用户要手动抄码，必须提示
    message.warning(flow.value.user_code)
  }
}

// 组件卸载：兜底清理（防止 watch 未触发 close 时泄漏）
onUnmounted(cleanup)
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    style="width: var(--modal-w-sm); max-width: 94vw"
    :title="t('credential.oauth.title')"
    @update:show="onShowChange"
  >
    <!-- 加载态：startFlow 进行中 -->
    <div
      v-if="!flow && !error"
      class="oauth-loading"
    >
      <NSpin />
    </div>

    <!-- 启动失败 -->
    <div
      v-else-if="error"
      class="oauth-error"
    >
      <NAlert
        type="error"
        :title="t('credential.oauth.startFailed')"
        :show-icon="true"
      >
        {{ error }}
      </NAlert>
    </div>

    <!-- 正常流程：展示 user_code + 授权按钮 + 倒计时 -->
    <div
      v-else
      class="oauth-flow"
    >
      <p class="oauth-step">
        {{ t('credential.oauth.step1') }}
      </p>

      <div class="oauth-user-code">
        <span class="oauth-code">{{ flow!.user_code }}</span>
        <NButton
          size="small"
          quaternary
          @click="copyUserCode"
        >
          {{ t('common.copy') }}
        </NButton>
      </div>

      <NButton
        type="primary"
        block
        tag="a"
        :href="flow!.verification_uri"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ t('credential.oauth.openBrowser') }}
      </NButton>

      <p class="oauth-step oauth-polling">
        {{ t('credential.oauth.polling', { seconds: remainingSeconds }) }}
      </p>
      <NProgress
        type="line"
        :percentage="progressPercent"
        :show-indicator="false"
        :height="6"
      />

      <!-- 终态提示 -->
      <p
        v-if="lastStatus === 'denied'"
        class="oauth-error-msg"
      >
        {{ t('credential.lastError.access_denied') }}
      </p>
      <p
        v-else-if="lastStatus === 'expired'"
        class="oauth-error-msg"
      >
        {{ t('credential.lastError.expired_token') }}
      </p>
    </div>

    <template #action>
      <NSpace justify="end">
        <NButton @click="close">
          {{ t('common.cancel') }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.oauth-loading {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 120px;
}

.oauth-error {
  padding: var(--space-1) 0;
}

.oauth-flow {
  padding: var(--space-1) 0;
}

.oauth-step {
  margin: 0 0 var(--space-3) 0;
  color: var(--text-primary);
}

.oauth-polling {
  margin-top: var(--space-4);
}

.oauth-user-code {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-4) 0;
}

.oauth-user-code .oauth-code {
  font-family: var(--font-mono, monospace);
  font-size: 28px;
  font-weight: var(--fw-semibold);
  letter-spacing: 4px;
  color: var(--text-primary);
}

.oauth-error-msg {
  margin-top: var(--space-3);
  color: var(--error-color, #d03050);
}
</style>
