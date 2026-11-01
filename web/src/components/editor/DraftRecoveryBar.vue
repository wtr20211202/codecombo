<script setup lang="ts">
// 草稿恢复提示条（P-20261002-6）：打开文件探测到比磁盘新的未保存草稿时，
// 在编辑器区顶部展示「检测到未保存的草稿 <时间>」+ 恢复/对比预览/丢弃三键
// （对比预览 P-20261004-71：草稿可能出自几小时前的崩溃而磁盘已被再改，
// 先看差异再做恢复/丢弃的知情决策）。
// 纯展示组件：offer 由 useOpenFiles 探测入队（经 Layout 传入），动作原样
// 上抛（写回文件/开 diff/删草稿都收口在 useOpenFiles，本组件不碰状态）
import { computed } from 'vue'
import { useI18n } from '@/composables/useI18n'
import type { DraftOffer } from '@/composables/useOpenFiles'

const props = defineProps<{
  /** 待决恢复提示（队首），null = 无草稿可恢复不渲染 */
  offer: DraftOffer | null
}>()

const emit = defineEmits<{
  restore: []
  preview: []
  discard: []
}>()

const { t } = useI18n()

const savedTimeText = computed(() =>
  props.offer ? new Date(props.offer.savedAt).toLocaleTimeString() : '',
)
</script>

<template>
  <div
    v-if="offer"
    class="draft-recovery-bar"
    data-testid="draft-recovery-bar"
    role="status"
  >
    <span class="draft-recovery-text">{{ t('editor.draft.foundTitle', { time: savedTimeText }) }}</span>
    <span class="draft-recovery-actions">
      <button
        class="draft-recovery-btn primary"
        data-testid="draft-recovery-restore"
        @click="emit('restore')"
      >
        {{ t('editor.draft.restore') }}
      </button>
      <button
        class="draft-recovery-btn"
        data-testid="draft-recovery-preview"
        @click="emit('preview')"
      >
        {{ t('editor.draft.preview') }}
      </button>
      <button
        class="draft-recovery-btn"
        data-testid="draft-recovery-discard"
        @click="emit('discard')"
      >
        {{ t('editor.draft.discard') }}
      </button>
    </span>
  </div>
</template>

<style scoped>
.draft-recovery-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 6px 14px;
  font-size: 0.88em;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-default);
  box-shadow: inset 0 2px 0 var(--accent-orange);
  color: var(--text-body);
}

.draft-recovery-text {
  color: var(--text-secondary);
}

.draft-recovery-actions {
  display: inline-flex;
  gap: 8px;
}

.draft-recovery-btn {
  padding: 3px 12px;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: transparent;
  color: var(--text-body);
  font-size: 0.92em;
  cursor: pointer;
  transition: all var(--motion-base);
}

.draft-recovery-btn:hover {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}

.draft-recovery-btn.primary {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}

.draft-recovery-btn.primary:hover {
  background: var(--brand-accent-soft);
}
</style>
