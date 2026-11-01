<script setup lang="ts">
import { ref, watch } from 'vue'
import { NButton, NEmpty, NModal, NSpin } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { branchApi } from '../../api/client'
import type { MergePreviewConflictFile, MergePreviewResult } from '../../api/domains/git'

/**
 * 合并预演弹层（P-20261005-174）：merge-tree 只读原语「先看再合」——分支
 * 合回当前分支前预演冲突清单与合成结果形态，不动工作区。
 *   红态：冲突文件清单（点击展开该文件首段 ours/theirs 冲突段摘要）+ 干净
 *         并入计数 +「直接去合并」（走宿主既有确认合并链）双出口；
 *   绿态：可干净合并 + 合成 stat（零变更 = source 已被包含）。
 * git <2.38 端点 501：弹层就地诚实提示（入口已按 branches 列表的
 * mergePreviewSupported 隐藏，这里是直接调用的兜底态）。
 * 预演是快照不保新鲜：弹层停留期间分支若前进，以「直接去合并」触发真合并
 * 时的实际结果为准。
 */
const props = defineProps<{
  show: boolean
  projectId: string
  /** 要合入的源分支（右键目标） */
  source: string
  /** 当前分支（合并去向，仅展示用） */
  base: string
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  /** 「直接去合并」：宿主走既有确认合并链（P-20261003-222 防误合护栏） */
  (e: 'merge', source: string): void
}>()

const { t } = useI18n()

const loading = ref(false)
const errorMsg = ref('')
const unsupported = ref(false)
const result = ref<MergePreviewResult | null>(null)
// 展开冲突段摘要的文件集合（点击切换）
const expanded = ref<Set<string>>(new Set())

watch(() => props.show, (v) => {
  if (v) void fetchPreview()
})

async function fetchPreview() {
  if (!props.projectId || !props.source) return
  loading.value = true
  errorMsg.value = ''
  unsupported.value = false
  result.value = null
  expanded.value = new Set()
  try {
    const res = await branchApi.mergePreview(props.projectId, props.source) as unknown as { data?: MergePreviewResult }
    result.value = res?.data ?? null
  } catch (e: any) {
    // 501 = 本机 git 过旧（merge-tree 现代模式缺失）：专属文案；其余按拦截器
    // 友好文案就地降级（silent 请求不打全局 toast）
    if (e?.status === 501) {
      unsupported.value = true
      errorMsg.value = t('git.mergePreview.unsupported')
    } else {
      errorMsg.value = e?.userMessage || e?.message || t('git.mergePreview.failed')
    }
  } finally {
    loading.value = false
  }
}

function toggleExpand(path: string) {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expanded.value = next
}

function statusLabel(status: MergePreviewConflictFile['status']): string {
  switch (status) {
    case 'both-modified': return t('git.mergePreview.statusBothModified')
    case 'both-added': return t('git.mergePreview.statusBothAdded')
    case 'deleted-by-us': return t('git.mergePreview.statusDeletedByUs')
    case 'deleted-by-them': return t('git.mergePreview.statusDeletedByThem')
    default: return status
  }
}

function goMerge() {
  emit('update:show', false)
  emit('merge', props.source)
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="t('git.mergePreview.title')"
    style="width: var(--modal-w-lg); max-width: 94vw"
    :mask-closable="!loading"
    data-testid="merge-preview-modal"
    @update:show="emit('update:show', $event)"
  >
    <div class="mp-direction">
      {{ t('git.mergePreview.direction', { source, base }) }}
    </div>

    <div
      v-if="loading"
      class="mp-center"
    >
      <n-spin size="small" />
    </div>

    <div
      v-else-if="errorMsg"
      class="mp-center mp-error"
      data-testid="merge-preview-error"
    >
      <n-empty :description="errorMsg" />
    </div>

    <template v-else-if="result">
      <!-- 绿态：可干净合并 -->
      <div
        v-if="result.clean"
        class="mp-banner mp-clean"
        data-testid="merge-preview-clean-banner"
      >
        <span class="mp-banner-title">{{ t('git.mergePreview.cleanTitle') }}</span>
        <span
          v-if="(result.stat?.files ?? 0) > 0"
          class="mp-banner-desc"
        >
          {{ t('git.mergePreview.cleanDesc', { files: result.stat?.files, insertions: result.stat?.insertions, deletions: result.stat?.deletions }) }}
        </span>
        <span
          v-else
          class="mp-banner-desc"
        >{{ t('git.mergePreview.cleanNoChange') }}</span>
      </div>

      <!-- 红态：冲突清单 -->
      <template v-else>
        <div
          class="mp-banner mp-conflict"
          data-testid="merge-preview-conflict-banner"
        >
          <span class="mp-banner-title">{{ t('git.mergePreview.conflictTitle', { n: result.conflicts.length }) }}</span>
          <span class="mp-banner-desc">{{ t('git.mergePreview.conflictHint') }}</span>
        </div>
        <div class="mp-list">
          <div
            v-for="cf in result.conflicts"
            :key="cf.path"
            class="mp-item"
            data-testid="merge-preview-conflict"
            @click="toggleExpand(cf.path)"
          >
            <div class="mp-item-row">
              <span
                class="mp-item-dot"
                :class="{ open: expanded.has(cf.path) }"
              >▸</span>
              <span
                class="mp-item-path"
                :title="cf.path"
              >{{ cf.path }}</span>
              <span class="mp-item-status">{{ statusLabel(cf.status) }}</span>
              <span
                v-if="cf.hunkCount"
                class="mp-item-hunks"
              >{{ t('git.mergePreview.hunkCount', { n: cf.hunkCount }) }}</span>
            </div>
            <!-- 冲突段摘要（首段 ours/theirs 预览；删除-修改类无段不展示） -->
            <div
              v-if="expanded.has(cf.path) && (cf.ours !== undefined || cf.theirs !== undefined)"
              class="mp-sections"
              @click.stop
            >
              <div class="mp-section">
                <div class="mp-section-head mp-ours-head">
                  {{ t('git.mergePreview.ours', { base }) }}
                </div>
                <pre class="mp-section-body">{{ cf.ours || '∅' }}</pre>
              </div>
              <div class="mp-section">
                <div class="mp-section-head mp-theirs-head">
                  {{ t('git.mergePreview.theirs', { source }) }}
                </div>
                <pre class="mp-section-body">{{ cf.theirs || '∅' }}</pre>
              </div>
            </div>
          </div>
        </div>
        <div
          v-if="result.cleanCount > 0"
          class="mp-clean-rest"
          data-testid="merge-preview-clean-count"
        >
          {{ t('git.mergePreview.cleanRest', { n: result.cleanCount }) }}
        </div>
      </template>
    </template>

    <div class="mp-footer">
      <span class="mp-note">{{ t('git.mergePreview.readonlyNote') }}</span>
      <div style="flex: 1" />
      <n-button
        size="small"
        :disabled="loading"
        data-testid="merge-preview-cancel"
        @click="emit('update:show', false)"
      >
        {{ t('common.cancel') }}
      </n-button>
      <n-button
        size="small"
        type="primary"
        :disabled="loading || !result"
        data-testid="merge-preview-go"
        @click="goMerge"
      >
        {{ t('git.mergePreview.goMerge') }}
      </n-button>
    </div>
  </n-modal>
</template>

<style scoped>
.mp-direction { font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; }
.mp-center { padding: 24px; text-align: center; }
.mp-error { color: var(--text-dim); }
.mp-banner {
  border-radius: var(--radius-md); padding: 10px var(--space-3); margin-bottom: 10px;
  display: flex; flex-direction: column; gap: var(--space-1);
}
.mp-clean { background: color-mix(in srgb, var(--accent-green) 12%, transparent); border: 1px solid color-mix(in srgb, var(--accent-green) 35%, transparent); }
.mp-conflict { background: color-mix(in srgb, var(--accent-red) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent-red) 35%, transparent); }
.mp-banner-title { font-size: 13px; font-weight: var(--fw-semibold); color: var(--text-primary); }
.mp-banner-desc { font-size: 12px; color: var(--text-secondary); }
.mp-list { max-height: 46vh; overflow-y: auto; border: 1px solid var(--border-default); border-radius: var(--radius-md); }
.mp-item { padding: 6px 10px; cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--border-default) 40%, transparent); }
.mp-item:last-child { border-bottom: none; }
.mp-item:hover { background: var(--bg-hover); }
.mp-item-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.mp-item-dot { font-size: 10px; color: var(--text-muted); flex-shrink: 0; transition: transform var(--motion-base); }
.mp-item-dot.open { transform: rotate(90deg); }
.mp-item-path { font-size: 12.5px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.mp-item-status {
  flex-shrink: 0; font-size: 11px; padding: 0 6px; border-radius: var(--radius-sm);
  color: var(--accent-red);
  border: 1px solid color-mix(in srgb, var(--accent-red) 40%, transparent);
}
.mp-item-hunks { flex-shrink: 0; font-size: 11px; color: var(--text-muted); }
.mp-sections { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
.mp-section { flex: 1; min-width: 0; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border-default); }
.mp-section-head { font-size: 11px; padding: 3px var(--space-2); color: var(--text-secondary); }
.mp-ours-head { background: color-mix(in srgb, var(--accent-green) 10%, transparent); }
.mp-theirs-head { background: color-mix(in srgb, var(--accent-red) 10%, transparent); }
.mp-section-body {
  margin: 0; padding: 6px var(--space-2); font-size: 11.5px; line-height: 1.5;
  max-height: 180px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
  color: var(--text-primary); background: var(--bg-primary);
}
.mp-clean-rest { margin-top: var(--space-2); font-size: 12px; color: var(--text-secondary); }
.mp-footer { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-3); }
.mp-note { font-size: 11px; color: var(--text-dim); }
</style>
