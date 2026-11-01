<script setup lang="ts">
// 远程接入状态卡（P-20261019-11）：隧道状态/公网 URL/二维码/连接计数/
// 主机指纹/最近错误。纯展示 + 动作上抛（启停/复制/二维码/重置指纹/重连由
// RemoteAccessSettings 统一处理，状态轮询与审计留一处）。
import { NButton, NIcon, NInput, NQrCode, NTag } from 'naive-ui'
import { CopyOutline, PlayOutline, RefreshOutline, StopOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import type { RemoteAccessStatus } from '../../api/client'

defineProps<{
  status: RemoteAccessStatus | null
  running: boolean
  stateType: 'default' | 'success' | 'warning' | 'error'
  stateLabel: string
  showQr: boolean
}>()

const emit = defineEmits<{
  (e: 'start'): void
  (e: 'stop'): void
  (e: 'copy'): void
  (e: 'toggle-qr'): void
  (e: 'reset-hostkey'): void
  (e: 'reconnect'): void
}>()

const { t } = useI18n()
</script>

<template>
  <div
    class="ra-card"
    data-testid="settings-remote-access-status"
  >
    <div class="ra-card-head">
      <span class="ra-card-title">{{ t('remoteAccess.status.title') }}</span>
      <NTag
        :type="stateType"
        size="small"
        round
      >
        {{ stateLabel }}
      </NTag>
      <span
        v-if="running"
        class="ra-state-dot"
      />
      <div class="ra-spacer" />
      <NButton
        v-if="running"
        size="small"
        data-testid="settings-remote-access-stop"
        @click="emit('stop')"
      >
        <template #icon>
          <NIcon><StopOutline /></NIcon>
        </template>
        {{ t('remoteAccess.status.stop') }}
      </NButton>
      <NButton
        v-else
        size="small"
        type="primary"
        :disabled="!status?.lockReady || !status?.activeId"
        data-testid="settings-remote-access-start"
        @click="emit('start')"
      >
        <template #icon>
          <NIcon><PlayOutline /></NIcon>
        </template>
        {{ t('remoteAccess.status.start') }}
      </NButton>
      <NButton
        v-if="status?.state === 'reconnecting'"
        size="small"
        quaternary
        @click="emit('reconnect')"
      >
        <template #icon>
          <NIcon><RefreshOutline /></NIcon>
        </template>
        {{ t('remoteAccess.status.reconnecting') }}
      </NButton>
    </div>

    <div
      v-if="status?.publicUrl"
      class="ra-row"
    >
      <span class="ra-label">{{ t('remoteAccess.status.publicUrl') }}</span>
      <NInput
        :value="status.publicUrl"
        readonly
        size="small"
        data-testid="settings-remote-access-url"
      />
      <NButton
        size="small"
        quaternary
        @click="emit('copy')"
      >
        <template #icon>
          <NIcon><CopyOutline /></NIcon>
        </template>
        {{ t('remoteAccess.status.copy') }}
      </NButton>
      <NButton
        size="small"
        quaternary
        @click="emit('toggle-qr')"
      >
        {{ t('remoteAccess.status.qr') }}
      </NButton>
    </div>
    <div
      v-else-if="running"
      class="ra-row"
    >
      <span class="ra-label">{{ t('remoteAccess.status.publicUrl') }}</span>
      <span class="ra-muted">{{ t('remoteAccess.status.publicUrlEmpty') }}</span>
    </div>
    <div
      v-if="showQr && status?.publicUrl"
      class="ra-qr"
    >
      <NQrCode
        :value="status.publicUrl"
        :size="150"
      />
    </div>

    <div class="ra-grid">
      <div class="ra-metric">
        <span class="ra-muted">{{ t('remoteAccess.status.activeConns') }}</span>
        <strong>{{ status?.activeConnections ?? 0 }}</strong>
      </div>
      <div class="ra-metric">
        <span class="ra-muted">{{ t('remoteAccess.status.totalConns') }}</span>
        <strong>{{ status?.totalConnections ?? 0 }}</strong>
      </div>
      <div class="ra-metric">
        <span class="ra-muted">{{ t('remoteAccess.status.attempts') }}</span>
        <strong>{{ status?.reconnectAttempts ?? 0 }}</strong>
      </div>
      <div
        v-if="status?.onlineSince"
        class="ra-metric"
      >
        <span class="ra-muted">{{ t('remoteAccess.status.onlineSince') }}</span>
        <strong>{{ new Date(status.onlineSince).toLocaleString() }}</strong>
      </div>
    </div>

    <div class="ra-row ra-hostkey">
      <span class="ra-label">{{ t('remoteAccess.status.hostKey') }}</span>
      <code v-if="status?.hostKey?.pinned">{{ status.hostKey.fingerprint }}</code>
      <span
        v-else
        class="ra-muted"
      >{{ t('remoteAccess.status.hostKeyUnpinned') }}</span>
      <NButton
        v-if="status?.hostKey?.pinned && status?.activeId"
        size="tiny"
        quaternary
        @click="emit('reset-hostkey')"
      >
        {{ t('remoteAccess.status.resetHostKey') }}
      </NButton>
    </div>
    <!-- TOFU 核对提示（P-20261020-1）：首次钉扎不阻断连接，但必须提醒用户
         到 VPS 上比对指纹——首次连接被中间人顶替时 pin 住的正是攻击者密钥 -->
    <p
      v-if="status?.hostKey?.pinned"
      class="ra-hostkey-verify"
      data-testid="settings-remote-access-hostkey-verify"
    >
      {{ t('remoteAccess.status.hostKeyVerify') }}
    </p>
    <div
      v-if="status?.lastError"
      class="ra-error"
      data-testid="settings-remote-access-error"
    >
      <span class="ra-label">{{ t('remoteAccess.status.lastError') }}</span>
      <span>{{ status.lastError }}</span>
    </div>
  </div>
</template>

<style scoped>
.ra-card {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 12px;
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ra-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ra-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.ra-spacer {
  flex: 1;
}
.ra-state-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent-green);
  box-shadow: 0 0 6px var(--accent-green);
}
.ra-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.ra-label {
  font-size: 12px;
  color: var(--text-secondary);
  flex: 0 0 auto;
  min-width: 72px;
}
.ra-muted {
  font-size: 12px;
  color: var(--text-tertiary);
}
.ra-qr {
  display: flex;
  justify-content: center;
  padding: 6px 0;
}
.ra-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}
.ra-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
.ra-metric strong {
  font-size: 14px;
  color: var(--text-primary);
}
.ra-hostkey code {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ra-hostkey-verify {
  margin: -4px 0 0;
  font-size: 11px;
  line-height: 1.55;
  color: var(--accent-orange);
  word-break: break-word;
}
.ra-error {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--accent-red);
  word-break: break-word;
}
</style>
