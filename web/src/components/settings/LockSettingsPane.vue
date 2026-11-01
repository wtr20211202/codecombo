<script setup lang="ts">
// 全局锁定设置 Tab（自 SecuritySettings 按区块拆出，P-20261002-27）：
// 锁定开关/自动锁定/Token TTL + 修改密码 + 立即锁定 + 锁定快捷键绑定。
// 逻辑在 useSecurityLock（配置读写/改密/立即锁定），本组件持有快捷键捕获交互。
// 快捷键捕获监听挂在 document 上（capture phase）：pane 以 display-directive="show"
// 常驻挂载，监听生命周期与拆分前（容器挂载期注册）一致。
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { NAlert, NButton, NInput, NInputNumber, NSwitch } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useSecurityLock } from '../../composables/useSecurityLock'
import { eventToShortcut } from '../../utils/shortcut'
import SettingModifiedMark from './SettingModifiedMark.vue'

const props = defineProps<{ show: boolean }>()

const { t } = useI18n()

// 行级「已修改」标记（P-20261003-171，P-20261006-49 分区补全）的出厂默认：
// 镜像服务端 store/lock.go DefaultConfig（enabled/autoLock 双开、时长双 120 分钟）
// 与 useSecurityLock lockConfig 初始 reactive 同口径。锁定族默认全是「开」——
// 恢复默认把已关闭的防护重新打开（升高防护），tooltip 注明方向；恢复只复位
// pending 值，仍走本区块「保存」链（configDirty → 保存按钮）落盘
const LOCK_DEFAULTS = { enabled: true, autoLockEnabled: true, autoLockMinutes: 120, tokenTTLMinutes: 120 } as const
const RESET_TITLE_RAISE = 'settings.resetRowToDefaultRaise'

// === 全局锁定配置（逻辑抽离到 composable） ===
const {
  lockStore, lockConfig, pwdForm,
  configDirty, pwdMismatch, canChangePassword,
  loadLockConfig, onToggleEnabled, saveConfig, changePassword, lockNow,
} = useSecurityLock()

// === 锁定快捷键绑定状态 ===
// capturing=true 时进入捕获模式：监听下次按键组合作为新值
const capturing = ref(false)

// 格式化展示：'ctrl+shift+l' → 'Ctrl + Shift + L'
function formatShortcut(combo: string): string {
  if (!combo) return t('lock.settings.shortcutCleared')
  return combo
    .split('+')
    .map(part => {
      switch (part) {
        case 'ctrl': return 'Ctrl'
        case 'shift': return 'Shift'
        case 'alt': return 'Alt'
        case 'meta': return navigator.platform?.toLowerCase().includes('mac') ? 'Cmd' : 'Meta'
        default: return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
      }
    })
    .join(' + ')
}

// 进入捕获模式
function startRebind() {
  capturing.value = true
}

// Esc 取消捕获；其他组合写入新值
function handleShortcutCapture(e: KeyboardEvent) {
  if (!capturing.value) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    capturing.value = false
    return
  }
  const combo = eventToShortcut(e)
  if (combo) {
    lockStore.setLockShortcut(combo)
    capturing.value = false
  }
  // 无效组合（如单独 modifier）继续等待
}

function resetShortcut() {
  lockStore.resetLockShortcut()
  capturing.value = false
}

function clearShortcut() {
  lockStore.setLockShortcut('')
  capturing.value = false
}

onMounted(() => {
  if (props.show) loadLockConfig()
  document.addEventListener('keydown', handleShortcutCapture, true)
})
watch(() => props.show, (val) => {
  if (val) loadLockConfig()
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleShortcutCapture, true)
})
</script>

<template>
  <div class="tab-section">
    <!-- 全局锁定功能：开关 + 自动锁定 + Token TTL -->
    <h4 class="section-title">
      {{ t('lock.settings.section') }}
    </h4>
    <div class="lock-section">
      <n-alert
        v-if="lockStore.isDefaultPassword"
        type="warning"
        :show-icon="true"
        style="margin-bottom: 8px"
      >
        {{ t('lock.reminder.defaultPasswordWarning') }}
      </n-alert>
      <div class="cred-row">
        <span>{{ t('lock.settings.enableLock') }}</span>
        <div class="cred-row-end">
          <n-switch
            :value="lockConfig.enabled"
            @update:value="onToggleEnabled"
          />
          <SettingModifiedMark
            :modified="lockConfig.enabled !== LOCK_DEFAULTS.enabled"
            :restore-title="t(RESET_TITLE_RAISE)"
            @restore="lockConfig.enabled = LOCK_DEFAULTS.enabled"
          />
        </div>
      </div>
      <div
        class="cred-row"
        data-testid="settings-lock-autolock"
        :title="!lockConfig.enabled ? t('lock.settings.requiresLock') : undefined"
      >
        <span>{{ t('lock.settings.enableAutoLock') }}</span>
        <div class="cred-row-end">
          <n-switch
            v-model:value="lockConfig.autoLockEnabled"
            :disabled="!lockConfig.enabled"
          />
          <SettingModifiedMark
            :modified="lockConfig.autoLockEnabled !== LOCK_DEFAULTS.autoLockEnabled"
            :restore-title="t(RESET_TITLE_RAISE)"
            @restore="lockConfig.autoLockEnabled = LOCK_DEFAULTS.autoLockEnabled"
          />
        </div>
      </div>
      <div
        class="cred-row"
        :title="!lockConfig.enabled || !lockConfig.autoLockEnabled ? t('lock.settings.requiresLock') : undefined"
      >
        <span>{{ t('lock.settings.autoLockMinutes') }}</span>
        <div class="cred-row-end">
          <n-input-number
            v-model:value="lockConfig.autoLockMinutes"
            :disabled="!lockConfig.enabled || !lockConfig.autoLockEnabled"
            :min="1"
            :max="1440"
            size="small"
            style="width: 120px"
          />
          <SettingModifiedMark
            :modified="lockConfig.autoLockMinutes !== LOCK_DEFAULTS.autoLockMinutes"
            @restore="lockConfig.autoLockMinutes = LOCK_DEFAULTS.autoLockMinutes"
          />
        </div>
      </div>
      <div
        class="cred-row"
        :title="!lockConfig.enabled ? t('lock.settings.requiresLock') : undefined"
      >
        <span>{{ t('lock.settings.tokenTTLMinutes') }}</span>
        <div class="cred-row-end">
          <n-input-number
            v-model:value="lockConfig.tokenTTLMinutes"
            :disabled="!lockConfig.enabled"
            :min="1"
            :max="1440"
            size="small"
            style="width: 120px"
          />
          <SettingModifiedMark
            :modified="lockConfig.tokenTTLMinutes !== LOCK_DEFAULTS.tokenTTLMinutes"
            @restore="lockConfig.tokenTTLMinutes = LOCK_DEFAULTS.tokenTTLMinutes"
          />
        </div>
      </div>
      <n-button
        size="small"
        type="primary"
        :disabled="!configDirty"
        @click="saveConfig"
      >
        {{ t('common.save') }}
      </n-button>
    </div>

    <!-- 修改密码：当前/新/确认三段输入 -->
    <h4 class="section-title">
      {{ t('lock.settings.changePassword') }}
    </h4>
    <div class="lock-section">
      <n-input
        v-model:value="pwdForm.current"
        type="password"
        show-password-on="click"
        size="small"
        :placeholder="t('lock.settings.currentPassword')"
      />
      <n-input
        v-model:value="pwdForm.newPwd"
        type="password"
        show-password-on="click"
        size="small"
        :placeholder="t('lock.settings.newPassword')"
      />
      <n-input
        v-model:value="pwdForm.confirm"
        type="password"
        show-password-on="click"
        size="small"
        :placeholder="t('lock.settings.confirmPassword')"
        :status="pwdMismatch ? 'error' : undefined"
      />
      <n-button
        size="small"
        type="primary"
        :disabled="!canChangePassword"
        @click="changePassword"
      >
        {{ t('lock.settings.changePassword') }}
      </n-button>
    </div>

    <!-- 立即锁定 -->
    <h4 class="section-title">
      {{ t('lock.settings.lockNow') }}
    </h4>
    <div class="lock-section">
      <p class="lock-now-desc">
        {{ t('lock.settings.lockNowDesc') }}
      </p>
      <n-button
        size="small"
        type="warning"
        @click="lockNow"
      >
        {{ t('lock.settings.lockNow') }}
      </n-button>
    </div>

    <!-- 锁定快捷键 -->
    <h4 class="section-title">
      {{ t('lock.settings.shortcut') }}
    </h4>
    <div class="lock-section">
      <p class="lock-now-desc">
        {{ t('lock.settings.shortcutHint') }}
      </p>
      <div
        class="shortcut-current"
        :class="{ 'is-capturing': capturing }"
      >
        <code class="shortcut-value">{{ formatShortcut(lockStore.lockShortcut) }}</code>
        <span
          v-if="capturing"
          class="shortcut-capture-hint"
        >
          {{ t('lock.settings.shortcutCapturePrompt') }} ({{ t('lock.settings.shortcutCancelHint') }})
        </span>
      </div>
      <div class="shortcut-actions">
        <n-button
          v-if="!capturing"
          size="small"
          type="primary"
          @click="startRebind"
        >
          {{ t('lock.settings.shortcutRebind') }}
        </n-button>
        <n-button
          size="small"
          :disabled="capturing"
          @click="resetShortcut"
        >
          {{ t('lock.settings.shortcutReset') }}
        </n-button>
        <n-button
          size="small"
          :disabled="capturing"
          @click="clearShortcut"
        >
          {{ t('lock.settings.shortcutClear') }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<style scoped src="./security-settings.css"></style>
