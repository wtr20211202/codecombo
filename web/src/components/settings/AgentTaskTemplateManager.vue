<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import {
  NButton, NCheckbox, NIcon, NInput, NTag, NPopconfirm, NEmpty, NSpin, useMessage,
} from 'naive-ui'
import { AddOutline, ArrowUpOutline, ArrowDownOutline, CreateOutline, TrashOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useLocaleStore } from '../../stores/locale'
import { useAgentTaskTemplates } from '../../composables/useAgentTaskTemplates'
import { confirmDialog } from '../../composables/useDialog'
import { byteLength, LAUNCH_ARGS_MAX_BYTES } from '../../utils/promptFit'
import { exportFileName } from '../../utils/exportFileName'
import type { AgentTaskTemplate } from '../../utils/agentTaskTemplate'
import {
  buildTemplateExportPayload, parseTemplateImport, planTemplateImport, applyTemplateImport,
  sensitiveTemplateNames, type TemplateImportEntry,
} from '../../utils/agentTaskTemplateTransfer'
import AgentTaskTemplateImportModal from './AgentTaskTemplateImportModal.vue'

/**
 * 智能体任务模板管理（P-20261002-16）：挂在设置 → 通用 → 智能体分区
 * （SnippetManager/CustomAgentsManager 同款区块模式：head + 行内表单 + 行列表）。
 * CRUD + 上下移排序；出厂预置虚置展示（i18n 实时派生），任一改动先物化再落盘
 * （uiState 命名空间，即时生效无保存按钮——不走设置页的「保存」链）。
 * 消费端 = 新建会话对话框的任务模板下拉。
 * 导出/导入（P-20261005-209）：跨实例模板迁移的文件形态（CustomAgentsManager
 * 同款链路）——导出走行勾选（未勾选=全部）客户端 blob 下载；导入经文件选择 →
 * 清洗 → 冲突预览（同名逐项勾选覆盖，默认跳过）→ 整批一次落盘。
 */
const { t } = useI18n()
const message = useMessage()
const localeStore = useLocaleStore()
const {
  templates, customized, load, addTemplate, updateTemplate, removeTemplate, moveTemplate, validate, importTemplates,
} = useAgentTaskTemplates()

const loading = ref(false)
const saving = ref(false)
// 编辑中的模板（null = 非编辑态）；formOpen 控制表单显隐
const editingId = ref<string | null>(null)
const formOpen = ref(false)
const formName = ref('')
const formPrompt = ref('')

// 校验码 → i18n（校验逻辑在 utils 纯函数，这里只做文案映射）
const VALIDATE_MSG: Record<string, string> = {
  nameRequired: 'settings.agentTaskTemplates.nameRequired',
  promptRequired: 'settings.agentTaskTemplates.promptRequired',
  nameTooLong: 'settings.agentTaskTemplates.nameTooLong',
  promptTooLong: 'settings.agentTaskTemplates.promptTooLong',
}

const formPromptBytes = computed(() => byteLength(formPrompt.value))
const formPromptOver = computed(() => formPromptBytes.value > LAUNCH_ARGS_MAX_BYTES)

async function fetchTemplates() {
  loading.value = true
  try {
    await load()
  } finally {
    loading.value = false
  }
}

onMounted(fetchTemplates)
// 出厂预置是 i18n 实时派生：切语言后重拉让未定制列表跟随 locale（定制表内容不变）
watch(() => localeStore.currentLocale, () => { void fetchTemplates() })

function openCreate() {
  editingId.value = null
  formName.value = ''
  formPrompt.value = ''
  formOpen.value = true
}

function openEdit(x: AgentTaskTemplate) {
  editingId.value = x.id
  formName.value = x.name
  formPrompt.value = x.prompt
  formOpen.value = true
}

function closeForm() {
  formOpen.value = false
  editingId.value = null
}

async function save() {
  const code = validate(formName.value, formPrompt.value)
  if (code) {
    message.warning(t(VALIDATE_MSG[code] ?? 'settings.agentTaskTemplates.promptRequired'))
    return
  }
  saving.value = true
  try {
    if (editingId.value) await updateTemplate(editingId.value, formName.value, formPrompt.value)
    else await addTemplate(formName.value, formPrompt.value)
    message.success(t('settings.agentTaskTemplates.saved'))
    closeForm()
    await fetchTemplates()
  } catch {
    message.error(t('settings.agentTaskTemplates.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function remove(x: AgentTaskTemplate) {
  try {
    await removeTemplate(x.id)
    message.success(t('settings.agentTaskTemplates.deleted'))
    await fetchTemplates()
  } catch {
    message.error(t('settings.agentTaskTemplates.deleteFailed'))
  }
}

/** 上移/下移一步；操作后重拉对齐（排序随存随生效） */
async function move(x: AgentTaskTemplate, dir: -1 | 1) {
  await moveTemplate(x.id, dir)
  await fetchTemplates()
}

// ---- 导出/导入（P-20261005-209，CustomAgentsManager 同款链路）----

/** 行勾选集（导出的多选面；含已删行残留 id 无害——导出按现存列表求交） */
const selectedIds = ref(new Set<string>())
function toggleSelect(id: string, v: boolean) {
  if (v) selectedIds.value.add(id)
  else selectedIds.value.delete(id)
}

const importFileRef = ref<HTMLInputElement | null>(null)
const showImportModal = ref(false)
const importEntries = ref<TemplateImportEntry[]>([])
/** 清洗阶段被丢弃的无效条目数（预览弹层知情注记） */
const importInvalidCount = ref(0)

/** 客户端合成 JSON 下载（CustomAgentsManager 同款 blob 链；exportFileName 导出族命名） */
function downloadTemplatesJson(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 导出勾选的模板（未勾选 = 全部）。prompt 文本过 maskSensitive 差分检测，
 *  疑似含凭据/令牌时导出前弹非阻断警示（P-101 弱口令警示同款：提示可继续，
 *  用户自担——导出文件为明文 JSON 不做遮蔽，遮蔽会破坏模板正文） */
async function exportSelected() {
  const picked = templates.value.filter(x => selectedIds.value.has(x.id))
  const list = picked.length > 0 ? picked : templates.value
  if (list.length === 0) {
    message.warning(t('settings.agentTaskTemplates.exportEmpty'))
    return
  }
  const hits = sensitiveTemplateNames(list)
  if (hits.length > 0) {
    // 名单取前 3 项摘要，其余以 … 收口（summarizeNames 同族截断惯例）
    let names = hits.slice(0, 3).join('、')
    if (hits.length > 3) names += '…'
    const ok = await confirmDialog({
      title: t('settings.agentTaskTemplates.exportSensitiveTitle'),
      content: t('settings.agentTaskTemplates.exportSensitiveContent', { names }),
      type: 'warning',
      confirmText: t('settings.agentTaskTemplates.exportSensitiveProceed'),
    })
    if (!ok) return
  }
  downloadTemplatesJson(
    buildTemplateExportPayload(list),
    exportFileName('task-templates', new Date(), 'json', 'codecombo'),
  )
  message.success(t('settings.agentTaskTemplates.exportDone', { n: list.length }))
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许重复选择同一文件
  if (!file) return
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    message.error(t('settings.agentTaskTemplates.importInvalid'))
    return
  }
  const result = parseTemplateImport(parsed)
  if (!result) {
    message.error(t('settings.agentTaskTemplates.importInvalid'))
    return
  }
  if (result.templates.length === 0) {
    message.warning(t('settings.agentTaskTemplates.importNone'))
    return
  }
  importInvalidCount.value = result.invalid
  importEntries.value = planTemplateImport(result.templates, templates.value)
  showImportModal.value = true
}

/** 执行导入：整批一次落盘（importTemplates 收口，防逐条 N 次全量写 uiState），
 *  完成后重拉对齐并 toast 计数（新增/覆盖/跳过；落盘失败沿用静默语义，
 *  内存已生效、重开设置页 load 兜底） */
async function onImportConfirm(overwriteNames: string[]) {
  const plan = applyTemplateImport(importEntries.value, new Set(overwriteNames))
  if (plan.creates.length + plan.updates.length === 0) {
    message.info(t('settings.agentTaskTemplates.importDone', {
      created: 0, updated: 0, skipped: plan.skipped.length,
    }))
    return
  }
  await importTemplates(plan.creates, plan.updates)
  await fetchTemplates()
  message.success(t('settings.agentTaskTemplates.importDone', {
    created: plan.creates.length, updated: plan.updates.length, skipped: plan.skipped.length,
  }))
}
</script>

<template>
  <div
    class="agent-task-templates"
    data-testid="settings-agent-task-templates"
  >
    <div class="att-head">
      <span class="att-title">{{ t('settings.agentTaskTemplates.title') }}</span>
      <span class="att-head-actions">
        <n-button
          size="small"
          data-testid="agent-tpl-import"
          @click="importFileRef?.click()"
        >
          {{ t('settings.agentTaskTemplates.import') }}
        </n-button>
        <n-button
          size="small"
          data-testid="agent-tpl-export"
          :title="t('settings.agentTaskTemplates.exportTitle')"
          @click="exportSelected"
        >
          {{ t('settings.agentTaskTemplates.export') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          data-testid="agent-tpl-add"
          @click="openCreate"
        >
          <template #icon>
            <n-icon><AddOutline /></n-icon>
          </template>
          {{ t('settings.agentTaskTemplates.add') }}
        </n-button>
        <input
          ref="importFileRef"
          type="file"
          accept="application/json,.json"
          hidden
          @change="onImportFile"
        >
      </span>
    </div>
    <div class="att-hint">
      {{ t('settings.agentTaskTemplates.hint') }}
    </div>

    <!-- 新建 / 编辑表单（行内，SnippetManager 同款；与设置页「保存」链无关） -->
    <div
      v-if="formOpen"
      class="att-form"
    >
      <n-input
        v-model:value="formName"
        size="small"
        :placeholder="t('settings.agentTaskTemplates.fieldNamePlaceholder')"
        data-testid="agent-tpl-name"
      />
      <n-input
        v-model:value="formPrompt"
        size="small"
        type="textarea"
        :rows="3"
        :placeholder="t('settings.agentTaskTemplates.fieldPromptPlaceholder')"
        data-testid="agent-tpl-prompt"
      />
      <div
        v-if="formPrompt"
        class="att-form-count"
        :class="{ over: formPromptOver }"
      >
        {{ formPromptBytes }}/500
      </div>
      <div class="att-form-hint">
        {{ t('settings.agentTaskTemplates.formHint') }}
      </div>
      <div class="att-form-actions">
        <n-button
          size="small"
          @click="closeForm"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :loading="saving"
          data-testid="agent-tpl-save"
          @click="save"
        >
          {{ t('common.save') }}
        </n-button>
      </div>
    </div>

    <n-spin
      :show="loading"
      size="small"
    >
      <n-empty
        v-if="templates.length === 0"
        :description="t('settings.agentTaskTemplates.empty')"
        size="small"
      />
      <div
        v-else
        class="att-rows"
      >
        <div
          v-for="x in templates"
          :key="x.id"
          class="att-row"
          data-testid="agent-tpl-row"
        >
          <n-checkbox
            size="small"
            class="att-row-check"
            data-testid="agent-tpl-check"
            :checked="selectedIds.has(x.id)"
            :aria-label="t('settings.agentTaskTemplates.exportTitle')"
            @update:checked="v => toggleSelect(x.id, v)"
          />
          <div class="att-row-main">
            <div class="att-row-top">
              <span
                class="att-row-name"
                :title="x.name"
              >{{ x.name }}</span>
              <n-tag
                v-if="!customized"
                size="small"
                :bordered="false"
              >
                {{ t('settings.agentTaskTemplates.presetTag') }}
              </n-tag>
            </div>
            <div
              class="att-row-prompt"
              :title="x.prompt"
            >
              {{ x.prompt }}
            </div>
          </div>
          <div class="att-row-actions">
            <n-button
              size="tiny"
              quaternary
              :title="t('settings.agentTaskTemplates.moveUp')"
              @click="move(x, -1)"
            >
              <template #icon>
                <n-icon size="13"><ArrowUpOutline /></n-icon>
              </template>
            </n-button>
            <n-button
              size="tiny"
              quaternary
              :title="t('settings.agentTaskTemplates.moveDown')"
              @click="move(x, 1)"
            >
              <template #icon>
                <n-icon size="13"><ArrowDownOutline /></n-icon>
              </template>
            </n-button>
            <n-button
              size="tiny"
              quaternary
              :title="t('common.edit')"
              @click="openEdit(x)"
            >
              <template #icon>
                <n-icon size="13"><CreateOutline /></n-icon>
              </template>
            </n-button>
            <n-popconfirm
              @positive-click="remove(x)"
            >
              <template #trigger>
                <n-button
                  size="tiny"
                  quaternary
                  type="error"
                  :title="t('common.delete')"
                >
                  <template #icon>
                    <n-icon size="13">
                      <TrashOutline />
                    </n-icon>
                  </template>
                </n-button>
              </template>
              {{ t('settings.agentTaskTemplates.deleteConfirm', { name: x.name }) }}
            </n-popconfirm>
          </div>
        </div>
      </div>
    </n-spin>

    <!-- 导入冲突预览弹层：纯展示，同名逐项勾选覆盖，确认回宿主整批落盘 -->
    <AgentTaskTemplateImportModal
      v-model:show="showImportModal"
      :entries="importEntries"
      :invalid-count="importInvalidCount"
      @confirm="onImportConfirm"
    />
  </div>
</template>

<style scoped>
.agent-task-templates { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-default); }
.att-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.att-head-actions { display: inline-flex; align-items: center; gap: var(--space-1); }
.att-title { font-size: 13px; font-weight: var(--fw-semibold); color: var(--text-primary); }
.att-hint { font-size: var(--fs-meta-min, 11.5px); color: var(--text-secondary); margin-bottom: 10px; }
.att-form {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px; margin-bottom: 10px;
  border: 1px solid var(--border-default); border-radius: var(--radius-md);
  background: var(--bg-elevated);
}
.att-form-count { align-self: flex-end; font-size: var(--fs-meta-min, 11.5px); color: var(--text-secondary); }
.att-form-count.over { color: var(--accent-red); }
.att-form-hint { font-size: var(--fs-meta-min, 11.5px); color: var(--text-secondary); }
.att-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.att-rows { display: flex; flex-direction: column; gap: 6px; }
.att-row {
  display: flex; align-items: center; gap: var(--space-2);
  padding: 7px 10px;
  border: 1px solid var(--border-default); border-radius: var(--radius-md);
}
.att-row-check { flex-shrink: 0; }
.att-row-main { flex: 1; min-width: 0; }
.att-row-top { display: flex; align-items: center; gap: 6px; }
.att-row-name {
  font-size: 12px; font-weight: var(--fw-semibold); color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.att-row-prompt {
  margin-top: 2px;
  font-size: var(--fs-meta-min, 11.5px); color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.att-row-actions { display: flex; gap: 2px; flex-shrink: 0; }
</style>
