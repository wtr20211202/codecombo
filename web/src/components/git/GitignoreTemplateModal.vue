<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NModal, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useProjectStore } from '../../stores/project'
import { useChangesStore } from '../../stores/changes'
import { projectApi } from '../../api/client'
import { GITIGNORE_TEMPLATES, gitignoreTemplateById } from './gitignoreTemplates'

/**
 * .gitignore 模板创建弹窗（P-20261002-76）：四套内置预设（Node/Go/Python/通用，
 * 常量表见 gitignoreTemplates.ts）单选 + 内容预览 + 确认创建。
 * 自含创建链路（createFile 写项目根 .gitignore → 刷新 status → 上抛 created），
 * 宿主（GitPanel 建议条）只负责开合与 created 后的自身状态对齐。
 * 注意：应用未全局注册 naive-ui，NModal 必须显式 import（历史回归教训）。
 */
const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'created'): void
}>()

const message = useMessage()
const { t } = useI18n()
const projectStore = useProjectStore()
const changesStore = useChangesStore()

// 每次打开复位到第一个预设，避免上次的选择跨项目残留
const DEFAULT_TEMPLATE_ID = GITIGNORE_TEMPLATES[0]!.id
const selectedId = ref(DEFAULT_TEMPLATE_ID)
watch(() => props.show, (v) => {
  if (v) selectedId.value = DEFAULT_TEMPLATE_ID
})

const selected = computed(() => gitignoreTemplateById(selectedId.value))

const creating = ref(false)

async function handleCreate() {
  const pid = projectStore.currentProjectId
  if (!pid || creating.value) return
  creating.value = true
  try {
    await projectApi.createFile(pid, '.gitignore', selected.value.content)
    message.success(t('git.ignoreSuggest.created'))
    // status 立即对齐：命中模板规则的产物转为被忽略，未跟踪计数下降
    // （WS file.changed 也会触发刷新，这里显式拉一次保证确定性）
    void changesStore.fetchStatus(pid)
    emit('created')
    emit('update:show', false)
  } catch { /* 拦截器已弹友好错误 */ } finally {
    creating.value = false
  }
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('git.ignoreSuggest.modalTitle')"
    :style="{ width: 'var(--modal-w-md)', maxWidth: '94vw' }"
    :bordered="false"
    :mask-closable="!creating"
    @update:show="emit('update:show', $event)"
  >
    <div class="git-tpl-list">
      <button
        v-for="tpl in GITIGNORE_TEMPLATES"
        :key="tpl.id"
        type="button"
        class="git-tpl-item"
        :class="{ selected: tpl.id === selectedId }"
        :data-testid="`gitignore-template-${tpl.id}`"
        @click="selectedId = tpl.id"
      >
        <span class="git-tpl-name">{{ tpl.name }}</span>
        <span class="git-tpl-desc">{{ t(tpl.descKey) }}</span>
      </button>
    </div>
    <div class="git-tpl-preview-wrap">
      <div class="git-tpl-preview-label">
        {{ t('git.ignoreSuggest.previewLabel') }}
      </div>
      <pre class="git-tpl-preview">{{ selected.content }}</pre>
    </div>
    <div class="git-tpl-footer">
      <n-button
        size="small"
        :disabled="creating"
        @click="emit('update:show', false)"
      >
        {{ t('common.cancel') }}
      </n-button>
      <n-button
        size="small"
        type="primary"
        :loading="creating"
        data-testid="gitignore-template-create"
        @click="handleCreate"
      >
        {{ t('git.ignoreSuggest.createBtn') }}
      </n-button>
    </div>
  </n-modal>
</template>

<style scoped>
/* 预设单选列表：两列栅格（四项恰好 2×2；弹窗定宽 560px 内保持稳定不换行） */
.git-tpl-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}
.git-tpl-item {
  text-align: left;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  padding: var(--space-2) 10px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
  transition: border-color var(--motion-base), background var(--motion-base);
}
.git-tpl-item:hover { border-color: var(--brand-accent); }
.git-tpl-item.selected {
  border-color: var(--brand-accent);
  background: var(--brand-accent-soft);
}
.git-tpl-name { font-size: 0.9em; font-weight: var(--fw-semibold); color: var(--text-primary); }
.git-tpl-desc {
  font-size: 0.8em;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* 内容预览：等宽字体滚动区，规则文本原样展示 */
.git-tpl-preview-wrap {
  margin-top: 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.git-tpl-preview-label {
  padding: var(--space-1) 10px;
  font-size: 0.78em;
  color: var(--text-dim);
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-default);
}
.git-tpl-preview {
  margin: 0;
  padding: var(--space-2) 10px;
  max-height: 180px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 0.8em;
  line-height: 1.5;
  color: var(--text-body);
  white-space: pre;
}

.git-tpl-footer {
  margin-top: var(--space-3);
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
