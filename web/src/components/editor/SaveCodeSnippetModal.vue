<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NInput, NModal, NTag, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { snippetApi, type SnippetKind } from '../../api/client'

/**
 * 保存为片段弹窗（P-20261002-44）：Monaco 选区右键「保存为片段」的表单。
 * 纯表单组件：选区文本/语言由宿主（MonacoEditor）捕获后经 props 注入，
 * 提交走既有 CreateSnippet，结果 toast 自理、saved 事件通知宿主刷新。
 * P-20261003-199 泛化双域：kind 缺省 code（编辑器路径零变化）；
 * 历史面板「重复命令」传 kind=command 复用同一创建链（无语言行、可预填标题）。
 */
const props = defineProps<{
  /** 待保存的选区文本（打开前由宿主校验非空/长度） */
  content: string
  /** 片段种类：code（默认，编辑器域）/ command（终端命令域） */
  kind?: SnippetKind
  /** 当前文件语言（monaco language id，只读展示；随片段存储用于插入侧过滤；仅 code 域） */
  language?: string
  /** 预填标题（command 域「存为片段」带出命令原文，免手敲；code 域不传保持空表单） */
  initialTitle?: string
}>()

const show = defineModel<boolean>('show', { required: true })

const emit = defineEmits<{
  (e: 'saved'): void
}>()

const { t } = useI18n()
const message = useMessage()

const isCode = computed(() => (props.kind ?? 'code') === 'code')

const formTitle = ref('')
const formDesc = ref('')
const saving = ref(false)

watch(show, (v) => {
  if (!v) return
  formTitle.value = props.initialTitle || ''
  formDesc.value = ''
})

async function save() {
  if (!formTitle.value.trim()) {
    message.warning(t('snippet.code.titleRequired'))
    return
  }
  saving.value = true
  try {
    await snippetApi.create({
      title: formTitle.value.trim(),
      command: props.content,
      description: formDesc.value.trim() || undefined,
      kind: isCode.value ? 'code' : 'command',
      language: isCode.value ? (props.language || undefined) : undefined,
    })
    message.success(isCode.value ? t('snippet.code.saved') : t('snippet.command.saved'))
    show.value = false
    emit('saved')
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('snippet.code.saveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    class="scsnip-save-modal"
    :title="isCode ? t('snippet.code.saveTitle') : t('snippet.command.saveTitle')"
    :bordered="false"
    size="small"
    data-testid="snippet-save-modal"
  >
    <div class="scsnip-form">
      <div
        v-if="isCode"
        class="scsnip-lang-row"
      >
        <span class="scsnip-lang-label">{{ t('snippet.code.languageLabel') }}</span>
        <n-tag
          size="small"
          :bordered="false"
          data-testid="snippet-save-language"
        >
          {{ language || 'plaintext' }}
        </n-tag>
      </div>
      <n-input
        v-model:value="formTitle"
        size="small"
        :placeholder="t('snippet.code.fieldTitle')"
        data-testid="snippet-save-title"
        @keyup.enter="save"
      />
      <n-input
        v-model:value="formDesc"
        size="small"
        :placeholder="t('snippet.code.fieldDesc')"
      />
      <pre
        class="scsnip-content-preview"
        data-testid="snippet-save-content"
      >{{ content }}</pre>
    </div>
    <template #footer>
      <div class="scsnip-actions">
        <n-button
          size="small"
          @click="show = false"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :loading="saving"
          data-testid="snippet-save-confirm"
          @click="save"
        >
          {{ t('common.save') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.scsnip-form { display: flex; flex-direction: column; gap: 8px; }
.scsnip-lang-row { display: flex; align-items: center; gap: 8px; }
.scsnip-lang-label { font-size: 12px; color: var(--text-secondary); }
.scsnip-content-preview {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-panel);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}
.scsnip-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
