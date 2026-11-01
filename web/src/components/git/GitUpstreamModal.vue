<script setup lang="ts">
import { NButton, NInput } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'

/** 设置上游跟踪弹窗（自 GitBranchesSection 抽出的纯 UI） */
defineProps<{
  show: boolean
  upstreamBranch: string
  upstreamRemote: string
  upstreamRemoteBranch: string
  remoteNames: string[]
  /** 当前 remote 下的远程分支候选（datalist） */
  remoteBranchOptions: string[]
}>()

const emit = defineEmits<{
  (e: 'update:upstreamRemote', v: string): void
  (e: 'update:upstreamRemoteBranch', v: string): void
  (e: 'close'): void
  (e: 'confirm'): void
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
        {{ t('git.setUpstreamTitle') }}
      </div>
      <div class="modal-body">
        <div class="modal-field">
          <label>{{ t('git.localBranch') }}</label>
          <n-input
            :value="upstreamBranch"
            size="small"
            disabled
          />
        </div>
        <div class="modal-field">
          <label>{{ t('git.remoteRepo') }}</label>
          <select
            :value="upstreamRemote"
            class="upstream-select"
            @change="(e: Event) => emit('update:upstreamRemote', (e.target as HTMLSelectElement).value)"
          >
            <option
              v-for="r in remoteNames"
              :key="r"
              :value="r"
            >
              {{ r }}
            </option>
            <option
              v-if="remoteNames.length === 0"
              value=""
            >
              {{ t('git.noRemotesOption') }}
            </option>
          </select>
        </div>
        <div class="modal-field">
          <label>{{ t('git.remoteBranch') }}</label>
          <input
            :value="upstreamRemoteBranch"
            class="upstream-input"
            :placeholder="t('git.remoteBranchPlaceholder')"
            list="upstream-branch-list"
            @input="(e: Event) => emit('update:upstreamRemoteBranch', (e.target as HTMLInputElement).value)"
            @keyup.enter="emit('confirm')"
          >
          <datalist id="upstream-branch-list">
            <option
              v-for="b in remoteBranchOptions"
              :key="b"
              :value="b"
            />
          </datalist>
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
          :disabled="!upstreamRemoteBranch || !upstreamRemote"
          @click="emit('confirm')"
        >
          {{ t('git.setUpstreamBtn') }}
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
.upstream-select {
  background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2); font-size: 13px; outline: none;
}
.upstream-select:focus { border-color: var(--accent-blue); }
.upstream-input {
  background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2); font-size: 13px; outline: none; width: 100%;
}
.upstream-input:focus { border-color: var(--accent-blue); }
</style>
