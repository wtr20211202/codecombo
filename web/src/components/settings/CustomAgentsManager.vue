<script setup lang="ts">
/**
 * 自定义智能体运行时管理（设置 → 通用 → 智能体分区）：
 * 任意 CLI 智能体工具（gemini/aider 等）自取注册名 + 启动命令接入，
 * 保存即时同步进后端 Provider 注册表——新建会话下拉/可用性探测/默认
 * 智能体选型与内置运行时（claude/codex/dsh）走同一条链路，无需重启。
 * 变更后 emit('changed')，父级（SettingsModal）刷新运行时状态区与下拉。
 * 配置导出/导入（P-20261004-83）：纯 JSON 传播件（零敏感——launch 命令
 * 可引用环境变量名，不含凭据值），多实例/团队场景一键搬运；导出走客户端
 * blob 下载（exportFileName 同族命名），导入经文件选择 → 清洗 → 冲突
 * 预览弹层 → 逐条既有 CRUD 合并（服务端仍是事实源，失败逐条计数回告）。
 */
import { ref, onMounted } from 'vue'
import {
  NButton, NEmpty, NForm, NFormItem, NInput, NList, NListItem,
  NModal, NThing, NTag, useMessage,
} from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { customAgentApi, settingsApi, type CustomAgent } from '../../api/client'
import { confirmDialog } from '../../composables/useDialog'
import { exportFileName } from '../../utils/exportFileName'
import {
  buildAgentExportPayload, sanitizeAgentImport, planAgentImport, applyAgentImportPlan,
  type CustomAgentExportPayload, type AgentImportEntry, type AgentImportStrategy,
} from '../../utils/customAgentTransfer'
import CustomAgentsImportModal from './CustomAgentsImportModal.vue'

const emit = defineEmits<{ (e: 'changed'): void }>()

const { t } = useI18n()
const message = useMessage()

// 与后端 customAgentNameRe 校验同口径的前端预检（服务端仍是事实源）
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

const agents = ref<CustomAgent[]>([])
const showModal = ref(false)
const saving = ref(false)
/** 正在编辑的注册名（空 = 新增）；改名 = 表单 name 与此不同 */
const editingName = ref('')
const form = ref({ name: '', displayName: '', command: '' })

async function fetchAgents() {
  try {
    const res: any = await settingsApi.get()
    agents.value = (res?.data?.customAgents as CustomAgent[] | undefined) ?? []
  } catch {
    // 拦截器统一处理
  }
}

onMounted(fetchAgents)

function openAdd() {
  editingName.value = ''
  form.value = { name: '', displayName: '', command: '' }
  showModal.value = true
}

function edit(a: CustomAgent) {
  editingName.value = a.name
  form.value = { name: a.name, displayName: a.displayName || '', command: a.command }
  showModal.value = true
}

function validate(): string | null {
  if (!NAME_RE.test(form.value.name.trim())) {
    return t('settings.customAgents.nameInvalid')
  }
  if (!form.value.command.trim()) {
    return t('settings.customAgents.commandRequired')
  }
  // 与后端 200 上限同口径的前端预检：超长时后端只会给出笼统的 400
  if (form.value.command.trim().length > 200) {
    return t('settings.customAgents.commandTooLong')
  }
  if (form.value.displayName.trim().length > 60) {
    return t('settings.customAgents.displayNameTooLong')
  }
  return null
}

async function save() {
  const err = validate()
  if (err) {
    message.warning(err)
    return
  }
  saving.value = true
  try {
    const payload = {
      name: form.value.name.trim(),
      displayName: form.value.displayName.trim(),
      command: form.value.command.trim(),
    }
    const res: any = editingName.value
      ? await customAgentApi.update(editingName.value, payload)
      : await customAgentApi.create(payload)
    agents.value = (res?.data?.customAgents as CustomAgent[] | undefined) ?? agents.value
    message.success(t('common.saved'))
    showModal.value = false
    emit('changed')
  } catch (e: any) {
    message.error(e?.userMessage || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function remove(a: CustomAgent) {
  const ok = await confirmDialog({
    title: t('settings.customAgents.deleteConfirm', { name: a.displayName || a.name }),
    type: 'warning',
    confirmText: t('common.delete'),
  })
  if (!ok) return
  try {
    const res: any = await customAgentApi.remove(a.name)
    agents.value = (res?.data?.customAgents as CustomAgent[] | undefined) ?? []
    message.success(t('settings.customAgents.deleted'))
    emit('changed')
  } catch (e: any) {
    message.error(e?.userMessage || t('settings.customAgents.deleteFailed'))
  }
}

// ---- 配置导出/导入（P-20261004-83）----

const importFileRef = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const showImportModal = ref(false)
const importEntries = ref<AgentImportEntry[]>([])
/** 清洗阶段被丢弃的无效条目数（预览弹层知情注记） */
const importInvalidCount = ref(0)

/** 客户端合成 JSON 下载（WorkspaceBackup 同款 blob 链；命名走 exportFileName 导出族约定） */
function downloadAgentsJson(payload: CustomAgentExportPayload, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function exportAll() {
  if (agents.value.length === 0) {
    message.warning(t('settings.customAgents.exportEmpty'))
    return
  }
  downloadAgentsJson(
    buildAgentExportPayload(agents.value),
    exportFileName('custom-agents', new Date(), 'json', 'codecombo'),
  )
  message.success(t('settings.customAgents.exportDone', { n: agents.value.length }))
}

function exportOne(a: CustomAgent) {
  downloadAgentsJson(
    buildAgentExportPayload([a]),
    exportFileName(a.name, new Date(), 'json', 'codecombo-agent'),
  )
  message.success(t('settings.customAgents.exportDone', { n: 1 }))
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许重复选择同一文件
  if (!file || importing.value) return
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    message.error(t('settings.customAgents.importInvalid'))
    return
  }
  const result = sanitizeAgentImport(parsed)
  if (!result) {
    message.error(t('settings.customAgents.importInvalid'))
    return
  }
  if (result.agents.length === 0) {
    message.warning(t('settings.customAgents.importNone'))
    return
  }
  importInvalidCount.value = result.invalid
  importEntries.value = planAgentImport(result.agents, agents.value)
  showImportModal.value = true
}

/**
 * 执行导入计划：逐条走既有 CRUD（create 新增 / PUT 同名覆盖），失败逐条
 * 计数不中断批次（silent API 免拦截器 toast 刷屏，汇总一处回告）；
 * 完成后重拉全量列表以服务端为准，再 emit('changed') 刷新宿主运行时区。
 */
async function onImportConfirm(strategy: AgentImportStrategy) {
  const plan = applyAgentImportPlan(importEntries.value, strategy)
  if (plan.creates.length + plan.updates.length === 0) {
    message.info(t('settings.customAgents.importDone', {
      created: 0, updated: 0, skipped: plan.skipped.length, failed: 0,
    }))
    return
  }
  importing.value = true
  let failed = 0
  try {
    for (const a of plan.creates) {
      try {
        await customAgentApi.create(a)
      } catch { failed++ }
    }
    for (const a of plan.updates) {
      try {
        await customAgentApi.update(a.name, a)
      } catch { failed++ }
    }
  } finally {
    importing.value = false
    await fetchAgents()
    emit('changed')
    const summary = {
      created: plan.creates.length, updated: plan.updates.length,
      skipped: plan.skipped.length, failed,
    }
    if (failed > 0) message.warning(t('settings.customAgents.importDone', summary))
    else message.success(t('settings.customAgents.importDone', summary))
  }
}
</script>

<template>
  <div
    class="custom-agents-manager"
    data-testid="settings-custom-agents"
  >
    <div class="header">
      <h4>{{ t('settings.customAgents.title') }}</h4>
      <span class="header-actions">
        <NButton
          size="tiny"
          data-test="custom-agents-import"
          @click="importFileRef?.click()"
        >
          {{ t('settings.customAgents.import') }}
        </NButton>
        <NButton
          size="tiny"
          data-test="custom-agents-export-all"
          @click="exportAll"
        >
          {{ t('settings.customAgents.exportAll') }}
        </NButton>
        <NButton
          size="tiny"
          @click="openAdd"
        >
          {{ t('settings.customAgents.add') }}
        </NButton>
        <input
          ref="importFileRef"
          type="file"
          accept="application/json,.json"
          hidden
          @change="onImportFile"
        >
      </span>
    </div>
    <p class="hint">
      {{ t('settings.customAgents.hint') }}
    </p>

    <NList
      v-if="agents.length > 0"
      bordered
      class="agents-list"
    >
      <NListItem
        v-for="a in agents"
        :key="a.name"
      >
        <NThing>
          <template #header>
            <span class="display-name">{{ a.displayName || a.name }}</span>
            <NTag
              size="tiny"
              class="name-tag"
            >
              {{ a.name }}
            </NTag>
          </template>
          <template #description>
            <span
              class="command"
              :title="a.command"
            >{{ a.command }}</span>
          </template>
          <template #action>
            <span class="actions">
              <NButton
                size="tiny"
                quaternary
                data-test="custom-agents-export-one"
                @click="exportOne(a)"
              >
                {{ t('settings.customAgents.exportOne') }}
              </NButton>
              <NButton
                size="tiny"
                quaternary
                @click="edit(a)"
              >
                {{ t('common.edit') }}
              </NButton>
              <NButton
                size="tiny"
                quaternary
                type="error"
                @click="remove(a)"
              >
                {{ t('common.delete') }}
              </NButton>
            </span>
          </template>
        </NThing>
      </NListItem>
    </NList>
    <NEmpty
      v-else
      size="small"
      :description="t('settings.customAgents.empty')"
    />

    <!-- 新增 / 编辑弹窗：name / displayName(可选) / command -->
    <NModal
      v-model:show="showModal"
      preset="card"
      style="width: var(--modal-w-sm); max-width: 94vw"
    >
      <template #header>
        {{ editingName ? t('settings.customAgents.editTitle') : t('settings.customAgents.addTitle') }}
      </template>
      <NForm label-placement="top">
        <NFormItem :label="t('settings.customAgents.fieldName')">
          <NInput
            v-model:value="form.name"
            :placeholder="t('settings.customAgents.fieldNamePlaceholder')"
          />
        </NFormItem>
        <NFormItem :label="t('settings.customAgents.fieldDisplayName')">
          <NInput
            v-model:value="form.displayName"
            :placeholder="t('settings.customAgents.fieldDisplayNamePlaceholder')"
          />
        </NFormItem>
        <NFormItem :label="t('settings.customAgents.fieldCommand')">
          <NInput
            v-model:value="form.command"
            :placeholder="t('settings.customAgents.fieldCommandPlaceholder')"
            :maxlength="200"
            show-count
          />
        </NFormItem>
        <p class="form-hint">
          {{ t('settings.customAgents.formHint') }}
        </p>
      </NForm>
      <template #action>
        <div class="modal-actions">
          <NButton
            size="small"
            quaternary
            @click="showModal = false"
          >
            {{ t('common.cancel') }}
          </NButton>
          <NButton
            size="small"
            type="primary"
            :loading="saving"
            @click="save"
          >
            {{ t('common.save') }}
          </NButton>
        </div>
      </template>
    </NModal>

    <!-- 导入冲突预览弹层：纯展示，确认经 emit 回宿主执行既有 CRUD -->
    <CustomAgentsImportModal
      v-model:show="showImportModal"
      :entries="importEntries"
      :invalid-count="importInvalidCount"
      @confirm="onImportConfirm"
    />
  </div>
</template>

<style scoped>
.custom-agents-manager {
  margin-top: var(--space-3);
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-1);
}

.header h4 {
  margin: 0;
  font-size: 13px;
  font-weight: var(--fw-semibold);
}

.header-actions {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
}

.hint {
  color: var(--text-color-3);
  font-size: 12px;
  margin: 0 0 var(--space-2);
}

.agents-list {
  margin-bottom: var(--space-2);
}

.display-name {
  font-weight: var(--fw-semibold);
}

.name-tag {
  margin-left: var(--space-2);
  font-family: monospace;
}

.command {
  font-family: monospace;
  font-size: 12px;
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: inline-flex;
  gap: var(--space-1);
}

.form-hint {
  color: var(--text-color-3);
  font-size: 12px;
  margin: 0;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
