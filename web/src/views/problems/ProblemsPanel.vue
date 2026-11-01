<script setup lang="ts">
// 问题面板（P-20261003-297）：Monaco 诊断（ts.worker 等语言服务 markers）跨
// 文件聚合底栏——编辑器红波浪线是逐文件孤岛，此处一屏总览「当前打开的文件
// 有哪些错误/警告」。数据面纯前端（useEditorProblems 单例接线，300ms 防抖
// 全量重算），服务端无此状态不设 API；权威类型检查走 npm run check 命令通道。
// 点击条目复用 OPS_OPEN_FILE_AT「打开文件 + 定位」既有链路（TODO 面板同款）。
// 条目「问智能体」动作钮（P-20261006-2）：编辑器诊断 code action 同源入口在
// 聚合域的落点——结构化载荷（消息全文+错误码+文件:行:列+来源）经 P-28 ask 链
// 一键发起询问，与编辑器入口共用 askAgentAboutDiagnostic。
// 过滤行（P-20261005-171）：文本子串 + 严重级二态 chip 正交叠加，只裁显示
// （filtered 视图）；头部摘要与 StatusBar 徽标保持全量口径——徽标答「有多少」、
// 过滤答「找哪个」。过滤态住模块级单例（problemFilters），面板 v-else-if 卸载
// 不重置（显隐/切 tab 回来仍在）。
import { computed } from 'vue'
import { NEmpty, NIcon, NInput } from 'naive-ui'
import { ChatbubbleEllipsesOutline, SearchOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { useI18n } from '../../composables/useI18n'
import { useEditorProblems } from '../../composables/useEditorProblems'
import { useEditorAskAgent } from '../../composables/useEditorAskAgent'
import { useProblemFilters } from './problemFilters'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../../utils/opsEvents'
import { diagnosticSourceOf, filterProblemGroups, type ProblemItem, type ProblemSeverityScope } from '../../utils/editorProblems'

const projectStore = useProjectStore()
const { t } = useI18n()
const problems = useEditorProblems()
const { askAgentAboutDiagnostic } = useEditorAskAgent()
const { filterText, severityScope } = useProblemFilters()

// 头部摘要：错误/警告计数（info/hint 归入「其他」，仅在有则计入总数时展示）
const summary = computed(() => t('problems.summary', {
  errors: problems.aggregate.errorCount,
  warnings: problems.aggregate.warningCount,
}))

// 显示层过滤视图：纯函数裁剪 aggregate（StatusBar 徽标不经过这里，全量口径不受扰）
const filtered = computed(() =>
  filterProblemGroups(problems.aggregate.groups, filterText.value, severityScope.value))

/** 是否处于过滤中（决定 n/全量 计数显隐；trim 同 filterProblemGroups 口径） */
const isFiltering = computed(() =>
  filterText.value.trim() !== '' || severityScope.value !== null)

/** 诚实空态：有诊断但全被滤光 ≠ 无诊断——前者指过滤、后者指打开文件，
 *  共用一个 NEmpty 槽位但文案分流（复用 problems.empty 会说谎） */
const emptyDescription = computed(() =>
  isFiltering.value && problems.aggregate.total > 0
    ? t('problems.filterEmpty')
    : t('problems.empty'))

/** chip 二态切换：激活再点回落全部；两 chip 互斥（「仅错误」「仅警告」同
 *  时为真语义矛盾，CommitFilterBar toggleScope 同款手感） */
function toggleSeverityScope(scope: Exclude<ProblemSeverityScope, null>) {
  severityScope.value = severityScope.value === scope ? null : scope
}

function openAt(item: ProblemItem) {
  const pid = projectStore.currentProjectId
  if (!pid) return
  const detail: OpenFileAtDetail = { path: item.path, projectId: pid, line: item.line, col: item.col }
  window.dispatchEvent(new CustomEvent<OpenFileAtDetail>(OPS_OPEN_FILE_AT, { detail }))
}

/** 条目「问智能体」：来源取 source 优先 owner 兜底（ts.worker 只设 owner），
 *  ask 链自身对无项目根防御性不动作（P-28 家族同口径） */
function askAbout(item: ProblemItem) {
  void askAgentAboutDiagnostic({
    path: item.path,
    line: item.line,
    col: item.col,
    message: item.message,
    code: item.code,
    source: diagnosticSourceOf(item),
  })
}
</script>

<template>
  <div
    class="problems-panel"
    data-testid="problems-panel"
  >
    <div class="pb-header">
      <span
        class="pb-summary"
        :class="{ 'has-errors': problems.aggregate.errorCount > 0 }"
        data-testid="problems-summary"
      >{{ summary }}</span>
      <span
        class="pb-scope-note"
        :title="t('problems.scopeNote')"
      >{{ t('problems.scopeNote') }}</span>
    </div>
    <div class="pb-filter-row">
      <NInput
        v-model:value="filterText"
        size="tiny"
        clearable
        :placeholder="t('problems.filterPlaceholder')"
        class="pb-filter-input"
        data-testid="problems-filter-input"
      >
        <template #prefix>
          <NIcon :size="11">
            <SearchOutline />
          </NIcon>
        </template>
      </NInput>
      <button
        class="pb-scope-chip"
        :class="{ active: severityScope === 'error', err: severityScope === 'error' }"
        data-testid="problems-filter-error"
        @click="toggleSeverityScope('error')"
      >{{ t('problems.filterErrorsOnly') }}</button>
      <button
        class="pb-scope-chip"
        :class="{ active: severityScope === 'warning', warn: severityScope === 'warning' }"
        data-testid="problems-filter-warning"
        @click="toggleSeverityScope('warning')"
      >{{ t('problems.filterWarningsOnly') }}</button>
      <!-- 过滤中才显 n/全量：给「滤掉多少」的即时反馈（CommitFilterBar cp-filter-count 同款） -->
      <span
        v-if="isFiltering"
        class="pb-filter-count"
        data-testid="problems-filter-count"
      >{{ filtered.matched }}/{{ problems.aggregate.total }}</span>
    </div>
    <NEmpty
      v-if="filtered.groups.length === 0"
      class="pb-empty"
      size="small"
      :description="emptyDescription"
    >
      <template #extra>
        <span
          v-if="!isFiltering"
          class="pb-empty-hint"
        >{{ t('problems.emptyHint') }}</span>
      </template>
    </NEmpty>
    <div
      v-else
      class="pb-list"
    >
      <div
        v-for="g in filtered.groups"
        :key="g.path"
        class="pb-file"
      >
        <div
          class="pb-file-header"
          :title="g.path"
        >
          <span class="pb-file-name">{{ g.path.split('/').pop() }}</span>
          <span class="pb-file-dir">{{ g.path }}</span>
          <span class="pb-file-count">{{ g.items.length }}</span>
        </div>
        <div
          v-for="m in g.items"
          :key="`${m.severity}:${m.line}:${m.col}:${m.message}`"
          class="pb-item-row"
        >
          <button
            class="pb-item"
            :title="m.message"
            :data-testid="'problems-item-' + m.line"
            @click="openAt(m)"
          >
            <span
              class="pb-badge"
              :class="'sv-' + m.severity"
            >{{ t('problems.severity.' + m.severity) }}</span>
            <span class="pb-pos">{{ m.line }}:{{ m.col }}</span>
            <span class="pb-message">{{ m.message }}</span>
          </button>
          <button
            class="pb-ask"
            :title="t('editor.ask.menuDiagnostic')"
            :aria-label="t('editor.ask.menuDiagnostic')"
            :data-testid="'problems-ask-' + m.line"
            @click="askAbout(m)"
          >
            <NIcon :size="13">
              <ChatbubbleEllipsesOutline />
            </NIcon>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.problems-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pb-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
  font-size: var(--fs-tiny);
  overflow: hidden;
}
.pb-summary {
  flex-shrink: 0;
  color: var(--text-secondary);
}
.pb-summary.has-errors { color: var(--accent-red); }
.pb-scope-note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}
/* 过滤行（P-20261005-171）：CommitFilterBar cp-filter-row/cp-agent-chip 视觉语，
   chip 激活色跟随对应严重级语义色（与条目徽标 .sv-error/.sv-warning 同源） */
.pb-filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 2px;
  flex-shrink: 0;
}
.pb-filter-input {
  flex: 1;
  min-width: 80px;
}
.pb-scope-chip {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  cursor: pointer;
  flex-shrink: 0;
  white-space: nowrap;
  transition: all var(--motion-fast);
}
.pb-scope-chip:hover:not(.active) { color: var(--text-primary); }
.pb-scope-chip.active.err {
  border-color: currentColor;
  font-weight: 700;
  color: var(--accent-red);
  background: color-mix(in srgb, var(--accent-red) 14%, transparent);
}
.pb-scope-chip.active.warn {
  border-color: currentColor;
  font-weight: 700;
  color: var(--accent-yellow);
  background: color-mix(in srgb, var(--accent-yellow) 16%, transparent);
}
.pb-filter-count {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-tiny);
  color: var(--text-muted);
}
.pb-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px 0;
}
.pb-empty-hint {
  font-size: var(--fs-tiny);
  color: var(--text-muted);
}
.pb-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 8px;
}
.pb-file {
  margin-bottom: 2px;
}
.pb-file-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 10px 2px;
  font-size: var(--fs-tiny);
  color: var(--text-secondary);
  overflow: hidden;
  white-space: nowrap;
}
.pb-file-name {
  color: var(--text-primary);
  font-weight: 600;
  flex-shrink: 0;
}
.pb-file-dir {
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl; /* 目录过长时截头部保文件名语境（TODO 面板同款） */
  text-align: left;
}
.pb-file-count {
  flex-shrink: 0;
  color: var(--text-muted);
}
.pb-item-row {
  display: flex;
  align-items: center;
  padding-right: 6px;
}
.pb-item-row:hover .pb-ask {
  color: var(--accent-blue);
}
.pb-item {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 2px 10px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: var(--fs-tiny);
  color: var(--text-body);
}
.pb-item:hover {
  background: var(--bg-hover);
}
/* 条目「问智能体」动作钮（P-20261006-2）：静默态弱化、行悬停点亮（TODO 面板
   tp-fix 同款形态），可发现性由 aria/title 与行 hover 反馈兜底 */
.pb-ask {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  opacity: 0.6;
  cursor: pointer;
}
.pb-ask:hover {
  color: var(--accent-blue);
  background: var(--bg-hover);
  opacity: 1;
}
.pb-badge {
  flex-shrink: 0;
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
  line-height: 14px;
  font-weight: 600;
}
/* 严重级徽标衬底跟随主题语义色（color-mix 与 TODO 面板徽标同款用法） */
.sv-error { color: var(--accent-red); background: color-mix(in srgb, var(--accent-red) 14%, transparent); }
.sv-warning { color: var(--accent-yellow); background: color-mix(in srgb, var(--accent-yellow) 16%, transparent); }
.sv-info { color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 14%, transparent); }
.sv-hint { color: var(--text-secondary); background: var(--bg-hover); }
.pb-pos {
  flex-shrink: 0;
  color: var(--text-muted);
  min-width: 40px;
  text-align: right;
}
.pb-message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
