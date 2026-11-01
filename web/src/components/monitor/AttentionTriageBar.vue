<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useAssistantTaskStore } from '../../stores/assistantTask'
import { useApprovalsStore } from '../../stores/approvals'
import { useNotificationStore } from '../../stores/notification'

/**
 * 值班大屏「需注意」分诊条（P-20261005-164）：四类异常信号的第一眼聚合。
 *
 * 开屏逐卡扫（任务卡找失败 / 审批卡数 pending / 失联徽标逐个认 / 通知中心
 * 翻今日告警）收口为一行 chips，判定阈值零新增、全沿既有 store 口径：
 * - N 任务失败：assistantTask.bySession 终态 failed（真终态保留供回看，不清账）
 * - N 待审批：approvals.pendingCount
 * - N 会话停滞：assistantTask.staleSessionIds（P-303 失联 getter，任务卡
 *   「可能已失联」徽标同源判定）——落点在任务类目区，计数与所见徽标一致
 * - 今日 N 告警：通知中心今日 error 级条目；延后中（snoozeUntil）不算——
 *   尊重 P-36 专注保护语义（延后中的条目徽标保持沉默，unreadCount 同口径）
 *
 * 零轮询：随各 store 响应式更新（通知经 WS / 大屏补账链入账）；全零整行
 * 隐藏（无事不扰）。点击 chip 上抛 locate 由宿主滚动定位到类目区（类目区
 * DOM 在宿主 MonitorView）；告警 chip 就地开通知中心——面板挂 App 层
 * （App.vue），/monitor 独立路由下同样可用。与编队聚合卡（P-20261005-145）
 * 同视图亲和：编队批内失败在任务类目区亦有同源失败卡，两侧计数互为详略。
 */

/** chip 点击去向：tasks/approvals = 宿主类目区滚动定位；alerts = 开通知中心 */
type AttentionTarget = 'tasks' | 'approvals' | 'alerts'

const emit = defineEmits<{ (e: 'locate', target: Exclude<AttentionTarget, 'alerts'>): void }>()

const { t } = useI18n()
const assistantTask = useAssistantTaskStore()
const approvals = useApprovalsStore()
const notification = useNotificationStore()

interface AttentionChip {
  key: 'failed' | 'approvals' | 'stalled' | 'alerts'
  label: string
  /** 语义色档（主题 token）：failed=红（status-failed）/ waiting=警示橙黄（status-waiting） */
  tone: 'failed' | 'waiting'
  target: AttentionTarget
}

const chips = computed<AttentionChip[]>(() => {
  // 读心跳时钟登记依赖：「今日」窗口跨零点随 30s 心跳重算（值班大屏常驻
  // 页面，sessionCards 同款先例——agent 死后无事件驱动，无 tick 计数冻结）
  void assistantTask.nowTick
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const failed = Object.values(assistantTask.bySession).filter(v => v.status === 'failed').length
  const pending = approvals.pendingCount
  const stalled = assistantTask.staleSessionIds.size
  const alerts = notification.items.filter(n =>
    n.type === 'error' && !n.snoozeUntil && Date.parse(n.time) >= dayStart.getTime()).length
  const out: AttentionChip[] = []
  if (failed > 0) out.push({ key: 'failed', label: t('monitorBoard.attention.failedTasks', { n: failed }), tone: 'failed', target: 'tasks' })
  if (pending > 0) out.push({ key: 'approvals', label: t('monitorBoard.attention.pendingApprovals', { n: pending }), tone: 'waiting', target: 'approvals' })
  if (stalled > 0) out.push({ key: 'stalled', label: t('monitorBoard.attention.stalledSessions', { n: stalled }), tone: 'waiting', target: 'tasks' })
  if (alerts > 0) out.push({ key: 'alerts', label: t('monitorBoard.attention.todayAlerts', { n: alerts }), tone: 'failed', target: 'alerts' })
  return out
})

function onChip(c: AttentionChip): void {
  if (c.target === 'alerts') {
    notification.open()
    return
  }
  emit('locate', c.target)
}
</script>

<template>
  <div
    v-if="chips.length > 0"
    class="attn-bar"
    data-testid="monitor-attention-bar"
  >
    <span class="attn-title">{{ t('monitorBoard.attention.title') }}</span>
    <button
      v-for="c in chips"
      :key="c.key"
      class="attn-chip"
      :class="`is-${c.tone}`"
      :data-testid="`monitor-attention-chip-${c.key}`"
      :title="t('monitorBoard.attention.locateTip')"
      @click="onChip(c)"
    >
      {{ c.label }}
    </button>
  </div>
</template>

<style scoped>
/* 顶部固定（sticky 钉在视口顶，滚读长卡片墙时异常信号常驻余光）；零 chip
   整行不渲染（无事不扰），出现/消失随信号自然进出不占布局 */
.attn-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 24px;
  background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
  backdrop-filter: blur(6px);
  border-bottom: 1px solid var(--border-default);
}
.attn-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.attn-chip {
  font-size: 12px;
  line-height: 1.6;
  padding: 1px 10px;
  border-radius: 999px;
  cursor: pointer;
  background: transparent;
  transition: background var(--motion-base);
}
/* 语义色沿状态 token 四档（P-20261003-285）：失败/告警红、待审批/停滞警示
   橙黄——与大屏任务失败卡红边、审批卡橙边同语言，跨面「同语义同色」 */
.attn-chip.is-failed {
  color: var(--status-failed);
  border: 1px solid color-mix(in srgb, var(--status-failed) 55%, transparent);
}
.attn-chip.is-failed:hover { background: color-mix(in srgb, var(--status-failed) 12%, transparent); }
.attn-chip.is-waiting {
  color: var(--status-waiting);
  border: 1px solid color-mix(in srgb, var(--status-waiting) 55%, transparent);
}
.attn-chip.is-waiting:hover { background: color-mix(in srgb, var(--status-waiting) 12%, transparent); }
.attn-chip:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}
</style>
