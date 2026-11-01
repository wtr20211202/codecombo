<script setup lang="ts">
import { NButton, NInput } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'

/**
 * 推送到远程弹窗（分支/标签右键「推送到远程」）：默认以本地同名推送到
 * 同名远程引用，远程名称可改（分支 refspec local:name；标签 refs/tags 前缀
 * 由宿主处理）。纯 UI 组件，推送动作由宿主执行。
 */
defineProps<{
  show: boolean
  /** 本地分支/标签名（只读展示） */
  localName: string
  /** 是否标签（提示文案区分） */
  isTag: boolean
  remote: string
  remoteName: string
  remoteNames: string[]
}>()

const emit = defineEmits<{
  (e: 'update:remote', v: string): void
  (e: 'update:remoteName', v: string): void
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
        {{ t('git.pushRefTitle') }}
      </div>
      <div class="modal-body">
        <div class="modal-field">
          <label>{{ t('git.pushRefLocalName') }}</label>
          <n-input
            :value="localName"
            size="small"
            disabled
          />
        </div>
        <div class="modal-field">
          <label>{{ t('git.pushRefRemote') }}</label>
          <select
            :value="remote"
            class="pushref-select"
            @change="(e: Event) => emit('update:remote', (e.target as HTMLSelectElement).value)"
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
          <label>{{ t('git.pushRefRemoteName') }}</label>
          <input
            :value="remoteName"
            class="pushref-input"
            :placeholder="t('git.pushRefNamePlaceholder')"
            @input="(e: Event) => emit('update:remoteName', (e.target as HTMLInputElement).value)"
            @keyup.enter="emit('confirm')"
          >
        </div>
        <div class="pushref-tip">
          {{ t('git.pushRefTip') }}
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
          :disabled="!remoteName || !remote"
          @click="emit('confirm')"
        >
          {{ t('git.pushRefBtn') }}
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
.pushref-select {
  background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2); font-size: 13px; outline: none;
}
.pushref-select:focus { border-color: var(--accent-blue); }
.pushref-input {
  background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2); font-size: 13px; outline: none; width: 100%;
}
.pushref-input:focus { border-color: var(--accent-blue); }
.pushref-tip { font-size: 0.8em; color: var(--text-muted); line-height: 1.5; }
</style>
