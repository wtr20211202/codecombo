<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NModal, useMessage } from 'naive-ui'
import { OpenOutline, PulseOutline, TrashOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useAssistantTaskStore } from '../../stores/assistantTask'
import { useApprovalsStore } from '../../stores/approvals'
import { useStallTriageStore } from '../../stores/stallTriage'
import { terminalApi } from '../../api/domains/terminal'
import { sessionStallMinutes } from '../../utils/session-idle'
import { relativeTimeParts } from '../../utils/relative-time'

/**
 * 停滞分诊卡（P-20261004-37）：点击停滞强标弹出的现场装配面——任务进度摘要 +
 * 终端侧证据（运行态/最近命令/退出码）+「催一下/打开会话/终止」三动作。
 * 本体挂 App 层单一实例（全局弹窗惯例），三宿主（侧栏行/悬浮列表行/大屏卡）
 * 经 stallTriage store 只写目标会话 id；本组件自读各数据 store 装配最新现场，
 * 不经 props 快照（打开时刻读到什么判什么，随 store 实时对账）。
 * 数据边界诚实注记：runningMap/activityMap/lastCmdMap 是浏览器内存态，跨标签
 * 页无数据（P-63 双轨的同款边界）——缺失以「—」占位不虚构。
 */
const triage = useStallTriageStore()
const sessionsStore = useTerminalSessionsStore()
const assistantTask = useAssistantTaskStore()
const approvals = useApprovalsStore()
const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const { jumpToProjectSession, jumpToAgentSession } = useAgentTerminal()

const show = computed(() => triage.open)
const session = computed(() => sessionsStore.sessions.find(s => s.id === triage.sessionId))
const progress = computed(() => assistantTask.bySession[triage.sessionId])

// 停滞分钟数（判据复用 session-idle 纯函数）：读 nowTick 登记心跳依赖，让
// 「静默 N 分钟」随 30s 心跳重算（与陈旧判定同款时钟机制）；停滞判定以
// bySession 条目为前提，心跳必已启动，nowTick=0 分支实际不可达
const stallMin = computed(() => {
  void assistantTask.nowTick
  const p = progress.value
  return sessionStallMinutes({
    taskRunning: p?.status === 'running',
    running: sessionsStore.runningMap[triage.sessionId],
    lastActivity: sessionsStore.activityMap[triage.sessionId],
    lastReportAt: p?.updatedAt,
  })
})

/** 终端侧状态文案键：命令已结束（主异常形态）/ 运行中但静默 / 无记录 */
const shellStateKey = computed(() => {
  const running = sessionsStore.runningMap[triage.sessionId]
  if (running === false) return 'stallTriage.shellIdle'
  if (running === true) return 'stallTriage.shellRunning'
  return ''
})

const lastCmd = computed(() => sessionsStore.lastCmdMap[triage.sessionId])
const hasPendingApproval = computed(() => approvals.pendingSessionIds.has(triage.sessionId))

/** 相对时间文案（agentTerminal.activity* 与各宿主同口径；无记录返回空） */
function relTime(ts: number | undefined): string {
  if (!ts) return ''
  const p = relativeTimeParts(ts)
  return t(`agentTerminal.${p.key}`, { n: p.n })
}

const doneSteps = computed(() => (progress.value?.steps ?? []).filter(s => s.done).length)

// ============== 动作 ==============
/** 催一下：向 PTY 写一次回车（broadcast-write 既有写入面）——卡在隐形提示
 *  符（y/n 确认等）的智能体被默认项推进；停在空提示符的 shell 只是空命令，
 *  无副作用。写入结果如实反馈（会话可能已消亡） */
const nudging = ref(false)
async function nudge(): Promise<void> {
  if (nudging.value) return
  nudging.value = true
  try {
    const res = await terminalApi.broadcastWrite([triage.sessionId], '\r')
    const written = (res as { data?: { written?: number } })?.data?.written ?? 0
    if (written > 0) message.success(t('stallTriage.nudged'))
    else message.warning(t('stallTriage.nudgeFailed'))
  } catch {
    message.error(t('stallTriage.nudgeFailed'))
  } finally {
    nudging.value = false
  }
}

/** 打开会话：人工确认现场（分诊建议的第一步）。项目会话走接管归还链，
 *  系统会话回首页交 OPS 激活意图（大屏卡跳转同款） */
async function jump(): Promise<void> {
  const s = session.value
  const id = triage.sessionId
  triage.close()
  if (!s) return
  if (s.kind === 'shell' && s.projectId) {
    await jumpToProjectSession(s.projectId, s.id, router)
    return
  }
  await jumpToAgentSession(id)
}

/** 终止会话：不可逆动作二次确认（外部接管会话经 destroy 的解除接管语义，
 *  不冒充 kill）；成功后收卡——会话消失，停滞标随对账消失 */
const terminating = ref(false)
async function terminate(): Promise<void> {
  const s = session.value
  if (!s || terminating.value) return
  const ok = await confirmDialog({
    title: t('stallTriage.terminateConfirmTitle'),
    content: t('stallTriage.terminateConfirmBody', { name: s.name || triage.sessionId }),
    type: 'error',
    confirmText: t('stallTriage.terminate'),
  })
  if (!ok) return
  terminating.value = true
  try {
    await sessionsStore.destroy(triage.sessionId)
    message.success(t('stallTriage.terminated'))
    triage.close()
  } finally {
    terminating.value = false
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="t('stallTriage.title')"
    style="width: var(--modal-w-md); max-width: 94vw"
    :mask-closable="true"
    data-testid="stall-triage-dialog"
    @update:show="triage.close()"
  >
    <div
      v-if="session"
      class="stc-body"
    >
      <div class="stc-head">
        <span
          class="stc-name"
          :title="session.name"
        >{{ session.name }}</span>
        <span
          v-if="stallMin > 0"
          class="stc-stall-badge"
        >{{ t('stallTriage.stallBadge', { n: stallMin }) }}</span>
      </div>

      <!-- 现场判读：任务侧 vs 终端侧，两侧证据并排给出（分诊 = 对比着看） -->
      <div class="stc-row">
        <span class="stc-label">{{ t('stallTriage.taskLabel') }}</span>
        <div class="stc-value">
          <template v-if="progress">
            <span class="stc-task">{{ progress.task || t('stallTriage.taskNone') }}</span>
            <span
              v-if="progress.step"
              class="stc-step"
            >{{ progress.step }}</span>
            <span
              v-if="progress.steps.length > 0"
              class="stc-meta"
            >{{ t('stallTriage.taskSteps', { done: doneSteps, total: progress.steps.length }) }}</span>
            <span class="stc-meta">{{ relTime(progress.updatedAt) }}</span>
          </template>
          <span
            v-else
            class="stc-meta"
          >{{ t('stallTriage.taskNone') }}</span>
        </div>
      </div>
      <div class="stc-row">
        <span class="stc-label">{{ t('stallTriage.shellLabel') }}</span>
        <div class="stc-value">
          <span>{{ shellStateKey ? t(shellStateKey) : '—' }}</span>
          <span
            v-if="stallMin > 0"
            class="stc-meta"
          >{{ t('stallTriage.silentFor', { n: stallMin }) }}</span>
        </div>
      </div>
      <div class="stc-row">
        <span class="stc-label">{{ t('stallTriage.lastCmdLabel') }}</span>
        <div class="stc-value">
          <template v-if="lastCmd">
            <span
              class="stc-cmd"
              :title="lastCmd.command || ''"
            >{{ lastCmd.command || '—' }}</span>
            <span
              v-if="lastCmd.exitCode !== undefined"
              class="stc-exit"
              :class="{ 'is-fail': lastCmd.exitCode !== 0 }"
            >{{ t('stallTriage.exitCode', { n: lastCmd.exitCode }) }}</span>
            <span class="stc-meta">{{ relTime(lastCmd.at) }}</span>
          </template>
          <span
            v-else
            class="stc-meta"
          >{{ t('stallTriage.noCmdRecord') }}</span>
        </div>
      </div>

      <!-- pending 审批注记（P-198 同源判据）：停滞可能正是在等裁决 -->
      <div
        v-if="hasPendingApproval"
        class="stc-note"
        data-testid="stall-triage-pending-note"
      >
        {{ t('stallTriage.pendingNote') }}
      </div>
      <!-- 归因提示（诚实边界）：只描述证据，不冒充诊断 -->
      <div class="stc-note">
        {{ t('stallTriage.hint', { n: stallMin > 0 ? stallMin : 5 }) }}
      </div>
    </div>

    <template #footer>
      <div class="stc-actions">
        <n-button
          size="small"
          secondary
          :title="t('stallTriage.nudgeTitle')"
          :loading="nudging"
          data-testid="stall-triage-nudge"
          @click="nudge"
        >
          <template #icon>
            <n-icon><PulseOutline /></n-icon>
          </template>
          {{ t('stallTriage.nudge') }}
        </n-button>
        <n-button
          size="small"
          secondary
          :disabled="!session"
          data-testid="stall-triage-jump"
          @click="jump"
        >
          <template #icon>
            <n-icon><OpenOutline /></n-icon>
          </template>
          {{ t('stallTriage.jump') }}
        </n-button>
        <n-button
          size="small"
          type="error"
          secondary
          :disabled="!session"
          :loading="terminating"
          data-testid="stall-triage-terminate"
          @click="terminate"
        >
          <template #icon>
            <n-icon><TrashOutline /></n-icon>
          </template>
          {{ t('stallTriage.terminate') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.stc-body { display: flex; flex-direction: column; gap: 10px; }
.stc-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.stc-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 停滞强标同款警示档（与三宿主行内标同色系，卡内重现保持判读一致） */
.stc-stall-badge {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.5;
  padding: 0 6px;
  border-radius: 4px;
  color: var(--status-waiting);
  border: 1px solid color-mix(in srgb, var(--status-waiting) 55%, transparent);
}
.stc-row { display: flex; gap: 10px; align-items: baseline; }
.stc-label {
  flex-shrink: 0;
  width: 64px;
  font-size: 12px;
  color: var(--text-muted);
}
.stc-value {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
  font-size: 12px;
  color: var(--text-body);
}
.stc-task { font-weight: 500; color: var(--text-primary); word-break: break-all; }
.stc-step { color: var(--text-secondary); word-break: break-all; }
.stc-meta { font-size: 11px; color: var(--text-dim); }
.stc-cmd {
  font-family: var(--font-mono);
  font-size: 11px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stc-exit {
  font-size: 11px;
  color: var(--status-success);
  font-family: var(--font-mono);
}
.stc-exit.is-fail { color: var(--status-failed); }
.stc-note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-radius: 6px;
  padding: 6px 8px;
}
.stc-actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
