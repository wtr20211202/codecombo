<script setup lang="ts">
import { computed } from 'vue'
import { NDropdown } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'

/**
 * 智能体侧栏多选批操作栏（P-20261001-20 从 AgentSidebarSessionTree 拆出的渲染层）：
 * Ctrl/Cmd+点选系统会话后出现；移动目标选项由传入分组组装，动作上抛宿主。
 */
const props = defineProps<{
  /** 已选（且仍存活）的会话数 */
  count: number
  /** 移动目标分组（未分组固定为首项） */
  groups: { id: string; name: string }[]
}>()

const emit = defineEmits<{
  (e: 'move', toGroupId: string | '__root__'): void
  (e: 'destroy'): void
  (e: 'clear'): void
}>()

const { t } = useI18n()

const batchMoveOptions = computed(() => [
  { label: t('agentTerminal.moveToRoot'), key: '__root__' },
  ...props.groups.map(g => ({ label: g.name, key: g.id })),
])
</script>

<template>
  <div class="ats-batch">
    <span class="ats-batch-count">{{ t('agentTerminal.batchSelected', { n: count }) }}</span>
    <n-dropdown
      trigger="click"
      :options="batchMoveOptions"
      placement="top-start"
      @select="(key: string) => emit('move', key)"
    >
      <button class="ats-batch-btn">
        {{ t('agentTerminal.moveToGroup') }}
      </button>
    </n-dropdown>
    <button
      class="ats-batch-btn is-danger"
      @click="emit('destroy')"
    >
      {{ t('agentTerminal.destroy') }}
    </button>
    <button
      class="ats-batch-btn"
      :title="t('common.close')"
      @click="emit('clear')"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.ats-batch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-panel);
  flex-shrink: 0;
}
.ats-batch-count { font-size: 11px; color: var(--text-secondary); flex: 1; min-width: 0; }
.ats-batch-btn {
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-body);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.ats-batch-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.ats-batch-btn.is-danger { color: var(--accent-red); border-color: var(--accent-red); }
</style>
