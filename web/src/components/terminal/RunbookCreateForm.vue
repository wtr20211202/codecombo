<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NButton, NIcon, NInput, NSwitch, useMessage } from 'naive-ui'
import { TrashOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { runbookApi, type RunbookStep } from '../../api/client'
import { useRunbookDraftStore } from '../../stores/runbookDraft'

/**
 * 运行书新建表单区（自 RunbookPanel 按面板区拆分，纯搬运零逻辑改动）：
 * 标题/说明 + 步骤行（命令必填、说明可选）+ 失败即停开关。
 * 字段态自持——父面板以 v-if 挂载/卸载本组件，进入即空白（等价原 startCreate
 * 的显式重置），取消即弃（等价原 creating=false 后字段闲置）。
 */
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved'): void
}>()

const { t } = useI18n()
const message = useMessage()

const formTitle = ref('')
const formDesc = ref('')
const formSteps = ref<RunbookStep[]>([{ command: '', description: '' }])
const formOnFailureStop = ref(false) // 失败即停（P-20261004-13，默认 continue）
const saving = ref(false)
const draftCaution = ref(false)

function addFormStep() {
  formSteps.value.push({ command: '', description: '' })
}

function removeFormStep(i: number) {
  formSteps.value.splice(i, 1)
}

const formValid = computed(() =>
  formTitle.value.trim() !== '' &&
  formSteps.value.some(s => s.command.trim() !== ''),
)

async function saveBook() {
  if (!formValid.value || saving.value) return
  saving.value = true
  try {
    const steps = formSteps.value
      .filter(s => s.command.trim() !== '')
      .map(s => ({ command: s.command.trim(), description: (s.description || '').trim() || undefined }))
    await runbookApi.create({
      title: formTitle.value.trim(),
      description: formDesc.value.trim() || undefined,
      onFailure: formOnFailureStop.value ? 'stop' : 'continue',
      steps,
    })
    message.success(t('runbook.saved'))
    // 落库成功收尾（关表单 + 刷新列表）归父面板：creating 显隐与 books 列表都在父
    emit('saved')
  } catch {
    message.error(t('runbook.saveFailed'))
  } finally {
    saving.value = false
  }
}

// ── 录制一键转运行书（P-20261005-3）：消费 runbookDraft store 暂存的草稿 ──
// 生成物是草稿非直入库（防误自动化）：预填新建表单待人工过目，确认走既有
// saveBook 链；来源录制附「入库前检查命令原文」警示条（运行书为车道 1 明文存储，
// 录制期遮蔽是模式集兜底非保证）。immediate 守住「面板随草稿在位挂载」的时序
// （父面板 watch 只翻显隐，取数与预填就近表单域——显隐翻真后本组件同轮挂载）。
const draftStore = useRunbookDraftStore()

function applyRunbookDraft() {
  const d = draftStore.consume()
  if (!d) return
  formTitle.value = d.title
  formDesc.value = d.description || ''
  formSteps.value = d.steps.length > 0
    ? d.steps.map(s => ({ command: s.command, description: s.description || '' }))
    : [{ command: '', description: '' }]
  formOnFailureStop.value = d.onFailure === 'stop'
  draftCaution.value = !!d.fromRecording
}

watch(() => draftStore.pending, (d) => { if (d) applyRunbookDraft() }, { immediate: true })
</script>

<template>
  <div class="runbook-form">
    <!-- 录制草稿警示条（P-20261005-3）：cast 命令原文随录制进草稿，运行书为
         车道 1 明文存储——落库前人工逐条检查（录制期遮蔽是模式集兜底非保证） -->
    <div
      v-if="draftCaution"
      class="runbook-form-caution"
    >
      {{ t('runbook.draftCaution') }}
    </div>
    <n-input
      v-model:value="formTitle"
      size="small"
      :placeholder="t('runbook.fieldTitle')"
    />
    <n-input
      v-model:value="formDesc"
      size="small"
      :placeholder="t('runbook.fieldDesc')"
    />
    <div
      v-for="(s, i) in formSteps"
      :key="i"
      class="runbook-form-step"
    >
      <span class="runbook-form-step-no">{{ i + 1 }}</span>
      <div class="runbook-form-step-fields">
        <n-input
          v-model:value="s.command"
          size="small"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 4 }"
          :placeholder="t('runbook.stepCommand')"
        />
        <n-input
          v-model:value="s.description"
          size="small"
          :placeholder="t('runbook.stepDesc')"
        />
      </div>
      <n-button
        size="tiny"
        quaternary
        :title="t('runbook.removeStep')"
        :disabled="formSteps.length <= 1"
        @click="removeFormStep(i)"
      >
        <template #icon>
          <n-icon size="13">
            <TrashOutline />
          </n-icon>
        </template>
      </n-button>
    </div>
    <n-button
      size="tiny"
      @click="addFormStep"
    >
      {{ t('runbook.addStep') }}
    </n-button>
    <div
      class="runbook-form-onfailure"
      :title="t('runbook.onFailureHint')"
    >
      <n-switch
        v-model:value="formOnFailureStop"
        size="small"
      />
      <div class="runbook-onfailure-text">
        <span class="runbook-onfailure-label">{{ t('runbook.onFailure') }}</span>
        <span class="runbook-onfailure-hint">{{ t('runbook.onFailureHint') }}</span>
      </div>
    </div>
    <div class="runbook-form-actions">
      <n-button
        size="tiny"
        @click="emit('close')"
      >
        {{ t('common.cancel') }}
      </n-button>
      <n-button
        size="tiny"
        type="primary"
        :disabled="!formValid"
        :loading="saving"
        @click="saveBook"
      >
        {{ t('common.save') }}
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.runbook-form {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px; flex: 1; min-height: 0; overflow-y: auto;
}
/* 录制草稿警示条（P-20261005-3）：与列表「失败即停」徽标同族暖黄警示色 */
.runbook-form-caution {
  padding: 6px 8px;
  border: 1px solid var(--accent-yellow-warm);
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent-yellow-warm) 10%, transparent);
  font-size: 10px; line-height: 1.5; color: var(--accent-yellow-warm);
}
.runbook-form-step { display: flex; align-items: flex-start; gap: 6px; }
.runbook-form-step-no {
  flex-shrink: 0; min-width: 16px; text-align: right; margin-top: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-dim);
}
.runbook-form-step-fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.runbook-form-onfailure { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.runbook-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.runbook-onfailure-text { display: flex; flex-direction: column; min-width: 0; }
.runbook-onfailure-label { font-size: 11px; color: var(--text-secondary); white-space: nowrap; }
.runbook-onfailure-hint { font-size: 10px; color: var(--text-dim); }
</style>
