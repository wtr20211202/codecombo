<script setup lang="ts">
/**
 * 会话产出面板（B3）：展示某会话自创建以来的产出——
 * git diff <startHead>..工作区 的文件列表（含会话期间已提交的工作与未跟踪新文件）
 * + 增删行数汇总。归属确定性来自会话元数据的 startHead，不靠文件事件猜。
 * 审阅基线切换（P-20261003-217）：长会话阶段性审阅——「本轮改的看完了」标记
 * 审阅基线，下轮可把 diff 范围切到任一标记（服务端按时间戳 rev-list 解析基点，
 * 响应附 marks 列表）。无基线（老会话/纯终端）退化为工作区视图（baseline=false）；
 * 会话不存在或已结束（404，silent 不弹错误 toast）时给引导文案。
 */
import { computed, ref, watch } from 'vue'
import { NButton, NDropdown, NIcon, NSpin, useMessage } from 'naive-ui'
import { CloseOutline, FlagOutline, GitCompareOutline, RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { terminalApi } from '../../api/client'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { openCrossReview } from '../../composables/useCrossReview'

interface ActivityMark { ts: string; head?: string }
interface ActivityFile { status: string; path: string }
interface Activity {
  startHead: string
  /** 实际计算基点（默认 = startHead；since 切换后为标记基点提交） */
  base?: string
  /** false = 无创建时基线，files 为当前工作区改动（老会话恢复等场景） */
  baseline?: boolean
  /** false = 会话目录不是 git 仓库 */
  gitRepo?: boolean
  files: ActivityFile[] | null
  additions: number
  deletions: number
  /** 该会话全部审阅基线标记（P-20261003-217，切换器选项） */
  marks?: ActivityMark[]
}

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()
const message = useMessage()
const loading = ref(false)
const activity = ref<Activity | null>(null)
const unavailable = ref(false)
/** 当前 diff 基线：'' = 会话起点（startHead），否则为标记时间戳原文 */
const sinceTs = ref('')

// 交叉审查入口（P-20261003-6）：产出视图操作区把本会话产出交另一 runtime 审查。
// 仅系统会话可发起（项目会话不经跨智能体审查链，无系统会话条目时按钮隐藏）；
// openCrossReview 是模块级动作（免组合式实例——本面板随开合挂卸）
const sessionsStore = useTerminalSessionsStore()
const sourceSession = computed(
  () => sessionsStore.systemSessions.find(s => s.id === props.sessionId) || null,
)
function crossReview() {
  const s = sourceSession.value
  if (!s) return
  openCrossReview({ id: s.id, name: s.name, runtime: s.runtime || '', dir: s.path || undefined })
}

async function load() {
  if (!props.sessionId) return
  loading.value = true
  unavailable.value = false
  try {
    // 404 是预期分支（纯终端项目会话/会话已关 → 无元数据）：面板自备引导文案，
    // 必须 silent，否则全局拦截器弹「资源不存在」错误 toast 误导用户
    const res: any = await terminalApi.activity(props.sessionId, { silent: true }, sinceTs.value || undefined)
    activity.value = res?.data || null
  } catch {
    unavailable.value = true
    activity.value = null
  } finally {
    loading.value = false
  }
}

watch(() => props.sessionId, () => { sinceTs.value = ''; void load() }, { immediate: true })

// ============== 审阅基线（P-20261003-217） ==============
/** 标记时刻短格式（本地时区，切换器选项标签） */
const fmtMark = (ts: string) => {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const hasMarks = computed(() => (activity.value?.marks?.length || 0) > 0)
const currentLabel = computed(() =>
  sinceTs.value ? fmtMark(sinceTs.value) : t('agentTerminal.baselineStart'))
const baselineOptions = computed(() => [
  { label: t('agentTerminal.baselineStart'), key: '' },
  ...(activity.value?.marks || []).map((m, i) => ({
    label: `${t('agentTerminal.baselineMark', { n: i + 1 })} ${fmtMark(m.ts)}`,
    key: m.ts,
  })),
])
function switchBaseline(key: string) {
  if (key === sinceTs.value) return
  sinceTs.value = key
  void load()
}
/** 标记当前时点为本会话审阅基线：成功后刷新（新标记进切换器）并反馈；
 *  失败由拦截器 toast（非 silent），此处不再叠加 */
async function markBaseline() {
  await sessionsStore.markReviewBaseline(props.sessionId)
  message.success(t('agentTerminal.markBaselineDone'))
  await load()
}

const statusColor = (s: string) =>
  s === '?' ? 'var(--accent-green)' : s === 'D' ? 'var(--accent-red, #f44747)' : 'var(--accent-yellow-warm)'
</script>

<template>
  <div class="aap-root">
    <div class="aap-header">
      <span class="aap-title">{{ t('agentTerminal.activityTitle') }}</span>
      <span
        v-if="activity"
        class="aap-count"
      >{{ (activity.files || []).length }} · +{{ activity.additions }} / -{{ activity.deletions }}</span>
      <span
        v-if="activity && activity.baseline === false"
        class="aap-nobaseline"
        :title="t('agentTerminal.activityNoBaselineTip')"
      >{{ t('agentTerminal.activityNoBaselineShort') }}</span>
      <span class="aap-spacer" />
      <!-- 审阅基线切换（P-20261003-217）：会话起点 vs 各阶段标记；无标记时
           只剩起点一项，切换器隐藏不占位 -->
      <n-dropdown
        v-if="hasMarks"
        trigger="click"
        placement="bottom-end"
        :options="baselineOptions"
        @select="switchBaseline"
      >
        <n-button
          size="tiny"
          quaternary
          class="aap-baseline"
          data-testid="activity-baseline-switch"
          :title="t('agentTerminal.baselineSwitchTip')"
        >
          {{ currentLabel }}
        </n-button>
      </n-dropdown>
      <!-- 标记审阅基线：本轮改动审完打标记，下轮 diff 从新基线算 -->
      <n-button
        size="tiny"
        quaternary
        data-testid="activity-mark-baseline"
        :title="t('agentTerminal.markBaselineTip')"
        @click="markBaseline"
      >
        <template #icon>
          <n-icon><FlagOutline /></n-icon>
        </template>
      </n-button>
      <n-button
        v-if="sourceSession"
        size="tiny"
        quaternary
        data-testid="cross-review-activity"
        :title="t('review.cross.action')"
        @click="crossReview"
      >
        <template #icon>
          <n-icon><GitCompareOutline /></n-icon>
        </template>
      </n-button>
      <n-button
        size="tiny"
        quaternary
        :title="t('common.refresh')"
        @click="load"
      >
        <template #icon>
          <n-icon><RefreshOutline /></n-icon>
        </template>
      </n-button>
      <n-button
        size="tiny"
        quaternary
        :title="t('common.close')"
        @click="emit('close')"
      >
        <template #icon>
          <n-icon><CloseOutline /></n-icon>
        </template>
      </n-button>
    </div>
    <div class="aap-body">
      <div
        v-if="loading"
        class="aap-center"
      >
        <n-spin size="small" />
      </div>
      <div
        v-else-if="unavailable || !activity"
        class="aap-empty"
      >
        {{ t('agentTerminal.activityUnavailable') }}
      </div>
      <div
        v-else-if="activity.baseline === false"
        class="aap-empty"
      >
        {{ activity.gitRepo === false ? t('agentTerminal.activityNoGit') : t('agentTerminal.activityNoBaseline') }}
      </div>
      <div
        v-else-if="(activity.files || []).length === 0"
        class="aap-empty"
      >
        {{ t('agentTerminal.activityEmpty') }}
      </div>
      <div
        v-else
        class="aap-files"
      >
        <div
          v-for="f in activity.files"
          :key="f.path"
          class="aap-file"
          :title="f.path"
        >
          <span
            class="aap-status"
            :style="{ color: statusColor(f.status) }"
          >{{ f.status }}</span>
          <span class="aap-path">{{ f.path }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aap-root {
  position: absolute; top: 0; right: 0; bottom: 0; width: 320px; max-width: 60%;
  background: var(--bg-panel); border-left: 1px solid var(--border-default);
  display: flex; flex-direction: column; z-index: 30;
  box-shadow: var(--shadow-pop-sm, -4px 0 16px rgba(0, 0, 0, 0.15));
}
.aap-header {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border-bottom: 1px solid var(--border-default); font-size: 0.85em;
}
.aap-title { font-weight: 500; color: var(--text-primary); }
.aap-count { color: var(--text-muted); font-size: 0.9em; }
.aap-nobaseline {
  font-size: 0.72em; padding: 0 4px; border-radius: 2px; flex-shrink: 0;
  background: color-mix(in srgb, var(--accent-yellow-warm) 20%, transparent);
  color: var(--accent-yellow-warm);
}
.aap-spacer { flex: 1; }
/* 基线切换按钮（P-20261003-217）：时间标签短宽约束，头部一行放得下 */
.aap-baseline { max-width: 96px; font-size: 0.72em; }
.aap-baseline :deep(.n-button__content) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aap-body { flex: 1; overflow: auto; }
.aap-center { display: flex; justify-content: center; padding: 24px; }
.aap-empty {
  padding: 24px 16px; font-size: 0.85em; color: var(--text-muted);
  text-align: center; line-height: 1.6;
}
.aap-files { padding: 4px 0; }
.aap-file {
  display: flex; align-items: center; gap: 6px; padding: 3px 10px;
  font-size: 0.82em; white-space: nowrap; overflow: hidden;
}
.aap-file:hover { background: var(--bg-hover); }
.aap-status { flex-shrink: 0; width: 12px; font-weight: 600; font-family: monospace; }
.aap-path { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
</style>
