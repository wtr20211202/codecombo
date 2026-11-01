<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { NModal, NButton, NInput, NEmpty } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { computeBatchRename, type BatchRenameIssue } from '../../utils/batchRename'
import type { BatchRenamePair } from '../../composables/useBatchRename'

/**
 * 批量重命名弹层（P-20261003-283）：多选右键「批量重命名」入口的查找/替换
 * 输入 + 实时预览面。替换为字面串（仅叶子名，路径其余段不动）；预览行非法
 * 即红标（P-132 fileNameCompatIssue 同源 + 批内自有三类：空名/含分隔符/
 * 批内重名），非法行不上抛执行。纯选择器：确认后上抛有效对照对
 * （BatchRenamePair），逐个 renameFile 的执行链在宿主（useBatchRename，
 * 与批量移动 moveEntries 同款跳过报告语义）。
 */
const props = defineProps<{
  show: boolean
  /** 待改名条目路径（多选集合快照） */
  paths: string[]
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'apply', pairs: BatchRenamePair[]): void
}>()

const { t } = useI18n()

const find = ref('')
const replace = ref('')
const findInputRef = ref<InstanceType<typeof NInput> | null>(null)

// 预览行渲染上限：多选集合理论上可很大（Ctrl+A 全选可见层级），预览列表
// 全量渲染徒增 DOM；执行侧另有单批上限护栏（useBatchRename），截断注记
// 如实交代（MoveToDialog RENDER_CAP 同款惯例）
const RENDER_CAP = 200

const rows = computed(() => computeBatchRename(props.paths, find.value, replace.value))
// 仅展示命中行（未命中项不受影响，列出来是噪音）；渲染封顶防大集合卡顿
const changedRows = computed(() => rows.value.filter(r => r.changed))
const visibleRows = computed(() => changedRows.value.slice(0, RENDER_CAP))
const truncated = computed(() => changedRows.value.length > RENDER_CAP)
// 非法行不参与确认：确认数 = 合法行数（执行链照此逐个 renameFile）
const validRows = computed(() => changedRows.value.filter(r => !r.issue))
const canConfirm = computed(() => validRows.value.length > 0)

/** 预览行非法原因（红字）：P-132 两类复用既有文案键，批内自有三类本域键。
 *  issue 为 null（合法行）返回空串——模板 v-if 已保证红字只在非法行渲染 */
function issueText(issue: BatchRenameIssue | null, newName: string): string {
  switch (issue) {
    case 'reservedWindowsName': return t('fileTree.nameReservedWindows', { name: newName })
    case 'trailingDotSpace': return t('fileTree.nameTrailingDotSpace', { name: newName })
    case 'emptyName': return t('fileTree.batchRename.emptyName')
    case 'sepInName': return t('fileTree.batchRename.sepInName')
    case 'collision': return t('fileTree.batchRename.skipCollision')
    default: return ''
  }
}

function confirm() {
  if (!canConfirm.value) return
  emit('apply', validRows.value.map(r => ({ oldPath: r.path, newPath: r.path.slice(0, r.path.length - r.name.length) + r.newName })))
}

watch(() => props.show, async (show) => {
  if (show) {
    find.value = ''
    replace.value = ''
    await nextTick()
    findInputRef.value?.focus()
  }
})
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('fileTree.batchRename.title', { n: props.paths.length })"
    :style="{ width: 'var(--modal-w-md)', maxWidth: '94vw' }"
    :bordered="false"
    class="batch-rename-modal"
    data-testid="batch-rename-modal"
    @update:show="emit('update:show', $event)"
  >
    <div class="batch-rename-body">
      <div class="batch-rename-inputs">
        <div class="batch-rename-field">
          <span class="batch-rename-label">{{ t('fileTree.batchRename.find') }}</span>
          <n-input
            ref="findInputRef"
            v-model:value="find"
            size="small"
            clearable
            :placeholder="t('fileTree.batchRename.findPlaceholder')"
            data-testid="batch-rename-find"
          />
        </div>
        <div class="batch-rename-field">
          <span class="batch-rename-label">{{ t('fileTree.batchRename.replace') }}</span>
          <n-input
            v-model:value="replace"
            size="small"
            clearable
            :placeholder="t('fileTree.batchRename.replacePlaceholder')"
            data-testid="batch-rename-replace"
          />
        </div>
      </div>
      <div class="batch-rename-list">
        <n-empty
          v-if="changedRows.length === 0"
          :description="t('fileTree.batchRename.empty')"
          size="small"
          class="batch-rename-empty"
        />
        <template v-else>
          <div
            v-for="r in visibleRows"
            :key="r.path"
            class="batch-rename-row"
            :class="{ illegal: !!r.issue }"
            data-testid="batch-rename-row"
          >
            <div class="batch-rename-names">
              <span
                class="batch-rename-old"
                :title="r.path"
              >{{ r.name }}</span>
              <span class="batch-rename-arrow">→</span>
              <span
                class="batch-rename-new"
                :title="issueText(r.issue, r.newName) || r.newName"
              >{{ r.newName }}</span>
            </div>
            <div
              v-if="r.issue"
              class="batch-rename-issue"
              data-testid="batch-rename-issue"
            >
              {{ issueText(r.issue, r.newName) }}
            </div>
          </div>
          <div
            v-if="truncated"
            class="batch-rename-truncated"
          >
            {{ t('fileTree.batchRename.truncated', { n: RENDER_CAP }) }}
          </div>
        </template>
      </div>
      <div class="batch-rename-footer">
        <n-button
          type="primary"
          size="small"
          :disabled="!canConfirm"
          data-testid="batch-rename-confirm"
          @click="confirm"
        >
          {{ t('fileTree.batchRename.confirm', { n: validRows.length }) }}
        </n-button>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.batch-rename-body { display: flex; flex-direction: column; gap: 10px; }
.batch-rename-inputs { display: flex; flex-direction: column; gap: 8px; }
.batch-rename-field { display: flex; align-items: center; gap: 8px; }
.batch-rename-label {
  flex: 0 0 56px; font-size: 12px; color: var(--text-secondary);
  text-align: right; white-space: nowrap;
}
.batch-rename-field :deep(.n-input) { flex: 1; }
.batch-rename-list {
  height: 280px; overflow-y: auto;
  border: 1px solid var(--border-default); border-radius: 4px;
  padding: 4px 0;
}
.batch-rename-empty { display: flex; align-items: center; justify-content: center; height: 100%; }
.batch-rename-row { padding: 5px 10px; font-size: 13px; }
.batch-rename-row:hover { background: var(--bg-hover); }
.batch-rename-names { display: flex; align-items: center; gap: 6px; min-width: 0; }
.batch-rename-old, .batch-rename-new {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.batch-rename-old { color: var(--text-secondary); }
.batch-rename-arrow { color: var(--text-dim); flex-shrink: 0; }
.batch-rename-new { color: var(--text-body); font-weight: 500; }
.batch-rename-row.illegal .batch-rename-new { color: var(--accent-red); }
.batch-rename-issue { font-size: 11px; color: var(--accent-red); margin-top: 2px; }
.batch-rename-truncated { padding: 6px 10px; font-size: 11px; color: var(--text-dim); }
.batch-rename-footer { display: flex; justify-content: flex-end; }
</style>
