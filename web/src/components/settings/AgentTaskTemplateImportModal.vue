<script setup lang="ts">
/**
 * 智能体任务模板导入预览弹层（P-20261005-209）：纯展示组件，逐条列出导入
 * 条目并标注同名冲突；同名项默认跳过（保守档），逐项勾选「覆盖本地」后才
 * 会替换本机内容（提案③）——确认经 emit 上抛由宿主（AgentTaskTemplateManager）
 * 走既有 uiState 写链。CustomAgentsImportModal 同款分工（策略在那边是全局
 * 单选，这边按任务书语义细到逐项勾选）。
 */
import { computed, ref, watch } from 'vue'
import { NButton, NCheckbox, NModal, NTag } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import type { TemplateImportEntry } from '../../utils/agentTaskTemplateTransfer'

const props = defineProps<{
  show: boolean
  entries: TemplateImportEntry[]
  /** 清洗阶段被丢弃的无效条目数（>0 时展示忽略注记，导入清单不完整须知情） */
  invalidCount?: number
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'confirm', overwriteNames: string[]): void
}>()

const { t } = useI18n()

// 同名覆盖的逐项勾选（键 = 模板名，sanitize 已按名去重保证唯一）；每次打开重置
const overwriteNames = ref(new Set<string>())
watch(() => props.show, (v) => { if (v) overwriteNames.value = new Set() })

/** 按勾选实际会入库的条数（确认按钮计数：未勾覆盖的同名项不算） */
const applyCount = computed(() =>
  props.entries.filter(e => !e.conflict || overwriteNames.value.has(e.item.name)).length)

function toggleOverwrite(name: string, v: boolean) {
  if (v) overwriteNames.value.add(name)
  else overwriteNames.value.delete(name)
}

function close() {
  emit('update:show', false)
}

function confirm() {
  emit('confirm', [...overwriteNames.value])
  close()
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    style="width: var(--modal-w-md); max-width: 94vw"
    data-testid="agent-tpl-import-modal"
    @update:show="close"
  >
    <template #header>
      {{ t('settings.agentTaskTemplates.importTitle') }}
    </template>

    <p class="import-hint">
      {{ t('settings.agentTaskTemplates.importHint') }}
    </p>

    <p
      v-if="invalidCount"
      class="import-invalid-note"
    >
      {{ t('settings.agentTaskTemplates.importInvalidSkipped', { n: invalidCount }) }}
    </p>

    <ul class="import-list">
      <li
        v-for="e in entries"
        :key="e.item.name"
        class="import-item"
      >
        <div class="item-head">
          <span class="item-name">{{ e.item.name }}</span>
          <NTag
            v-if="!e.conflict"
            size="tiny"
            class="new-tag"
          >{{ t('settings.agentTaskTemplates.importNewItem') }}</NTag>
          <NTag
            v-else
            size="tiny"
            type="warning"
            class="conflict-tag"
          >{{ t('settings.agentTaskTemplates.importConflictTag') }}</NTag>
          <NCheckbox
            v-if="e.conflict"
            size="small"
            class="overwrite-check"
            data-testid="agent-tpl-overwrite-check"
            :checked="overwriteNames.has(e.item.name)"
            @update:checked="v => toggleOverwrite(e.item.name, v)"
          >
            {{ t('settings.agentTaskTemplates.importOverwrite') }}
          </NCheckbox>
        </div>
        <div
          class="item-prompt"
          :title="e.item.prompt"
        >{{ e.item.prompt }}</div>
        <div
          v-if="e.existing"
          class="item-existing"
          :title="e.existing.prompt"
        >
          {{ t('settings.agentTaskTemplates.importLocalCurrent') }}: {{ e.existing.prompt }}
        </div>
      </li>
    </ul>

    <template #action>
      <div class="modal-actions">
        <NButton
          size="small"
          quaternary
          @click="close"
        >
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          data-testid="agent-tpl-import-confirm"
          @click="confirm"
        >
          {{ t('settings.agentTaskTemplates.importConfirm', { n: applyCount }) }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.import-hint {
  margin: 0 0 var(--space-2);
  font-size: 12px;
  color: var(--text-secondary);
}

.import-invalid-note {
  margin: 0 0 var(--space-2);
  font-size: 12px;
  color: var(--text-secondary);
}

.import-list {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
}

.import-item {
  padding: var(--space-2) 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  margin-bottom: 6px;
}

.item-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.item-name {
  font-weight: var(--fw-semibold);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.new-tag {
  flex-shrink: 0;
}

.conflict-tag {
  flex-shrink: 0;
}

.overwrite-check {
  margin-left: auto;
  flex-shrink: 0;
}

.item-prompt {
  margin-top: var(--space-1);
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-existing {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
