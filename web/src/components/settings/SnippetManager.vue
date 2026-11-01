<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  NButton, NInput, NTag, NIcon, NPopconfirm, NEmpty, NSpin, NTabs, NTab, useMessage,
} from 'naive-ui'
import { AddOutline, CreateOutline, TrashOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { snippetApi, isCodeSnippet, type Snippet, type SnippetKind } from '../../api/client'

/**
 * 命令片段管理（C2）：挂在设置 → 终端下的区块。
 * 列表 + 新建/编辑/删除；系统预置片段不可删除（可编辑内容实现"改出副本"效果）。
 * Kind 页签分区（P-20261002-44）：命令片段（终端消费）/ 代码片段（编辑器消费）
 * 分开管理；新建落在当前页签的种类上，编辑保持片段自身种类不变。
 */
const { t } = useI18n()
const message = useMessage()

const snippets = ref<Snippet[]>([])
const loading = ref(false)
const saving = ref(false)
// Kind 页签：当前管理的片段种类（新建默认落到它）
const activeKind = ref<SnippetKind>('command')
// 编辑中的片段（null = 非编辑态）；formOpen 控制表单显隐
const editingId = ref<string | null>(null)
const editingKind = ref<SnippetKind>('command')
const formOpen = ref(false)
const formTitle = ref('')
const formCommand = ref('')
const formDesc = ref('')
const formLanguage = ref('')

// 当前页签的片段（旧数据无 kind 一律视为命令片段）
const kindSnippets = computed(() =>
  snippets.value.filter(s => isCodeSnippet(s) === (activeKind.value === 'code')))

const formIsCode = computed(() => (editingId.value ? editingKind.value === 'code' : activeKind.value === 'code'))

async function fetchSnippets() {
  loading.value = true
  try {
    const res = await snippetApi.list({ silent: true })
    snippets.value = res.data || []
  } catch { /* silent */ } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  editingKind.value = activeKind.value
  formTitle.value = ''
  formCommand.value = ''
  formDesc.value = ''
  formLanguage.value = ''
  formOpen.value = true
}

function openEdit(s: Snippet) {
  editingId.value = s.id
  editingKind.value = isCodeSnippet(s) ? 'code' : 'command'
  formTitle.value = s.title
  formCommand.value = s.command
  formDesc.value = s.description || ''
  formLanguage.value = s.language || ''
  formOpen.value = true
}

function closeForm() {
  formOpen.value = false
  editingId.value = null
}

async function save() {
  if (!formTitle.value.trim() || !formCommand.value.trim()) {
    message.warning(t('settings.snippet.required'))
    return
  }
  saving.value = true
  try {
    const payload = {
      title: formTitle.value.trim(),
      command: formCommand.value.trim(),
      description: formDesc.value.trim(),
      // 种类在编辑时保持片段自身、新建时落当前页签；language 仅 code 片段携带
      kind: formIsCode.value ? 'code' as const : 'command' as const,
      language: formIsCode.value ? formLanguage.value.trim() : '',
    }
    if (editingId.value) {
      await snippetApi.update(editingId.value, payload)
    } else {
      await snippetApi.create(payload)
    }
    message.success(t('settings.snippet.saved'))
    closeForm()
    await fetchSnippets()
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('settings.snippet.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function remove(s: Snippet) {
  try {
    await snippetApi.remove(s.id)
    message.success(t('settings.snippet.deleted'))
    await fetchSnippets()
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('settings.snippet.deleteFailed'))
  }
}

onMounted(fetchSnippets)
</script>

<template>
  <div class="snippet-manager">
    <div class="snippet-manager-head">
      <span class="snippet-manager-title">{{ t('settings.snippet.title') }}</span>
      <n-button
        size="small"
        type="primary"
        @click="openCreate"
      >
        <template #icon>
          <n-icon><AddOutline /></n-icon>
        </template>
        {{ t('settings.snippet.add') }}
      </n-button>
    </div>

    <!-- Kind 页签分区（P-20261002-44）：命令片段 / 代码片段分开管理（NTab 无面板
         形态——列表/表单在页签外共用，仅切换过滤种类） -->
    <n-tabs
      v-model:value="activeKind"
      type="segment"
      size="small"
      class="snippet-kind-tabs"
      data-testid="snippet-kind-tabs"
    >
      <n-tab name="command">
        {{ t('snippet.code.tabCommands') }}
      </n-tab>
      <n-tab name="code">
        {{ t('snippet.code.tabCode') }}
      </n-tab>
    </n-tabs>

    <!-- 新建 / 编辑表单 -->
    <div
      v-if="formOpen"
      class="snippet-form"
    >
      <n-input
        v-model:value="formTitle"
        size="small"
        :placeholder="t('settings.snippet.fieldTitle')"
      />
      <n-input
        v-model:value="formCommand"
        size="small"
        type="textarea"
        :rows="2"
        :placeholder="formIsCode ? t('snippet.code.fieldContent') : t('settings.snippet.fieldCommand')"
        class="snippet-form-cmd"
      />
      <!-- 占位符语法提示（P-20261002-123）：仅命令片段（运行时填值；code 片段整段插入） -->
      <div
        v-if="!formIsCode"
        class="snippet-form-hint"
      >
        {{ t('settings.snippet.commandHint') }}
      </div>
      <!-- 插入时变量替换说明（P-20261006-1）：两种 kind 共用一行，$0 语义随域不同
           （code = 光标终位；command 终端无光标概念原样保留） -->
      <div class="snippet-form-hint">
        {{ formIsCode ? t('settings.snippet.varsHintCode') : t('settings.snippet.varsHintCommand') }}
      </div>
      <n-input
        v-if="formIsCode"
        v-model:value="formLanguage"
        size="small"
        :placeholder="t('snippet.code.fieldLanguage')"
        data-testid="snippet-form-language"
      />
      <n-input
        v-model:value="formDesc"
        size="small"
        :placeholder="t('settings.snippet.fieldDesc')"
      />
      <div class="snippet-form-actions">
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
        v-if="kindSnippets.length === 0"
        :description="t('settings.snippet.empty')"
        size="small"
      />
      <div
        v-else
        class="snippet-rows"
      >
        <div
          v-for="s in kindSnippets"
          :key="s.id"
          class="snippet-row"
        >
          <div class="snippet-row-main">
            <div class="snippet-row-top">
              <span class="snippet-row-title">{{ s.title }}</span>
              <n-tag
                v-if="isCodeSnippet(s) && s.language"
                size="small"
                :bordered="false"
                data-testid="snippet-row-language"
              >
                {{ s.language }}
              </n-tag>
              <n-tag
                v-if="s.isSystem"
                size="small"
                :bordered="false"
              >
                {{ t('settings.snippet.systemTag') }}
              </n-tag>
            </div>
            <div
              class="snippet-row-cmd"
              :title="s.command"
            >
              {{ s.command }}
            </div>
          </div>
          <div class="snippet-row-actions">
            <n-button
              size="tiny"
              quaternary
              :title="t('common.edit')"
              @click="openEdit(s)"
            >
              <template #icon>
                <n-icon size="13">
                  <CreateOutline />
                </n-icon>
              </template>
            </n-button>
            <n-popconfirm
              v-if="!s.isSystem"
              @positive-click="remove(s)"
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
              {{ t('settings.snippet.deleteConfirm', { title: s.title }) }}
            </n-popconfirm>
          </div>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.snippet-manager { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border-default); }
.snippet-manager-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.snippet-manager-title { font-size: 13px; font-weight: var(--fw-semibold); color: var(--text-primary); }
.snippet-kind-tabs { margin-bottom: 10px; }
.snippet-form {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px; margin-bottom: 10px;
  border: 1px solid var(--border-default); border-radius: var(--radius-md);
  background: var(--bg-elevated);
}
.snippet-form-cmd :deep(.n-input__textarea-el) { font-family: var(--font-mono, monospace); }
.snippet-form-hint { font-size: var(--fs-meta-min, 11.5px); color: var(--text-muted); }
.snippet-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.snippet-rows { display: flex; flex-direction: column; gap: 6px; }
.snippet-row {
  display: flex; align-items: center; gap: var(--space-2);
  padding: 7px 10px;
  border: 1px solid var(--border-default); border-radius: var(--radius-md);
}
.snippet-row-main { flex: 1; min-width: 0; }
.snippet-row-top { display: flex; align-items: center; gap: 6px; }
.snippet-row-title {
  font-size: 12px; font-weight: var(--fw-semibold); color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.snippet-row-cmd {
  margin-top: 2px;
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-meta-min, 11.5px); color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.snippet-row-actions { display: flex; gap: 2px; flex-shrink: 0; }
</style>
