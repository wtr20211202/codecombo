<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useProjectStore } from '../../stores/project'
import { useChangesStore } from '../../stores/changes'
import { useGitLockRecoveryStore } from '../../stores/gitLockRecovery'
import { gitLockApi } from '../../api/client'

// index.lock 遗留锁修复条（P-20261002-150）：axios 拦截器在 git 写命令失败的
// 错误原文命中服务端稳定标记（IndexLockStaleMarker）时记录项目 ID，本条在变更
// 面板顶部给出「一键清理」。视觉与出现/消失动效对齐 HttpWarningBar（P-30）/
// ws-disconnect-bar 同款修复条形态。显示限定当前项目——错误属于特定仓库，
// 切走即隐藏、切回仍可继续处理。误删保护在服务端（mtime 双重校验）：未达
// 阈值 409 拒绝，锁不存在幂等成功
const { t } = useI18n()
const message = useMessage()
const projectStore = useProjectStore()
const changesStore = useChangesStore()
const recovery = useGitLockRecoveryStore()

const visible = computed(() =>
  !!projectStore.currentProjectId && recovery.projectId === projectStore.currentProjectId,
)
const cleaning = ref(false)

async function handleCleanup() {
  const pid = projectStore.currentProjectId
  if (!pid || cleaning.value) return
  cleaning.value = true
  try {
    await gitLockApi.cleanup(pid)
    recovery.clear(pid)
    message.success(t('git.lockRecovery.cleaned'))
    // 清理后刷新变更列表：界面回到可用态（写恢复由用户重试刚才的操作触发）
    await changesStore.fetchStatus(pid)
  } catch { /* 拦截器已提示（未达阈值 409 拒绝等），保留修复条供稍后重试 */ }
  finally { cleaning.value = false }
}

function dismiss() {
  recovery.clear(projectStore.currentProjectId || undefined)
}
</script>

<template>
  <Transition name="ilr-bar">
    <div
      v-if="visible"
      class="ilr-bar"
      role="alert"
      data-testid="index-lock-bar"
    >
      <span
        class="ilr-dot"
        aria-hidden="true"
      />
      <span class="ilr-text">{{ t('git.lockRecovery.title') }}</span>
      <span class="ilr-spacer" />
      <button
        type="button"
        class="ilr-action"
        :disabled="cleaning"
        data-testid="index-lock-cleanup"
        @click="handleCleanup"
      >
        {{ t('git.lockRecovery.clean') }}
      </button>
      <button
        type="button"
        class="ilr-action"
        data-testid="index-lock-dismiss"
        @click="dismiss"
      >
        {{ t('git.lockRecovery.dismiss') }}
      </button>
    </div>
  </Transition>
</template>

<style scoped>
/* 同 HttpWarningBar：24px 细横条 + warning 色系；圆点不脉冲——遗留锁是
   常驻待处理状态（非恢复中的瞬时状态），常驻动效只增噪 */
.ilr-bar {
  flex-shrink: 0;
  height: 24px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 10px;
  font-size: var(--fs-small);
  color: var(--text-primary);
  background: var(--bg-warning);
  border-bottom: 1px solid var(--bg-warning-alt);
}

.ilr-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-yellow-warm);
}

.ilr-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 左侧消息与右侧动作之间弹性撑开：窄面板时优先保动作按钮完整可见 */
.ilr-spacer {
  flex: 1;
}

.ilr-action {
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

.ilr-action:hover:not(:disabled) {
  opacity: 1;
}

.ilr-action:disabled {
  cursor: default;
  opacity: 0.5;
}

/* 出现/消失淡入淡出（同 .http-bar 节奏） */
.ilr-bar-enter-active,
.ilr-bar-leave-active {
  transition: opacity var(--motion-slow) ease;
}

.ilr-bar-enter-from,
.ilr-bar-leave-to {
  opacity: 0;
}
</style>
