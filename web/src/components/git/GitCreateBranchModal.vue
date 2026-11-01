<script setup lang="ts">
import { NButton, NInput } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'

/** 创建分支弹窗（自 GitBranchesSection 抽出的纯 UI） */
defineProps<{
  show: boolean
  branchFromRef: string
  newBranchName: string
}>()

const emit = defineEmits<{
  (e: 'update:newBranchName', v: string): void
  (e: 'close'): void
  (e: 'create'): void
}>()

const { t } = useI18n()
</script>

<template>
  <div
    v-show="show"
    class="modal-overlay"
    @click.self="emit('close')"
  >
    <div class="modal-card">
      <div class="modal-title">
        {{ t('git.createBranchFrom', { ref: branchFromRef }) }}
      </div>
      <div class="modal-body">
        <div class="modal-field">
          <label>{{ t('git.newBranchName') }}</label>
          <n-input
            :value="newBranchName"
            :placeholder="t('git.newBranchPlaceholder')"
            size="small"
            @update:value="(v: string) => emit('update:newBranchName', v)"
            @keyup.enter="emit('create')"
          />
        </div>
      </div>
      <div class="modal-footer">
        <n-button
          size="small"
          @click="emit('close')"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="!newBranchName"
          @click="emit('create')"
        >
          {{ t('common.create') }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed; inset: 0; z-index: 2000;
  background: var(--overlay-mask);
  display: flex; align-items: center; justify-content: center;
}
.modal-card {
  width: 380px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop-lg);
}
.modal-title {
  padding: var(--space-3) var(--space-4); font-size: 0.95em; font-weight: var(--fw-medium); color: var(--text-primary);
  border-bottom: 1px solid var(--border-default);
}
.modal-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.modal-field { display: flex; flex-direction: column; gap: var(--space-1); }
.modal-field label { font-size: 0.85em; color: var(--text-secondary); }
.modal-footer {
  padding: 10px var(--space-4); display: flex; justify-content: flex-end; gap: var(--space-2);
  border-top: 1px solid var(--border-default);
}
</style>
