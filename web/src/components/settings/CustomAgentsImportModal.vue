<script setup lang="ts">
/**
 * 自定义智能体导入预览弹层（P-20261004-83）：纯展示组件，逐条列出导入条目的
 * 命令清单并标注同名冲突（对照本地现值），同名合并策略（跳过/覆盖）单选——
 * 确认经 emit 上抛由宿主（CustomAgentsManager）执行既有 CRUD。
 * 命令执行面强警示常驻弹层顶部：launch 命令在本机经 shell 执行（与手敲等价），
 * 导入即向本机添加命令执行面——清单确认不可跳过（弹层是导入唯一通道）。
 */
import { computed, ref, watch } from 'vue'
import { NButton, NModal, NRadioButton, NRadioGroup, NTag } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import type { AgentImportEntry, AgentImportStrategy } from '../../utils/customAgentTransfer'

const props = defineProps<{
  show: boolean
  entries: AgentImportEntry[]
  /** 清洗阶段被丢弃的无效条目数（>0 时展示忽略注记，导入清单不完整须知情） */
  invalidCount?: number
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'confirm', strategy: AgentImportStrategy): void
}>()

const { t } = useI18n()

// 策略默认 skip（保守档：同名冲突不静默改本机现值）；每次打开重置
const strategy = ref<AgentImportStrategy>('skip')
watch(() => props.show, (v) => { if (v) strategy.value = 'skip' })

const conflictCount = computed(() => props.entries.filter(e => e.conflict).length)

/** 按策略实际会入库的条数（确认按钮计数：跳过的不算） */
const applyCount = computed(() =>
  strategy.value === 'skip' ? props.entries.length - conflictCount.value : props.entries.length,
)

function close() {
  emit('update:show', false)
}

function confirm() {
  emit('confirm', strategy.value)
  close()
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    style="width: var(--modal-w-md); max-width: 94vw"
    @update:show="close"
  >
    <template #header>
      {{ t('settings.customAgents.importTitle') }}
    </template>
    <p class="import-warning">
      {{ t('settings.customAgents.importCommandWarning') }}
    </p>

    <p
      v-if="invalidCount"
      class="import-invalid-note"
    >
      {{ t('settings.customAgents.importInvalidSkipped', { n: invalidCount }) }}
    </p>

    <ul class="import-list">
      <li
        v-for="e in entries"
        :key="e.agent.name"
        class="import-item"
      >
        <div class="item-head">
          <span class="item-name">{{ e.agent.displayName || e.agent.name }}</span>
          <NTag
            size="tiny"
            class="name-tag"
          >{{ e.agent.name }}</NTag>
          <NTag
            v-if="e.conflict"
            size="tiny"
            type="warning"
            class="conflict-tag"
          >{{ t('settings.customAgents.conflictTag') }}</NTag>
        </div>
        <div
          class="item-command"
          :title="e.agent.command"
        >{{ e.agent.command }}</div>
        <div
          v-if="e.existing"
          class="item-existing"
          :title="e.existing.command"
        >
          {{ t('settings.customAgents.localCurrent') }}: {{ e.existing.command }}
        </div>
      </li>
    </ul>

    <div class="strategy-row">
      <span class="strategy-label">{{ t('settings.customAgents.importStrategy') }}</span>
      <NRadioGroup
        v-model:value="strategy"
        size="small"
      >
        <NRadioButton value="skip">
          {{ t('settings.customAgents.strategySkip') }}
        </NRadioButton>
        <NRadioButton value="overwrite">
          {{ t('settings.customAgents.strategyOverwrite') }}
        </NRadioButton>
      </NRadioGroup>
    </div>

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
          type="warning"
          data-test="custom-agents-import-confirm"
          @click="confirm"
        >
          {{ t('settings.customAgents.importConfirm', { n: applyCount }) }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.import-warning {
  margin: 0 0 10px;
  padding: var(--space-2) 10px;
  border: 1px solid var(--bg-border);
  border-left: 3px solid var(--accent-yellow, #f0a020);
  border-radius: var(--radius-sm);
  color: var(--text-color-2);
  font-size: 12px;
  line-height: 1.6;
}

.import-invalid-note {
  margin: 0 0 var(--space-2);
  font-size: 12px;
  color: var(--text-color-3);
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
  border: 1px solid var(--bg-border);
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
}

.name-tag {
  font-family: monospace;
}

.conflict-tag {
  margin-left: auto;
}

.item-command {
  margin-top: var(--space-1);
  font-family: monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-existing {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-color-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.strategy-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.strategy-label {
  font-size: 12px;
  color: var(--text-color-2);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
