<script setup lang="ts">
// 远程接入中继档案列表（P-20261019-11）：展示/当前项/行内动作，CRUD 动作
// 上抛给 RemoteAccessSettings（保存链与提示统一一处）。
import { NButton, NIcon, NTag } from 'naive-ui'
import { AddOutline, TrashOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import type { RemoteAccessProfileView } from '../../api/client'

defineProps<{
  profiles: RemoteAccessProfileView[]
  activeId: string
  running: boolean
}>()

const emit = defineEmits<{
  (e: 'add'): void
  (e: 'edit', profile: RemoteAccessProfileView): void
  (e: 'delete', profile: RemoteAccessProfileView): void
  (e: 'activate', profile: RemoteAccessProfileView): void
}>()

const { t } = useI18n()
</script>

<template>
  <div class="ra-card">
    <div class="ra-card-head">
      <span class="ra-card-title">{{ t('remoteAccess.profiles.title') }}</span>
      <div class="ra-spacer" />
      <NButton
        size="small"
        type="primary"
        data-testid="settings-remote-access-add"
        @click="emit('add')"
      >
        <template #icon>
          <NIcon><AddOutline /></NIcon>
        </template>
        {{ t('remoteAccess.profiles.add') }}
      </NButton>
    </div>
    <div
      v-if="profiles.length === 0"
      class="ra-empty"
    >
      {{ t('remoteAccess.profiles.empty') }}
    </div>
    <div
      v-for="p in profiles"
      :key="p.id"
      class="ra-profile-row"
      :data-testid="`settings-remote-access-profile-${p.id}`"
    >
      <div class="ra-profile-main">
        <div class="ra-profile-name">
          {{ p.name }}
          <NTag
            v-if="p.id === (activeId || '')"
            size="tiny"
            :type="running ? 'success' : 'default'"
            round
          >
            {{ running ? t('remoteAccess.profiles.running') : t('remoteAccess.profiles.active') }}
          </NTag>
        </div>
        <div class="ra-profile-meta">
          {{ p.user }}@{{ p.host }}:{{ p.port }} · {{ p.remoteBindHost }}:{{ p.remotePort }}
          <span v-if="p.domain"> · {{ p.domain }}</span>
        </div>
      </div>
      <div class="ra-profile-actions">
        <NButton
          size="tiny"
          quaternary
          :disabled="running && p.id === (activeId || '')"
          @click="emit('activate', p)"
        >
          {{ t('remoteAccess.profiles.activate') }}
        </NButton>
        <NButton
          size="tiny"
          quaternary
          @click="emit('edit', p)"
        >
          {{ t('remoteAccess.profiles.edit') }}
        </NButton>
        <NButton
          size="tiny"
          quaternary
          type="error"
          :title="t('remoteAccess.profiles.delete')"
          :aria-label="t('remoteAccess.profiles.delete')"
          @click="emit('delete', p)"
        >
          <template #icon>
            <NIcon><TrashOutline /></NIcon>
          </template>
        </NButton>
      </div>
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
.ra-empty {
  padding: 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
  border: 1px dashed var(--border-subtle);
  border-radius: 6px;
}
.ra-profile-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-primary);
}
.ra-profile-main {
  min-width: 0;
  flex: 1;
}
.ra-profile-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary);
}
.ra-profile-meta {
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ra-profile-actions {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;
}
</style>
