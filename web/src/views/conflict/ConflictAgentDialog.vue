<script setup lang="ts">
import { ref, watch } from 'vue'
import { NButton, NInput, NModal } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useUIStateStore } from '../../stores/uiState'

/**
 * 冲突委派弹层（P-20261005-190）：「交给智能体解决」发起前的模板确认面。
 * 纯表单组件：目标（单文件/批量、文件名、冲突数、git 操作语境）由宿主
 * （ConflictView）经 props 注入，确认只回传模板文本——发起链路在宿主的
 * useConflictAgentDelegate。模板持久化（P-20261008-10，P-190 假设④预留兑现）：
 * 打开先回 i18n 实时派生默认，随后异步回填 uiState 存值（记忆即默认，
 * clonePrefs 同款语义）；发起时随用随存（偏离默认措辞才记忆——存下 i18n
 * 派生的默认文案会在语言切换后凝固成假偏好，useAgentTaskTemplates 同判）；
 * 「恢复默认」一键回默认并清存值（坏存值不复活）。允许清空 = 只发结构化
 * 上下文（路径/场景/冲突体），组装器对空模板过滤空行；空模板发起不动存值
 * （留空是临时态而非偏好措辞，清存值入口收敛在「恢复默认」按钮）。
 */
const props = defineProps<{
  /** true = 批量（整个冲突集单会话）；false = 单文件（当前选中） */
  batch: boolean
  /** 单文件目标路径（batch=false 时展示） */
  file: string
  /** 批量目标文件数（batch=true 时展示） */
  count: number
  /** git 操作语境展示文案（merge/rebase/cherry-pick，宿主已本地化） */
  opLabel: string
}>()

const show = defineModel<boolean>('show', { required: true })

const emit = defineEmits<{
  (e: 'confirm', template: string): void
}>()

const { t } = useI18n()
const uiState = useUIStateStore()
const template = ref('')

function defaultTemplate(): string {
  return t('conflict.agent.defaultTemplate')
}

// 打开 = i18n 默认先行（同步，用户立即有内容可改），存值异步到达后接管：
// 有非空存值用存值、无存值保持默认（记忆即默认）。窗口期守卫用「当前值仍
// 是打开时的默认」作「用户未动键」判据——用户已在编辑则尊重输入不覆盖；
// 弹层已关（快速开合）不回填
async function restoreSavedTemplate() {
  const saved = await uiState.getConflictAgentTemplate()
  if (!show.value || !saved || template.value !== defaultTemplate()) return
  template.value = saved
}

watch(show, (v) => {
  if (v) {
    template.value = defaultTemplate()
    void restoreSavedTemplate()
  }
})

/** 恢复默认（P-20261008-10）：一键回 i18n 默认 + 清存值——坏存值不复活
 *  （读取器 '' = 无记忆），下次打开仍回实时派生默认 */
function resetTemplate() {
  template.value = defaultTemplate()
  void uiState.saveConflictAgentTemplate('')
}

function launch() {
  show.value = false
  const tpl = template.value.trim()
  // 随用随存（P-20261008-10），写入三分辨析：
  // - 偏离当前语言默认的措辞 → 记忆（用户沉淀的偏好）
  // - 显式改回默认文案 → 清记忆（回归预置，同「恢复默认」按钮语义；否则 i18n
  //   派生的默认文案被播种落盘，语言切换后旧语言默认被当偏好复活——
  //   useAgentTaskTemplates「预置不落盘」同判）
  // - 留空发起 → 不写（placeholder 明示留空 = 只发结构化上下文，是临时态而非
  //   偏好；不动存值，清存值入口收敛在「恢复默认」按钮，临时清空不摧毁偏好）
  if (tpl && tpl !== defaultTemplate()) void uiState.saveConflictAgentTemplate(tpl)
  else if (tpl) void uiState.saveConflictAgentTemplate('')
  emit('confirm', tpl)
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    class="conflict-agent-modal"
    :title="t('conflict.agent.dialogTitle')"
    :bordered="false"
    size="small"
    data-test="conflict-agent-dialog"
  >
    <div class="cag-body">
      <div
        class="cag-target"
        data-test="conflict-agent-target"
      >
        <span
          class="cag-target-op"
          :title="opLabel"
        >{{ opLabel }}</span>
        <span
          v-if="!batch"
          class="cag-target-file"
          :title="file"
        >{{ file }}</span>
        <span v-else>{{ t('conflict.agent.batchTarget', { n: count }) }}</span>
      </div>
      <div class="cag-label-row">
        <span class="cag-label">{{ t('conflict.agent.templateLabel') }}</span>
        <!-- 恢复默认（P-20261008-10）：一键回默认+清存值；恒显不随模板内容
             闪现闪灭，点击后回填即视觉反馈（清存值是静默后台写） -->
        <n-button
          size="tiny"
          quaternary
          data-test="conflict-agent-template-reset"
          @click="resetTemplate"
        >
          {{ t('conflict.agent.resetTemplate') }}
        </n-button>
      </div>
      <n-input
        v-model:value="template"
        type="textarea"
        :placeholder="t('conflict.agent.templatePlaceholder')"
        :autosize="{ minRows: 3, maxRows: 6 }"
        data-test="conflict-agent-template"
      />
      <div class="cag-hint">
        {{ batch
          ? t('conflict.agent.batchHint', { n: count })
          : t('conflict.agent.singleHint', { file }) }}
      </div>
    </div>
    <template #footer>
      <div class="cag-actions">
        <n-button
          size="small"
          @click="show = false"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          data-test="conflict-agent-launch"
          @click="launch"
        >
          {{ t('conflict.agent.launch') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.cag-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cag-target {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-body);
  min-width: 0;
}
.cag-target-op {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--accent-yellow);
  background: color-mix(in srgb, var(--accent-yellow) 12%, transparent);
}
.cag-target-file {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cag-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.cag-label {
  font-size: 12px;
  color: var(--text-dim);
}
.cag-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
}
.cag-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
