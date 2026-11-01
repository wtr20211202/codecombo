<template>
  <!-- 全屏锁定遮罩：固定定位 + 高 z-index 盖住整个应用。
       :duration 显式钉过渡时长（P-20261011-1 ①同款防御）：transitionend
       丢失（低帧率/事件节流环境）时 Vue 走 setTimeout 兜底 resolve -->
  <Transition
    name="lock-fade"
    :duration="300"
  >
    <div
      v-if="shown"
      class="lock-overlay"
    >
      <Transition
        name="lock-card"
        appear
      >
        <div class="lock-card">
          <!-- 顶部 Logo（锁图标） -->
          <div class="lock-logo">
            <NIcon size="48">
              <LockClosedOutline />
            </NIcon>
          </div>
          <h2 class="lock-title">
            {{ isSetup ? t('lock.overlay.setupTitle') : t('lock.overlay.title') }}
          </h2>
          <p class="lock-subtitle">
            {{ isSetup ? t('lock.overlay.setupSubtitle') : t('lock.overlay.subtitle') }}
          </p>

          <!-- HTTP 明文访问警示（P-20261002-30）：密码输入第一现场同步提示——
               即将提交的解锁密码若经明文 HTTP 过线可被同网段嗅探。与顶栏警示条
               共享 useHttpWarning 的同一份「不再提示」记忆，dismiss 后两处同隐 -->
          <p
            v-if="httpWarningVisible"
            class="lock-http-hint"
            data-testid="lock-http-hint"
          >
            <NIcon size="14">
              <WarningOutline />
            </NIcon>
            <span>{{ t('conn.http.message') }}</span>
          </p>

          <!-- 密码输入 + 解锁/设密按钮 -->
          <form
            class="lock-form"
            @submit.prevent="isSetup ? handleSetup() : handleUnlock()"
          >
            <!-- 主路径：type=text + text-security 圆点——浏览器不认为是密码框，
                 既不会自动填充、也不会弹"保存密码"提示（new-password 会邀请保存，不能用） -->
            <NInput
              v-if="supportsTextSecurity"
              ref="passwordInput"
              v-model:value="password"
              class="pw-field"
              :class="{ 'pw-plain': showPwd }"
              size="large"
              :input-props="{ autocomplete: 'off' }"
              :placeholder="t('lock.overlay.passwordPlaceholder')"
              :status="error ? 'error' : undefined"
              :disabled="loading"
              :autofocus="true"
              @update:value="error = ''"
              @keyup.enter="isSetup ? handleSetup() : handleUnlock()"
            >
              <template #suffix>
                <button
                  type="button"
                  class="pw-eye"
                  tabindex="-1"
                  :title="t('lock.overlay.togglePasswordShow')"
                  :aria-label="t('lock.overlay.togglePasswordShow')"
                  @click="showPwd = !showPwd"
                >
                  <NIcon size="16">
                    <EyeOffOutline v-if="showPwd" />
                    <EyeOutline v-else />
                  </NIcon>
                </button>
              </template>
            </NInput>
            <!-- Firefox 不支持 -webkit-text-security，回退真密码框 -->
            <NInput
              v-else
              ref="passwordInput"
              v-model:value="password"
              type="password"
              size="large"
              show-password-on="click"
              :input-props="{ autocomplete: 'off' }"
              :placeholder="t('lock.overlay.passwordPlaceholder')"
              :status="error ? 'error' : undefined"
              :disabled="loading"
              :autofocus="true"
              @update:value="error = ''"
              @keyup.enter="isSetup ? handleSetup() : handleUnlock()"
            />

            <!-- 设密模式：确认密码（同样的双变体输入） -->
            <template v-if="isSetup">
              <NInput
                v-if="supportsTextSecurity"
                v-model:value="confirmPassword"
                class="pw-field"
                :class="{ 'pw-plain': showPwd }"
                size="large"
                :input-props="{ autocomplete: 'off' }"
                :placeholder="t('lock.overlay.confirmPasswordPlaceholder')"
                :status="error ? 'error' : undefined"
                :disabled="loading"
                @update:value="error = ''"
                @keyup.enter="handleSetup()"
              />
              <NInput
                v-else
                v-model:value="confirmPassword"
                type="password"
                size="large"
                show-password-on="click"
                :input-props="{ autocomplete: 'off' }"
                :placeholder="t('lock.overlay.confirmPasswordPlaceholder')"
                :status="error ? 'error' : undefined"
                :disabled="loading"
                @update:value="error = ''"
                @keyup.enter="handleSetup()"
              />
            </template>

            <!-- 错误提示：fade 过渡 -->
            <Transition name="lock-error">
              <div
                v-if="error"
                class="lock-error"
              >
                <NIcon size="14">
                  <WarningOutline />
                </NIcon>
                <span>{{ error }}</span>
              </div>
            </Transition>

            <NButton
              type="primary"
              size="large"
              block
              attr-type="submit"
              :loading="loading"
              :disabled="!password || (isSetup && !confirmPassword)"
            >
              {{ isSetup ? t('lock.overlay.setupBtn') : t('lock.overlay.unlockBtn') }}
            </NButton>
          </form>

          <!-- 连续输错 ≥3 次渐显找回路径提示：reset-lock 是物理机/SSH 操作，
               localhost 与远程访问语义一致，知道命令不构成攻击面增益 -->
          <Transition name="lock-recovery">
            <p
              v-if="showRecoveryHint"
              class="lock-recovery-hint"
              data-testid="lock-recovery-hint"
            >
              {{ t('lock.recovery.hint') }}
            </p>
          </Transition>

          <!-- 首启设密 + 服务绑定通配地址：明确告知可从局域网任意机器经 IP 完成 -->
          <p
            v-if="isSetup && lanSetupAllowed"
            class="lock-lan-hint"
          >
            {{ t('lock.overlay.lanSetupHint') }}
          </p>

          <!-- 限流提示 -->
          <p class="lock-hint">
            {{ isSetup ? t('lock.overlay.setupRateLimitedHint') : t('lock.overlay.rateLimitedHint') }}
          </p>
        </div>
      </Transition>
    </div>
  </Transition>

  <!-- 默认密码提示下点"立即修改"打开的设置弹窗：放在 Transition 外，避免 v-if 卸载影响 -->
  <SettingsModal
    :show="showSettings"
    :initial-tab="'security'"
    @update:show="(v: boolean) => (showSettings = v)"
    @saved="showSettings = false"
  />
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NInput, NButton, NIcon, useDialog } from 'naive-ui'
import {
  LockClosedOutline,
  WarningOutline,
  EyeOutline,
  EyeOffOutline,
} from '@vicons/ionicons5'
import { useLockStore } from '@/stores/lock'
import { useHttpWarning } from '@/composables/useHttpWarning'
import { useOverlayDwell } from '@/composables/useOverlayDwell'
import { AppError } from '@/api/error-types'
import SettingsModal from '@/components/settings/SettingsModal.vue'

const { t } = useI18n()
const dialog = useDialog()
const lockStore = useLockStore()
// HTTP 明文警示（P-20261002-30）：与顶栏警示条共享同一份检测/记忆
const { visible: httpWarningVisible } = useHttpWarning()

const password = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const passwordInput = ref<InstanceType<typeof NInput> | null>(null)
// 明文/圆点切换（text-security 方案下的自绘眼睛按钮）
const showPwd = ref(false)
// Chromium/Safari 支持 -webkit-text-security，Firefox 不支持
const supportsTextSecurity = typeof CSS !== 'undefined' && CSS.supports('-webkit-text-security', 'disc')
// 默认密码"立即修改"按钮打开的设置弹窗
const showSettings = ref(false)

// 找回路径提示：解锁连续失败达阈值才渐显（首错不打扰，只救真被锁死的
// 人）；计数仅前端会话内，重锁归零，与服务端限流（10 次/分钟）无耦合
const UNLOCK_FAIL_HINT_THRESHOLD = 3
const unlockFailCount = ref(0)
const showRecoveryHint = computed(() => unlockFailCount.value >= UNLOCK_FAIL_HINT_THRESHOLD)

// 首次安装/被 reset-lock：锁屏进入设密模式而非解锁
const isSetup = computed(() => lockStore.needsSetup)
// 服务绑定通配地址时首启设密允许局域网来源（state 由后端 /api/lock/state 下发）
const lanSetupAllowed = computed(() => !!lockStore.state?.lanSetupAllowed && lockStore.needsSetup)

// 可见性跟随 store.isLocked，且必须在 checkStatus 完成后（isReady）才显示
// boot 阶段（isReady=false）不渲染遮罩，避免刷新时与启动 loading 同时出现
const visible = computed(() => lockStore.isLocked && lockStore.isReady)

// 显隐源加最小驻留去抖（P-20261011-1 ②）：锁态偶发振荡（解锁成功瞬间迟到
// 的 WS 4001 关闭帧经 applyLockRejection 把 isLocked 拉回 true）会让全屏遮罩
// 高频进出闪现。重进静默窗的隐私边界：遮罩淡入本身 300ms，静默窗延迟 ≤300ms
// 落在同一视觉包络内，不引入新的暴露等级
const shown = useOverlayDwell(visible, {
  hideDelayMs: 150,
  reenterDelayMs: 300,
})

// 默认密码提醒：解锁成功后仅当 isDefaultPassword=true 弹一次
let defaultPasswordPrompted = false

// 解锁后焦点归还触发元素：锁定瞬间的 document.activeElement（多为编辑器/
// 输入框）在遮罩卸载后焦点落回 body，键盘用户需重新 Tab 定位——镜像
// SettingsModal 的归还模式，连接性校验后还焦
let focusBeforeLock: HTMLElement | null = null

// 焦点管理跟随 shown（去抖后的实际在场）：进入即捕焦点/清表单，离开归还——
// 时序与直连 visible 时一致（进入恒即时），仅离开侧多一次 150ms 缓冲延迟
watch(shown, async (v) => {
  if (v) {
    focusBeforeLock = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 进入锁定页：清状态 + 自动聚焦
    password.value = ''
    confirmPassword.value = ''
    error.value = ''
    defaultPasswordPrompted = false
    // 失败计数按锁定会话计：重锁后重新累计
    unlockFailCount.value = 0
    await nextTick()
    passwordInput.value?.focus()
  } else if (focusBeforeLock) {
    await nextTick()
    if (focusBeforeLock.isConnected) focusBeforeLock.focus()
    focusBeforeLock = null
  }
})

async function handleUnlock() {
  if (!password.value || loading.value) return
  loading.value = true
  error.value = ''
  try {
    await lockStore.unlock(password.value)
    // 解锁成功：若使用默认密码则弹提醒
    if (lockStore.isDefaultPassword && !defaultPasswordPrompted) {
      defaultPasswordPrompted = true
      promptDefaultPassword()
    }
    password.value = ''
  } catch (e) {
    const err = e as AppError
    if (err.status === 429) {
      error.value = t('lock.overlay.rateLimited')
    } else if (err.status === 401 || err.category === 'auth') {
      // 密码错误才累计失败：网络/限流非用户过错，不推进提示阈值
      unlockFailCount.value++
      error.value = t('lock.overlay.wrongPassword')
    } else if (err.category === 'network') {
      error.value = t('lock.overlay.networkError')
    } else {
      // AppError 一定带 userMessage（拦截器产出）；message 兜底仅防本地 throw
      error.value = (err as { userMessage?: string }).userMessage || t('lock.overlay.networkError')
    }
  } finally {
    loading.value = false
  }
}

// 首次设置密码：两端一致后提交，成功后后端直接签发 token 进入已解锁态
async function handleSetup() {
  if (!password.value || loading.value) return
  if (confirmPassword.value !== password.value) {
    error.value = t('lock.overlay.passwordMismatch')
    return
  }
  loading.value = true
  error.value = ''
  try {
    await lockStore.setup(password.value)
    password.value = ''
    confirmPassword.value = ''
  } catch (e) {
    const err = e as AppError
    if (err.status === 429) {
      error.value = t('lock.overlay.rateLimited')
    } else if (err.category === 'network') {
      error.value = t('lock.overlay.networkError')
    } else {
      // 409（已被其他端初始化）/ 400 等：提示重试，刷新后走正常解锁流程
      error.value = (err as { userMessage?: string }).userMessage || t('lock.overlay.setupFailed')
    }
  } finally {
    loading.value = false
  }
}

function promptDefaultPassword() {
  dialog.warning({
    title: t('lock.reminder.defaultPasswordTitle'),
    content: t('lock.reminder.defaultPasswordWarning'),
    positiveText: t('lock.reminder.changeNow'),
    negativeText: t('lock.reminder.remindLater'),
    onPositiveClick: () => {
      // 实际打开 SettingsModal 并定位到 security tab（之前只 message.info 不跳转）
      showSettings.value = true
    },
  })
}
</script>

<style scoped>
/* 全屏遮罩 */
.lock-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--lock-overlay-bg);
  /* 只写标准属性：手写 -webkit- 双份会被 lightningcss 去重成仅剩 -webkit-，
     而新版 Chromium 已移除该别名 → 构建产物锁屏失焦（背景内容可读，防窥
     失效）。目标前缀由构建按 browserslist 自动补齐（同 .n-modal-mask 形态） */
  backdrop-filter: blur(20px) saturate(120%);
}

/* 中心卡片 */
.lock-card {
  width: 380px;
  max-width: calc(100vw - 32px);
  padding: 40px 32px 28px;
  background: var(--lock-card-bg);
  border: 1px solid var(--lock-card-border);
  border-radius: 12px;
  /* 全屏遮罩单例投影：唯一一处不入弹层阶梯（0 12px 40px 0.3 的几何在
     pop-lg/xl 之间，收敛任一档都会显著改变全屏锁的视觉重量，保留并定性） */
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* Logo / 标题 / 副标题 */
.lock-logo {
  color: var(--lock-logo-color);
  margin-bottom: 16px;
}
.lock-title {
  margin: 0 0 6px;
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  text-align: center;
}
.lock-subtitle {
  margin: 0 0 24px;
  font-size: 14px;
  color: var(--text-secondary);
  text-align: center;
}

/* 表单 */
.lock-form {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* text-security 圆点掩码：渲染效果与密码框一致。
   状态 class 放在 NInput 根元素上（input-props.class 不响应状态变化），
   经 :deep 穿透到内部 input */
.lock-form :deep(.pw-field input) {
  -webkit-text-security: disc;
}
.lock-form :deep(.pw-field.pw-plain input) {
  -webkit-text-security: none;
}

/* 自绘眼睛按钮 */
.pw-eye {
  border: none;
  background: transparent;
  color: var(--text-tertiary, var(--text-secondary));
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  align-items: center;
}
.pw-eye:hover {
  color: var(--text-primary);
}

/* 错误提示 */
.lock-error {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--lock-error-color);
  font-size: 13px;
  padding: 4px 0;
}

/* 底部限流提示 */
.lock-hint {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--text-tertiary, var(--text-secondary));
  text-align: center;
}
.lock-lan-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--accent-green);
  text-align: center;
}

/* HTTP 明文警示（P-20261002-30）：warning 色级（与顶栏警示条同语义），
   置于副标题与密码框之间——输入密码前第一眼可见 */
.lock-http-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 10px 0 0;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--accent-yellow-warm);
  background: var(--bg-warning);
  border: 1px solid var(--bg-warning-alt);
  border-radius: 6px;
  text-align: center;
}

/* 找回路径提示：text-muted 色级（非引导色），失败触发式渐显 */
.lock-recovery-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-tertiary, var(--text-secondary));
  text-align: center;
}

/* 找回提示淡入淡出 */
.lock-recovery-enter-active,
.lock-recovery-leave-active {
  transition: opacity 0.4s ease;
}
.lock-recovery-enter-from,
.lock-recovery-leave-to {
  opacity: 0;
}

/* 遮罩 fade；离场 pointer-events:none（P-20261011-1 ②）：离场余韵不拦截
   交互，低帧率环境下过渡挂起的残留遮罩不再吞全页点击 */
.lock-fade-enter-active,
.lock-fade-leave-active {
  transition: opacity 0.3s ease;
}
.lock-fade-leave-active {
  pointer-events: none;
}
.lock-fade-enter-from,
.lock-fade-leave-to {
  opacity: 0;
}

/* 串流/触屏环境淡入淡出减半（P-20261011-1 ③，App.vue 全局规则同款机制）：
   全屏遮罩与中心卡片两段主要过渡收半；表单内微过渡（error/recovery 提示）
   量级本就极小，不在堆积面上，保持不动 */
@media (pointer: coarse) {
  .lock-fade-enter-active,
  .lock-fade-leave-active { transition-duration: 0.15s; }
  .lock-card-enter-active { transition-duration: 0.2s; }
}

/* 卡片缩放 + 上浮 */
.lock-card-enter-active {
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.4s ease;
}
.lock-card-enter-from {
  transform: translateY(20px) scale(0.95);
  opacity: 0;
}

/* 错误提示淡入淡出 */
.lock-error-enter-active,
.lock-error-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.lock-error-enter-from,
.lock-error-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 尊重 prefers-reduced-motion */
@media (prefers-reduced-motion: reduce) {
  .lock-fade-enter-active,
  .lock-fade-leave-active,
  .lock-card-enter-active,
  .lock-error-enter-active,
  .lock-error-leave-active,
  .lock-recovery-enter-active,
  .lock-recovery-leave-active {
    transition-duration: 0.01ms !important;
  }
}
</style>
