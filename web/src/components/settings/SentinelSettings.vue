<script setup lang="ts">
/**
 * 输出哨兵管理（设置 → 输出哨兵分区，P-20261004-8）：
 * 用户自定义终端输出模式订阅规则（盯 OOM/盯死锁/盯特定测试失败），命中由服务端
 * 输出 tap 入账通知中心（每规则 5min 防抖，Action 直达触发会话）。本组件承载
 * CRUD（≤10 条护栏：按钮禁用 + 服务端同界拒绝）；变更即时生效，无保存按钮
 * （即时操作分区，AgentCronSettings 同款形态）。
 */
import { ref, computed, onMounted } from 'vue'
import {
  NButton, NEmpty, NForm, NFormItem, NInput, NList, NListItem,
  NModal, NSelect, NTag, NThing, useMessage,
} from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { sentinelApi, type SentinelRule, type SentinelRuleInput } from '../../api/domains/sentinel'
import SentinelTestBox from './SentinelTestBox.vue'
import { projectApi } from '../../api/domains/git'
import { confirmDialog } from '../../composables/useDialog'

const { t } = useI18n()
const message = useMessage()

// 与服务端 SentinelMaxRules 同口径的前端护栏（服务端仍是事实源）
const MAX_RULES = 10

const rules = ref<SentinelRule[]>([])
const projects = ref<Array<{ id: string; name: string }>>([])
const showModal = ref(false)
const saving = ref(false)
/** 正在编辑的规则 ID（空 = 新增） */
const editingId = ref('')

const form = ref({
  name: '',
  pattern: '',
  scope: 'global',
  level: 'warning',
})

const atCap = computed(() => rules.value.length >= MAX_RULES)

const levelOptions = computed(() => [
  { label: t('sentinel.level.info'), value: 'info' },
  { label: t('sentinel.level.warning'), value: 'warning' },
  { label: t('sentinel.level.error'), value: 'error' },
])

const scopeOptions = computed(() => [
  { label: t('sentinel.scopeGlobal'), value: 'global' },
  ...projects.value.map(p => ({ label: p.name, value: p.id })),
])

async function fetchRules() {
  try {
    const res: any = await sentinelApi.list()
    rules.value = res?.data ?? []
  } catch { /* 拦截器统一处理 */ }
}

async function loadProjects() {
  try {
    const res: any = await projectApi.list()
    projects.value = (res?.data ?? []).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))
  } catch { /* 作用域下拉缺项目项不影响 global */ }
}

onMounted(() => {
  void fetchRules()
  void loadProjects()
})

function openAdd() {
  editingId.value = ''
  form.value = { name: '', pattern: '', scope: 'global', level: 'warning' }
  showModal.value = true
}

function edit(item: SentinelRule) {
  editingId.value = item.id
  form.value = {
    name: item.name,
    pattern: item.pattern,
    scope: item.scope || 'global',
    level: item.level || 'warning',
  }
  showModal.value = true
}

/** 客户端正则预检（JS 语法与 RE2 高度重叠，拦截手误；服务端编译校验仍是事实源） */
function patternError(pattern: string): string | null {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern)
    return null
  } catch {
    return t('sentinel.patternInvalid')
  }
}

function validate(): string | null {
  if (!form.value.name.trim()) return t('sentinel.nameRequired')
  if (form.value.name.trim().length > 120) return t('sentinel.nameTooLong')
  if (!form.value.pattern.trim()) return t('sentinel.patternRequired')
  if (form.value.pattern.length > 512) return t('sentinel.patternTooLong')
  return patternError(form.value.pattern)
}

async function save() {
  const err = validate()
  if (err) {
    message.warning(err)
    return
  }
  saving.value = true
  try {
    const payload: SentinelRuleInput = {
      name: form.value.name.trim(),
      pattern: form.value.pattern,
      scope: form.value.scope || 'global',
      level: form.value.level,
    }
    const res: any = editingId.value
      ? await sentinelApi.update(editingId.value, payload)
      : await sentinelApi.create(payload)
    if (res?.data) {
      await fetchRules()
    }
    message.success(t('common.saved'))
    showModal.value = false
  } catch (e: any) {
    message.error(e?.userMessage || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function remove(item: SentinelRule) {
  const ok = await confirmDialog({
    title: t('sentinel.deleteConfirm', { name: item.name }),
    type: 'warning',
    confirmText: t('common.delete'),
  })
  if (!ok) return
  try {
    await sentinelApi.remove(item.id)
    await fetchRules()
    message.success(t('sentinel.deleted'))
  } catch (e: any) {
    message.error(e?.userMessage || t('sentinel.deleteFailed'))
  }
}

/** 作用域展示名：global / 项目名（项目已删时回落 ID） */
function scopeLabel(scope: string): string {
  if (!scope || scope === 'global') return t('sentinel.scopeGlobal')
  return projects.value.find(p => p.id === scope)?.name || scope
}
</script>

<template>
  <div
    class="sentinel-manager"
    data-testid="sentinel-manager"
  >
    <div class="header">
      <h4>{{ t('sentinel.title') }}</h4>
      <NButton
        size="tiny"
        :disabled="atCap"
        data-testid="sentinel-add"
        @click="openAdd"
      >
        {{ t('sentinel.add') }}
      </NButton>
    </div>
    <p class="hint">
      {{ t('sentinel.hint') }}
    </p>
    <p
      v-if="atCap"
      class="hint cap-hint"
    >
      {{ t('sentinel.capReached', { n: MAX_RULES }) }}
    </p>

    <NList
      v-if="rules.length > 0"
      bordered
      class="rule-list"
      data-testid="sentinel-list"
    >
      <NListItem
        v-for="item in rules"
        :key="item.id"
        :data-testid="`sentinel-item-${item.name}`"
      >
        <NThing>
          <template #header>
            <span class="rule-name">{{ item.name }}</span>
            <NTag
              size="tiny"
              :type="item.level === 'error' ? 'error' : item.level === 'info' ? 'info' : 'warning'"
              class="level-tag"
            >
              {{ t(`sentinel.level.${item.level || 'warning'}`) }}
            </NTag>
          </template>
          <template #description>
            <div class="meta">
              <span
                class="scope"
                data-testid="sentinel-scope"
              >{{ scopeLabel(item.scope) }}</span>
              <code
                class="pattern"
                :title="item.pattern"
              >{{ item.pattern }}</code>
            </div>
          </template>
          <template #action>
            <span class="actions">
              <NButton
                size="tiny"
                quaternary
                @click="edit(item)"
              >
                {{ t('common.edit') }}
              </NButton>
              <NButton
                size="tiny"
                quaternary
                type="error"
                data-testid="sentinel-delete"
                @click="remove(item)"
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
      :description="t('sentinel.empty')"
    />

    <!-- 新增 / 编辑弹窗：名称 / 模式 / 作用域 / 级别 -->
    <NModal
      v-model:show="showModal"
      preset="card"
      style="width: var(--modal-w-md); max-width: 94vw"
    >
      <template #header>
        {{ editingId ? t('sentinel.editTitle') : t('sentinel.addTitle') }}
      </template>
      <NForm label-placement="top">
        <NFormItem :label="t('sentinel.fieldName')">
          <NInput
            v-model:value="form.name"
            :placeholder="t('sentinel.fieldNamePlaceholder')"
            :maxlength="120"
            data-testid="sentinel-form-name"
          />
        </NFormItem>
        <NFormItem :label="t('sentinel.fieldPattern')">
          <NInput
            v-model:value="form.pattern"
            type="textarea"
            :rows="3"
            class="pattern-input"
            :placeholder="t('sentinel.fieldPatternPlaceholder')"
            data-testid="sentinel-form-pattern"
          />
          <span
            v-if="form.pattern && patternError(form.pattern)"
            class="pattern-err"
          >{{ patternError(form.pattern) }}</span>
        </NFormItem>
        <NFormItem :label="t('sentinel.fieldScope')">
          <NSelect
            v-model:value="form.scope"
            :options="scopeOptions"
            size="small"
            data-testid="sentinel-form-scope"
          />
        </NFormItem>
        <NFormItem :label="t('sentinel.fieldLevel')">
          <NSelect
            v-model:value="form.level"
            :options="levelOptions"
            size="small"
          />
        </NFormItem>
        <p class="form-hint">
          {{ t('sentinel.formHint') }}
        </p>
        <!-- 试跑测试框（P-20261004-20）：贴样例试命中，先试后存——只读消费当前 pattern，
             不参与保存链（P-20261004-8 的 CRUD/校验逻辑零改动） -->
        <SentinelTestBox :pattern="form.pattern" />
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
            data-testid="sentinel-form-save"
            @click="save"
          >
            {{ t('common.save') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.sentinel-manager {
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

.hint {
  color: var(--text-color-3);
  font-size: 12px;
  margin: 0 0 var(--space-2);
}

.cap-hint { color: var(--accent-red); }

.rule-list {
  margin-bottom: var(--space-2);
}

.rule-name {
  font-weight: var(--fw-semibold);
}

.level-tag {
  margin-left: var(--space-2);
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
  color: var(--text-color-3);
}

.scope { color: var(--text-color-2); }

.pattern {
  font-family: monospace;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.pattern-input :deep(textarea) {
  font-family: monospace;
}

.pattern-err {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--accent-red);
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
