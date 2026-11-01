<script setup lang="ts">
// HTTP 明文访问警示条（P-20261002-30）：顶栏下方细横条，与 P-5 断连指示条同款
// 视觉（24px + warning 底色）。出现条件 = http: 协议 + 非 loopback 主机名，且
// 未被「不再提示」；锁定态不显示（锁屏遮罩自带同款提示，锁屏语义见
// LockScreenOverlay）——与 useWsDisconnectBar 的锁定门控同判。
// 「查看帮助」经 open-help 事件交由装配点打开 HelpCenter（组件不感知装配层状态）。
import { computed } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useHttpWarning } from '../../composables/useHttpWarning'
import { useLockStore } from '../../stores/lock'

const emit = defineEmits<{ (e: 'open-help'): void }>()
const { t } = useI18n()
const lockStore = useLockStore()
const { visible: httpVisible, dismiss } = useHttpWarning()

const visible = computed(() => httpVisible.value && !lockStore.isLocked)
</script>

<template>
  <Transition name="http-bar">
    <div
      v-if="visible"
      class="http-warning-bar"
      data-testid="http-warning-bar"
      role="status"
    >
      <span
        class="http-warning-dot"
        aria-hidden="true"
      />
      <span class="http-warning-text">{{ t('conn.http.message') }}</span>
      <span class="http-warning-spacer" />
      <button
        type="button"
        class="http-warning-action"
        data-testid="http-warning-help"
        @click="emit('open-help')"
      >
        {{ t('conn.http.help') }}
      </button>
      <button
        type="button"
        class="http-warning-action"
        data-testid="http-warning-dismiss"
        @click="dismiss"
      >
        {{ t('conn.http.dismiss') }}
      </button>
    </div>
  </Transition>
</template>

<style scoped>
/* 视觉对齐 layout.css 的 .ws-disconnect-bar（P-20261002-5）：顶栏下细横条、
   warning 色系。圆点不脉冲——本条是常驻安全提示（非恢复中的瞬时状态），
   常驻动效只增噪； likewise 尊重 reduced-motion 由全局豁免兜底 */
.http-warning-bar {
  flex-shrink: 0;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  font-size: var(--fs-small);
  color: var(--text-primary);
  background: var(--bg-warning);
  border-bottom: 1px solid var(--bg-warning-alt);
}

.http-warning-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-yellow-warm);
}

.http-warning-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 左侧消息与右侧动作之间弹性撑开：窄窗口时优先保动作按钮完整可见 */
.http-warning-spacer {
  flex: 1;
}

.http-warning-action {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 0 2px;
  font-size: var(--fs-small);
  color: var(--text-primary);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  opacity: 0.85;
}

.http-warning-action:hover {
  opacity: 1;
}

/* 出现/消失淡入淡出（同 .ws-bar 节奏） */
.http-bar-enter-active,
.http-bar-leave-active {
  transition: opacity var(--motion-slow) ease;
}
.http-bar-enter-from,
.http-bar-leave-to {
  opacity: 0;
}
</style>
