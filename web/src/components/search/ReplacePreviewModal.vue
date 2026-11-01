<script setup lang="ts">
/**
 * 批量替换预览弹层（P-20261003-71）：确认前逐文件逐命中展示 before（红划）→
 * after（绿标）行级对照——regex 误配（贪婪/边界）在纯计数确认框里看不出来，
 * 对照行是批量替换的安全网（VS Code/JetBrains 同款形态）。after 文本出自
 * utils/replacePreview 的共享替换函数（与执行链同一实现，防漂移硬纪律）。
 * 文件勾选直接驱动父组件 selectedPaths 单一事实源——弹层内勾选/排除与结果
 * 列表文件勾选同状态，确认执行仅作用勾选文件。
 * 大结果集防塌方：文件数超过 SOFT_FILE_LIMIT 时第 SOFT_FILE_LIMIT+1 个起默认
 * 折叠（组头常驻：计数+勾选仍可用，点箭头展开），每文件先渲染前
 * ROW_PREVIEW_LIMIT 行对照，其余经「展开其余 N 处」按需展开——DOM 规模有界。
 * 备份勾选（P-20261003-76）：页脚左侧「替换前导出备份补丁」默认勾，随 confirm
 * 事件传给父组件决定执行前是否先下载工作区 diff——仅 confirm 流选项，不与
 * 结果列表勾选共享状态，弹层内自持（每次打开重置为默认勾，备份永远默认在场）。
 */
import { computed, ref, watch } from 'vue'
// 应用未全局注册 naive-ui：模板里用到的组件必须显式 import（历史回归教训）
import { NButton, NCheckbox, NIcon, NModal } from 'naive-ui'
import { ArrowForwardOutline, ChevronForwardOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import type { FilePreview } from '../../utils/replacePreview'

const props = withDefaults(defineProps<{
  show: boolean
  files: FilePreview[]
  /** 勾选集合为父组件单一事实源（与结果列表文件勾选同状态） */
  selectedPaths: Set<string>
  executing: boolean
  /** 低置信文件集（P-20261005-157 重命名引用更新流）：组头挂「低置信」徽标，
   *  勾选态仍由 selectedPaths 驱动（宿主默认不勾）——徽标只是呈现面 */
  lowConfidencePaths?: Set<string>
  /** 备份勾选显隐（默认在场；引用更新流隐藏——服务端已强制留档，离手副本
   *  双份下载无益，且双置信区分组执行会产生多个备份档） */
  showBackup?: boolean
}>(), {
  lowConfidencePaths: undefined,
  showBackup: true,
})
const emit = defineEmits<{
  (e: 'update:show', val: boolean): void
  (e: 'toggle-file', path: string, checked: boolean): void
  (e: 'toggle-all', checked: boolean): void
  (e: 'confirm', backup: boolean): void
}>()

const { t } = useI18n()

// ── 大结果集防塌方（DOM 规模上限：10×20 行 + N 个轻量组头）──────────
const SOFT_FILE_LIMIT = 10
const ROW_PREVIEW_LIMIT = 20

const collapsed = ref<Set<string>>(new Set())
const expandedRows = ref<Set<string>>(new Set())

// 备份勾选为弹层内视图态（不与结果列表共享）：每次打开重置为默认勾
const backupEnabled = ref(true)

watch(() => props.show, (val) => {
  if (!val) return
  // 打开即重置视图态：上一轮的折叠/展开不带入新预览
  expandedRows.value = new Set()
  backupEnabled.value = true
  collapsed.value = props.files.length > SOFT_FILE_LIMIT
    ? new Set(props.files.slice(SOFT_FILE_LIMIT).map(f => f.path))
    : new Set()
})

function isCollapsed(path: string) {
  return collapsed.value.has(path)
}

function toggleFold(path: string) {
  const next = new Set(collapsed.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsed.value = next
}

function visibleRows(path: string, rows: FilePreview['rows']) {
  return expandedRows.value.has(path) ? rows : rows.slice(0, ROW_PREVIEW_LIMIT)
}

function hasHiddenRows(f: FilePreview) {
  return !expandedRows.value.has(f.path) && f.rows.length > ROW_PREVIEW_LIMIT
}

function revealRows(path: string) {
  expandedRows.value = new Set(expandedRows.value).add(path)
}

// ── 勾选三态（读写父组件 selectedPaths，本组件不持第二份事实源）────────
const selectedCount = computed(() => props.files.filter(f => props.selectedPaths.has(f.path)).length)
const selectedMatchCount = computed(() =>
  props.files.reduce((n, f) => n + (props.selectedPaths.has(f.path) ? f.hitCount : 0), 0),
)
const isAllSelected = computed(() => props.files.length > 0 && selectedCount.value === props.files.length)
const isPartialSelected = computed(() => selectedCount.value > 0 && !isAllSelected.value)

// 确认按钮文案与面板按钮同语义：全选=「全部替换」，部分勾选=「替换选中 n 文件」
const confirmLabel = computed(() =>
  isAllSelected.value
    ? t('projectSearch.replaceAll')
    : t('search.replace.replaceSelected', { n: selectedCount.value }),
)
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('search.replace.previewTitle')"
    style="width: min(var(--modal-w-xl), 94vw)"
    :mask-closable="!props.executing"
    :close-on-esc="!props.executing"
    class="rp-modal"
    @update:show="emit('update:show', $event)"
  >
    <div class="rp-stats">
      <span class="rp-stats-text">
        {{ t('search.replace.previewStats', { files: selectedCount, matches: selectedMatchCount }) }}
      </span>
      <label class="rp-select-all">
        <n-checkbox
          size="small"
          :checked="isAllSelected"
          :indeterminate="isPartialSelected"
          :disabled="props.executing"
          @update:checked="(checked: boolean) => emit('toggle-all', checked)"
        />
        <span>{{ isAllSelected ? t('search.replace.clearAll') : t('search.replace.selectAll') }}</span>
      </label>
    </div>
    <div class="rp-warning">
      {{ t('search.replace.previewHint') }}
    </div>
    <div class="rp-list">
      <div
        v-for="f in props.files"
        :key="f.path"
        class="rp-file-group"
        :class="{ 'is-excluded': !props.selectedPaths.has(f.path) }"
      >
        <div class="rp-file-header">
          <n-checkbox
            size="small"
            class="rp-file-check"
            :checked="props.selectedPaths.has(f.path)"
            :disabled="props.executing"
            @update:checked="(checked: boolean) => emit('toggle-file', f.path, checked)"
          />
          <button
            class="rp-fold"
            :title="t('search.replace.toggleFile')"
            @click="toggleFold(f.path)"
          >
            <n-icon
              size="12"
              class="rp-fold-icon"
              :class="{ 'is-open': !isCollapsed(f.path) }"
            >
              <ChevronForwardOutline />
            </n-icon>
          </button>
          <span
            class="rp-file-name"
            :title="f.path"
          >{{ f.path.split('/').pop() }}</span>
          <span class="rp-file-path">{{ f.path }}</span>
          <!-- 低置信徽标（P-20261005-157）：'./简式' 引用指涉歧义（可能指向他目录
               同名文件），替换前须逐行确认——默认不勾由宿主 selectedPaths 承载 -->
          <span
            v-if="props.lowConfidencePaths?.has(f.path)"
            class="rp-lowconf"
            :title="t('search.replace.lowConfidenceTitle')"
          >{{ t('search.replace.lowConfidence') }}</span>
          <span class="rp-file-count">{{ f.hitCount }}</span>
        </div>
        <template v-if="!isCollapsed(f.path)">
          <div
            v-for="row in visibleRows(f.path, f.rows)"
            :key="row.line"
            class="rp-row"
          >
            <span class="rp-line-num">{{ row.line }}</span>
            <div class="rp-pair">
              <span class="rp-line is-before"><template
                v-for="(seg, i) in row.beforeSegments"
                :key="i"
              ><span
                v-if="seg.isMatch"
                class="rp-del"
              >{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template></span>
              <n-icon
                size="11"
                class="rp-arrow"
              >
                <ArrowForwardOutline />
              </n-icon>
              <span class="rp-line is-after"><template
                v-for="(seg, i) in row.afterSegments"
                :key="i"
              ><span
                v-if="seg.isMatch"
                class="rp-add"
              >{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template></span>
            </div>
          </div>
          <button
            v-if="hasHiddenRows(f)"
            class="rp-more"
            @click="revealRows(f.path)"
          >
            {{ t('search.replace.moreHits', { n: f.rows.length - ROW_PREVIEW_LIMIT }) }}
          </button>
        </template>
      </div>
    </div>
    <template #footer>
      <div class="rp-footer">
        <label
          v-if="props.showBackup"
          class="rp-backup"
          data-testid="replace-backup-toggle"
          :title="t('search.replace.backup.toggleTitle')"
        >
          <n-checkbox
            size="small"
            :checked="backupEnabled"
            :disabled="props.executing"
            @update:checked="(checked: boolean) => (backupEnabled = checked)"
          />
          <span>{{ t('search.replace.backup.toggle') }}</span>
        </label>
        <n-button
          size="small"
          quaternary
          :disabled="props.executing"
          @click="emit('update:show', false)"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          data-testid="replace-preview-confirm"
          :loading="props.executing"
          :disabled="selectedCount === 0"
          :title="selectedCount === 0 ? t('search.replace.confirmDisabled') : undefined"
          @click="emit('confirm', backupEnabled)"
        >
          {{ confirmLabel }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.rp-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.rp-stats-text {
  font-size: 12px;
  color: var(--text-secondary);
}

.rp-select-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.rp-warning {
  font-size: 11px;
  color: var(--accent-orange, var(--text-muted));
  margin-bottom: 8px;
}

.rp-list {
  max-height: min(52vh, 560px);
  overflow-y: auto;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 6px 0;
  background: var(--bg-primary);
}

.rp-file-group {
  margin-bottom: 4px;
}

/* 被排除文件：整组降透明度（勾选状态之外的视觉二态，一眼分清替换范围） */
.rp-file-group.is-excluded .rp-file-header,
.rp-file-group.is-excluded .rp-row,
.rp-file-group.is-excluded .rp-more {
  opacity: 0.45;
}

.rp-file-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
}

.rp-file-check {
  flex-shrink: 0;
}

.rp-fold {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  align-items: center;
  border-radius: 4px;
  flex-shrink: 0;
}

.rp-fold:hover {
  color: var(--brand-accent);
  background: var(--bg-hover);
}

.rp-fold-icon {
  transition: transform var(--motion-base);
}

.rp-fold-icon.is-open {
  transform: rotate(90deg);
}

.rp-file-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.rp-file-path {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rp-file-count {
  font-size: 10px;
  font-weight: 600;
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}

/* 低置信徽标（P-20261005-157）：弱警示描边小徽，不与命中数徽标抢视觉 */
.rp-lowconf {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-orange, var(--text-muted));
  border: 1px solid color-mix(in srgb, var(--accent-orange, var(--text-muted)) 45%, transparent);
  padding: 0 6px;
  border-radius: 8px;
  flex-shrink: 0;
  cursor: help;
}

.rp-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 12px 2px 20px;
}

.rp-line-num {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  min-width: 24px;
  text-align: right;
  flex-shrink: 0;
  padding-top: 2px;
}

.rp-pair {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.rp-line {
  font-size: 12px;
  font-family: var(--font-mono);
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* before：原文整行弱化，命中段红划 */
.rp-line.is-before {
  color: var(--text-muted);
  flex: 1;
}

.rp-del {
  color: var(--accent-red);
  text-decoration: line-through;
  background: color-mix(in srgb, var(--accent-red) 12%, transparent);
  border-radius: 2px;
}

.rp-arrow {
  color: var(--text-muted);
  flex-shrink: 0;
  align-self: center;
}

/* after：替换后整行正文色，新文本段绿标 */
.rp-line.is-after {
  color: var(--text-body);
  flex: 1;
}

.rp-add {
  color: var(--accent-green);
  font-weight: 600;
  background: color-mix(in srgb, var(--accent-green) 14%, transparent);
  border-radius: 2px;
}

.rp-more {
  border: none;
  background: transparent;
  color: var(--brand-accent);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 12px 4px 52px;
  text-align: left;
}

.rp-more:hover {
  text-decoration: underline;
}

.rp-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 备份勾选居左（margin-right:auto 把动作按钮推回右侧） */
.rp-backup {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}
</style>
