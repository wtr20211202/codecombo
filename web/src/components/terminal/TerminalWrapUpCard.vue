<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NModal, NIcon, NSpin, NTag } from 'naive-ui'
import {
  CheckmarkCircleOutline, TimeOutline,
  ChevronForwardOutline, AlertCircleOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { terminalApi } from '../../api/client'
import type { TerminalHistoryEntry } from '../../api/domains/terminal'

/**
 * 会话收工卡（P-20261004-35）：tab 右键「收工摘要」弹出的一键收账面。
 * - 命令账本：该会话归属条目（terminalId 过滤，服务端权威）聚合成
 *   命令数 / 失败数 / 总时长 / 最近活动四个读数
 * - 任务进度：GET /agent-tasks?sessionId= 落库流（7 天保留，会话关闭后仍可回看）
 *   最近几条 task.progress 摘要。留意 P-31 清理语义只作用于前端 bySession
 *   内存态，本卡读服务端落库流，死会话数据不置灰（历史事实）
 * - 会话归属条目上报在 fire-and-forget 链路，未装 shell 集成 / 关闭总开关的
 *   会话没有命令账——空态如实展示，不虚构零值语义
 */

/** GET /agent-tasks 返回的单条任务事件（B6 落库流） */
interface AgentTaskEntry {
  id: string
  sessionId?: string
  type: string
  task?: string
  status?: string
  step?: string
  at: string
}

const props = defineProps<{
  show: boolean
  /** 目标会话（tab.id 即终端会话 ID = CC_TERMINAL_ID 同源锚点） */
  tab: { id: string; name: string } | null
  /** 归属历史所在项目 id（宿主按 tab.projectId || 当前项目解析；空 = 无账可查） */
  projectId: string
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const { t } = useI18n()

const loading = ref(false)
const entries = ref<TerminalHistoryEntry[]>([])
const progressEvents = ref<AgentTaskEntry[]>([])

watch(
  () => [props.show, props.tab?.id] as const,
  ([show]) => {
    if (!show || !props.tab) return
    void fetchAll()
  },
  { immediate: true },
)

async function fetchAll() {
  loading.value = true
  try {
    // 命令账本按会话归属服务端过滤；进度落库流按 sessionId 过滤。两者独立
    // 尽力而为：单边失败不拖垮另一边（catch 后置空展示空态）
    const historyPromise = props.projectId
      ? terminalApi.listHistory(props.projectId, undefined, undefined, props.tab!.id)
        .then((res) => ((res as unknown as { data?: TerminalHistoryEntry[] }).data ?? []))
        .catch(() => [] as TerminalHistoryEntry[])
      : Promise.resolve([] as TerminalHistoryEntry[])
    const progressPromise = terminalApi.listAgentTasks(5, props.tab!.id)
      .then((res) => ((res as unknown as { data?: AgentTaskEntry[] }).data ?? []))
      .catch(() => [] as AgentTaskEntry[])
    const [history, progress] = await Promise.all([historyPromise, progressPromise])
    entries.value = history
    progressEvents.value = progress
  } finally {
    loading.value = false
  }
}

const totalCommands = computed(() => entries.value.length)
const failedCommands = computed(() => entries.value.filter(e => e.exitCode !== 0).length)
const totalDurationMs = computed(() => entries.value.reduce((acc, e) => acc + (e.durationMs || 0), 0))
// 最近活动 = 最新条目时刻（服务端倒序返回，首条即最新）
const lastActiveAt = computed(() => entries.value[0]?.at || '')

// 进度落库流混合了 approval.* 事件；收工摘要只关心 task.progress
const progressList = computed(() => progressEvents.value.filter(e => e.type === 'task.progress'))

function formatTotalDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function formatTime(at: string): string {
  try {
    return new Date(at).toLocaleString()
  } catch { return at }
}

function statusLabel(status?: string): string {
  if (status === 'done') return t('terminal.wrapUp.statusDone')
  if (status === 'failed') return t('terminal.wrapUp.statusFailed')
  return t('terminal.wrapUp.statusRunning')
}

function statusType(status?: string): 'success' | 'error' | 'info' {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'error'
  return 'info'
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('terminal.wrapUp.title')"
    :style="{ width: 'var(--modal-w-sm)', maxWidth: '94vw' }"
    :bordered="false"
    data-testid="terminal-wrap-up-card"
    @update:show="emit('update:show', $event)"
  >
    <div class="wuc-body">
      <div
        v-if="props.tab"
        class="wuc-session"
      >
        <span class="wuc-session-name">{{ props.tab.name }}</span>
        <span class="wuc-session-id">{{ props.tab.id }}</span>
      </div>

      <n-spin
        :show="loading"
        size="small"
      >
        <!-- 命令账本四读数：命令数 / 失败数 / 总时长 / 最近活动 -->
        <div
          class="wuc-stats"
          data-testid="wrap-up-stats"
        >
          <div class="wuc-stat">
            <span class="wuc-stat-value">{{ totalCommands }}</span>
            <span class="wuc-stat-label">{{ t('terminal.wrapUp.cmdCount') }}</span>
          </div>
          <div
            class="wuc-stat"
            :class="{ 'is-failed': failedCommands > 0 }"
          >
            <span class="wuc-stat-value">{{ failedCommands }}</span>
            <span class="wuc-stat-label">{{ t('terminal.wrapUp.failCount') }}</span>
          </div>
          <div class="wuc-stat">
            <span class="wuc-stat-value">{{ formatTotalDuration(totalDurationMs) }}</span>
            <span class="wuc-stat-label">{{ t('terminal.wrapUp.totalDuration') }}</span>
          </div>
          <div class="wuc-stat">
            <span class="wuc-stat-value wuc-stat-time">{{ lastActiveAt ? formatTime(lastActiveAt) : '—' }}</span>
            <span class="wuc-stat-label">{{ t('terminal.wrapUp.lastActive') }}</span>
          </div>
        </div>
        <div
          v-if="props.projectId && totalCommands === 0 && !loading"
          class="wuc-no-history"
        >
          {{ t('terminal.wrapUp.noHistory') }}
        </div>

        <!-- 最近 task.progress 摘要：落库流最近几条（最新在前） -->
        <div class="wuc-progress-head">
          <n-icon size="12">
            <ChevronForwardOutline />
          </n-icon>
          {{ t('terminal.wrapUp.progressTitle') }}
        </div>
        <div
          v-if="progressList.length === 0"
          class="wuc-no-progress"
        >
          {{ t('terminal.wrapUp.noProgress') }}
        </div>
        <div
          v-else
          class="wuc-progress-list"
          data-testid="wrap-up-progress"
        >
          <div
            v-for="ev in progressList"
            :key="ev.id"
            class="wuc-progress-item"
          >
            <div class="wuc-progress-main">
              <span class="wuc-progress-task">{{ ev.task || t('terminal.wrapUp.unnamedTask') }}</span>
              <n-tag
                size="tiny"
                round
                :type="statusType(ev.status)"
                :bordered="false"
              >
                <template #icon>
                  <n-icon size="10">
                    <CheckmarkCircleOutline v-if="ev.status === 'done'" />
                    <AlertCircleOutline v-else-if="ev.status === 'failed'" />
                    <TimeOutline v-else />
                  </n-icon>
                </template>

                {{ statusLabel(ev.status) }}
              </n-tag>
            </div>
            <div
              v-if="ev.step"
              class="wuc-progress-step"
            >
              {{ ev.step }}
            </div>
            <div class="wuc-progress-time">
              {{ formatTime(ev.at) }}
            </div>
          </div>
        </div>
      </n-spin>
    </div>
  </n-modal>
</template>

<style scoped>
.wuc-body { display: flex; flex-direction: column; gap: 10px; }
.wuc-session {
  display: flex; align-items: baseline; gap: 8px; min-width: 0;
  padding-bottom: 8px; border-bottom: 1px solid var(--border-subtle);
}
.wuc-session-name {
  font-size: 13px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wuc-session-id {
  font-size: 10px; color: var(--text-dim); font-family: var(--font-mono, monospace);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wuc-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.wuc-stat {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 8px 4px; border-radius: 6px; background: var(--bg-surface);
  border: 1px solid var(--border-subtle); min-width: 0;
}
.wuc-stat-value {
  font-size: 15px; font-weight: 600; color: var(--text-primary);
  font-family: var(--font-mono, monospace); max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wuc-stat.is-failed .wuc-stat-value { color: var(--accent-red); }
.wuc-stat-label { font-size: 10px; color: var(--text-muted); }
.wuc-no-history, .wuc-no-progress { font-size: 11px; color: var(--text-dim); padding: 2px 0; }
.wuc-progress-head {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600; color: var(--text-secondary);
}
.wuc-progress-list { display: flex; flex-direction: column; gap: 6px; }
.wuc-progress-item {
  padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--border-subtle); background: var(--bg-panel);
}
.wuc-progress-main { display: flex; align-items: center; gap: 6px; }
.wuc-progress-task {
  flex: 1; min-width: 0; font-size: 12px; color: var(--text-body);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wuc-progress-step {
  margin-top: 2px; font-size: 11px; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wuc-progress-time {
  margin-top: 2px; font-size: 10px; color: var(--text-dim);
  font-family: var(--font-mono, monospace);
}
</style>
