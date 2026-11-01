<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NCheckbox, NCheckboxGroup, NModal, NSpin, useMessage } from 'naive-ui'
import { branchApi } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { useProjectStore } from '../../stores/project'

/**
 * 清理已合并分支向导（P-20261003-50）：只列出「已合并进当前 HEAD」的本地分支
 * （服务端 mergedBranchSet 数据源已在源头排除当前分支），主干保护名单（main/master）
 * 硬排除；多选框默认全不选——批量删除是破坏性操作，必须显式勾选。
 * 删除复用 DeleteBranch 非强制（git branch -d）：清单误判（或分支被其他工作树
 * 检出）时 git 天然拒绝，逐项失败保底。
 * 数据链路自含（同 ChangelogDraftModal 模式）：宿主只负责开合，收 cleaned 事件刷新分支树。
 */
const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'cleaned'): void
}>()

const message = useMessage()
const { t } = useI18n()
const projectStore = useProjectStore()

// 主干保护名单：与 GitHub Desktop「清理已合并分支」对齐，主干分支永不进清单。
// 只按名字匹配（main/master 是事实主干约定名）；其余非常规主干的场景由
// 「非强制删除 + 用户显式勾选」双重兜底。
const PROTECTED_BRANCHES = new Set(['main', 'master'])

const candidates = ref<{ name: string }[]>([])
const loading = ref(false)
const cleaning = ref(false)
const selected = ref<string[]>([])

const candidateNames = computed(() => candidates.value.map(b => b.name))
const allSelected = computed(() =>
  candidateNames.value.length > 0 && selected.value.length === candidateNames.value.length)
const someSelected = computed(() =>
  selected.value.length > 0 && selected.value.length < candidateNames.value.length)

async function fetchCandidates() {
  if (!projectStore.currentProjectId) return
  loading.value = true
  try {
    const res: any = await branchApi.list(projectStore.currentProjectId)
    candidates.value = ((res.data || []) as { name: string; isMerged?: boolean; isCurrent?: boolean; isRemote?: boolean }[])
      .filter(b => b.isMerged && !b.isCurrent && !b.isRemote && !PROTECTED_BRANCHES.has(b.name))
      .map(b => ({ name: b.name }))
    // 每次打开/刷新重置勾选（默认全不选，不记忆上次勾选——清单内容已变）
    selected.value = []
  } catch { /* 拦截器处理 */ } finally {
    loading.value = false
  }
}

watch(() => props.show, (show) => {
  if (show) void fetchCandidates()
})

function onCheckAll(checked: boolean) {
  selected.value = checked ? [...candidateNames.value] : []
}

async function requestCleanup() {
  if (selected.value.length === 0 || cleaning.value) return
  const names = [...selected.value]
  const ok = await confirmDialog({
    title: t('git.branchCleanup.confirmTitle'),
    content: t('git.branchCleanup.confirmBody', { count: names.length }),
    confirmText: t('git.branchCleanup.deleteBtn'),
  })
  if (!ok) return
  if (!projectStore.currentProjectId) return
  cleaning.value = true
  let done = 0
  let failed = 0
  for (const name of names) {
    try {
      // silent：批量场景逐项弹错误 toast 会刷屏，失败聚合到结果提示
      await branchApi.delete(projectStore.currentProjectId, name, false, { silent: true })
      done++
    } catch {
      // git 拒绝（未完全合并/被工作树检出）= 安全兜底；刷新后失败分支仍在清单外/清单内可见
      failed++
    }
  }
  cleaning.value = false
  if (failed === 0) message.success(t('git.branchCleanup.done', { ok: done }))
  else message.warning(t('git.branchCleanup.partial', { ok: done, fail: failed }))
  emit('cleaned')
  await fetchCandidates()
  // 全部清理完自动收起；有失败项则保留弹窗让用户看清剩余
  if (candidates.value.length === 0) emit('update:show', false)
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="t('git.branchCleanup.title')"
    style="width: var(--modal-w-sm); max-width: 94vw"
    :mask-closable="!cleaning"
    data-testid="branch-cleanup-modal"
    @update:show="emit('update:show', $event)"
  >
    <div class="cleanup-hint">
      {{ t('git.branchCleanup.hint') }}
    </div>
    <div
      v-if="loading"
      class="cleanup-loading"
    >
      <n-spin size="small" />
    </div>
    <div
      v-else-if="candidates.length === 0"
      class="cleanup-empty"
      data-testid="branch-cleanup-empty"
    >
      {{ t('git.branchCleanup.empty') }}
    </div>
    <template v-else>
      <n-checkbox-group v-model:value="selected">
        <div class="cleanup-row cleanup-header">
          <n-checkbox
            :checked="allSelected"
            :indeterminate="someSelected"
            data-testid="branch-cleanup-select-all"
            @update:checked="onCheckAll"
          >
            {{ t('git.branchCleanup.selectAll') }}
          </n-checkbox>
        </div>
        <div
          v-for="b in candidates"
          :key="b.name"
          class="cleanup-row"
          data-testid="branch-cleanup-item"
        >
          <n-checkbox
            :value="b.name"
            :label="b.name"
          />
        </div>
      </n-checkbox-group>
    </template>
    <div class="cleanup-footer">
      <span class="cleanup-count">{{ t('git.branchCleanup.selectedCount', { n: selected.length }) }}</span>
      <div style="flex: 1" />
      <n-button
        size="small"
        :disabled="cleaning"
        @click="emit('update:show', false)"
      >
        {{ t('common.cancel') }}
      </n-button>
      <n-button
        size="small"
        type="error"
        data-testid="branch-cleanup-confirm"
        :disabled="selected.length === 0"
        :loading="cleaning"
        @click="requestCleanup"
      >
        {{ t('git.branchCleanup.deleteBtn') }}
      </n-button>
    </div>
  </n-modal>
</template>

<style scoped>
.cleanup-hint { font-size: 12px; color: var(--text-dim); margin-bottom: 10px; }
.cleanup-loading { padding: 24px; text-align: center; }
.cleanup-empty { padding: 24px; text-align: center; font-size: 13px; color: var(--text-dim); }
.cleanup-row { padding: 6px var(--space-1); border-bottom: 1px solid color-mix(in srgb, var(--border-default) 20%, transparent); }
.cleanup-header { font-weight: var(--fw-medium); }
.cleanup-footer { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-3); }
.cleanup-count { font-size: 12px; color: var(--text-secondary); }
</style>
