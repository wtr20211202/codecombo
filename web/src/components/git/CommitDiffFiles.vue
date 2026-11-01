<script setup lang="ts">
import { ref, computed, inject } from 'vue'
import { NDropdown, NSpin, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { getStatusColor, getStatusLabel } from '../../utils/git'
import { copyText } from '../../utils/clipboard'
import type { FlatDiffRow } from '../../utils/diffTree'
import FileHistoryModal from './FileHistoryModal.vue'

/**
 * 提交变更文件树（选中一个/多个提交后的右侧面板）：目录树 + 变更状态 +
 * 文件行右键菜单（在编辑器中打开 / 查看文件历史 / 查看此次变更 diff /
 * 与 HEAD 对比 / 在文件树中定位 / 复制路径）。
 * 双击行 = 查看此次变更 diff（与右键项同语义，保留既有习惯）。
 * diff 区间由宿主给定：单选 = hash^..hash，多选 = oldest^..newest。
 * 样式与 CommitsPanel 的 diff-* 同视觉（commits-panel.css 是 scoped 引入、
 * data-v 不穿透子组件——本组件自带一份同名 scoped 样式）
 */
const props = defineProps<{
  projectId: string
  rows: FlatDiffRow[]
  loading: boolean
  fileCount: number
  /** 多选提交数（>1 时显示合并视图提示） */
  selectedCount: number
  /** diff 区间端点（列表序最旧/最新），宿主按选中集计算 */
  oldestHash: string
  newestHash: string
  expandedDirs: Set<string>
}>()

const emit = defineEmits<{
  (e: 'open-diff', file: { path: string; name: string; oldRef: string; newRef: string }): void
  (e: 'toggle-dir', path: string): void
}>()

const { t } = useI18n()
const message = useMessage()

// 宿主链路注入：文件树定位 / 编辑器打开（useLayoutBridge 提供，项目页内可用）
const revealInFileTree = inject<(path: string) => void>('revealInFileTree')
const openFileInEditor = inject<(path: string) => void>('openFileInEditor')

function fileName(row: FlatDiffRow): string {
  return row.file?.name || row.path.split('/').pop() || row.path
}

function diffRange(): { oldRef: string; newRef: string } {
  // 多选区间与既有双击语义一致：oldest^ → newest
  return { oldRef: props.oldestHash ? props.oldestHash + '^' : '', newRef: props.newestHash }
}

function openChangeDiff(path: string, name: string) {
  const r = diffRange()
  if (!r.oldRef || !r.newRef) return
  emit('open-diff', { path, name, oldRef: r.oldRef, newRef: r.newRef })
}

function handleFileDblClick(row: FlatDiffRow) {
  if (!row.file) return
  openChangeDiff(row.path, fileName(row))
}

// ============== 文件行右键菜单 ==============
const ctxFile = ref<{ path: string; name: string } | null>(null)
const ctxX = ref(0)
const ctxY = ref(0)
const showCtx = ref(false)
const showHistory = ref(false)

function handleContextMenu(e: MouseEvent, row: FlatDiffRow) {
  if (!row.file) return
  e.preventDefault()
  ctxFile.value = { path: row.path, name: fileName(row) }
  ctxX.value = e.clientX
  ctxY.value = e.clientY
  showCtx.value = true
}

const ctxOptions = computed(() => [
  { label: t('commits.fileCtxOpenEditor'), key: 'open-editor' },
  { label: t('commits.fileCtxHistory'), key: 'history' },
  { label: t('commits.fileCtxChangeDiff'), key: 'change-diff' },
  { label: t('commits.fileCtxCompareHead'), key: 'compare-head' },
  { label: t('changes.locateInTree'), key: 'locate' },
  { label: t('breadcrumb.copyPath'), key: 'copy-path' },
])

function handleCtxSelect(key: string | number) {
  showCtx.value = false
  const f = ctxFile.value
  if (!f) return
  switch (key) {
    case 'open-editor':
      openFileInEditor?.(f.path)
      break
    case 'history':
      showHistory.value = true
      break
    case 'change-diff':
      openChangeDiff(f.path, f.name)
      break
    case 'compare-head': {
      // 该文件从选中区间起点到 HEAD 的演变；起点与此次变更 diff 同源
      const r = diffRange()
      if (r.oldRef) emit('open-diff', { path: f.path, name: f.name, oldRef: r.oldRef, newRef: 'HEAD' })
      break
    }
    case 'locate':
      revealInFileTree?.(f.path)
      break
    case 'copy-path':
      void copyText(f.path).then(ok => {
        if (ok) message.success(t('commits.pathCopied'))
        else message.error(t('common.copyFailed'))
      })
      break
  }
}
</script>

<template>
  <div
    v-if="selectedCount > 0"
    class="commits-right"
  >
    <div class="diff-header">
      <span class="diff-title">{{ t('commits.changedFiles', { n: fileCount }) }}</span>
      <span
        v-if="selectedCount > 1"
        class="diff-multi"
      >{{ t('commits.multiCommitMerged', { n: selectedCount }) }}</span>
    </div>
    <div
      v-if="loading"
      class="diff-loading"
    >
      <n-spin size="small" />
    </div>
    <div
      v-else
      class="diff-tree"
    >
      <div
        v-for="node in rows"
        :key="node.path"
        class="diff-node"
        :style="{ paddingLeft: (8 + node.depth * 14) + 'px' }"
        :title="!node.isDir && node.file ? t('commits.diffFileHint') : undefined"
        @click="node.isDir && emit('toggle-dir', node.path)"
        @dblclick="!node.isDir && node.file && handleFileDblClick(node)"
        @contextmenu="!node.isDir && node.file && handleContextMenu($event, node)"
      >
        <span class="diff-icon">{{ node.isDir ? (expandedDirs.has(node.path) ? '▼' : '▶') : '📄' }}</span>
        <span
          v-if="node.isDir"
          class="diff-folder"
        >{{ expandedDirs.has(node.path) ? '📂' : '📁' }}</span>
        <span
          class="diff-name"
          :class="{ 'is-dir': node.isDir }"
          :title="node.path"
        >{{ node.name }}</span>
        <span
          v-if="node.file && node.file.status"
          class="diff-status"
          :style="{ color: getStatusColor(node.file.status) }"
          :title="node.file.status"
        >{{ getStatusLabel(node.file.status) }}</span>
      </div>
      <div
        v-if="fileCount === 0 && !loading"
        class="diff-empty"
      >
        {{ t('commits.noChangedFiles') }}
      </div>
    </div>

    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="ctxX"
      :y="ctxY"
      :show="showCtx"
      :options="ctxOptions"
      @select="handleCtxSelect"
      @clickoutside="showCtx = false"
    />

    <FileHistoryModal
      v-model:show="showHistory"
      :project-id="projectId"
      :file="ctxFile?.path || ''"
    />
  </div>
</template>

<style scoped>
/* 与 commits-panel.css 的 diff-* 同源（scoped 引入不穿透子组件，此处自带） */
.commits-right { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden; }
.diff-header { padding: var(--space-1) 10px; font-size: 0.85em; font-weight: var(--fw-medium); color: var(--text-secondary); background: var(--bg-panel); border-bottom: 1px solid var(--border-default); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; position: sticky; top: 0; z-index: 1; user-select: none; }
.diff-header:hover { color: var(--text-primary); }
.diff-multi { font-size: 0.8em; color: var(--accent-blue); }
.diff-loading { padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.92em; }
.diff-empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.92em; }
.diff-tree { flex: 1; overflow-y: auto; }
.diff-node { padding: 2px 6px; display: flex; align-items: center; gap: var(--space-1); cursor: pointer; font-size: 0.92em; color: var(--text-primary); white-space: nowrap; }
.diff-node:hover { background: var(--bg-hover); }
.diff-icon { font-size: 10px; width: 14px; text-align: center; flex-shrink: 0; color: var(--text-secondary); }
.diff-folder { font-size: 12px; flex-shrink: 0; }
.diff-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.diff-name.is-dir { color: var(--accent-blue-light); font-weight: var(--fw-medium); }
.diff-status { flex-shrink: 0; width: 15px; height: 15px; line-height: 15px; text-align: center; border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: 10px; font-weight: var(--fw-semibold); background: color-mix(in srgb, currentColor 16%, transparent); }
</style>
