<script setup lang="ts">
/**
 * 智能体提问卡片堆（P-20261001-27，全局常驻）：
 * Agent 长任务需要用户输入时经 ops-ask 提问 → 此处渲染持久卡片（非易逝 toast），
 * 自由文本框或选项按钮双形态作答 → answer API，答案经轮询回流 agent；
 * input.resolved 广播回流多标签页一致清账。与审批卡（ApprovalCards）同锚点
 * 共栈（App 层 .agent-input-stack 包装），提问卡排审批卡之后自然纵向堆叠。
 * 值班大屏（/monitor）自身以卡片墙形态渲染提问，此固定堆在该路由让位隐藏。
 */
import { NButton, NInput } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from '../../composables/useI18n'
import { useAsksStore } from '../../stores/asks'
import type { AskRecord } from '../../api/domains/opsask'
import { useAskActions } from '../../composables/useAskActions'

const { t } = useI18n()
const route = useRoute()
const asks = useAsksStore()
const { agentLabel, answerText, jumpToSession } = useAskActions()

// 大屏路由有专属提问卡（网格内联），固定堆让位避免同屏双份
const isMonitorRoute = computed(() => route.name === 'monitor')

// TTL 到点自清：服务端过期翻转只发生在轮询/列表侧（无广播），无人轮询时
// 前端按 expiresAt 本地兜底巡查，防止卡片滞留；now 同时驱动剩余时间文案
const now = ref(Date.now())
let pruneTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  pruneTimer = setInterval(() => {
    now.value = Date.now()
    asks.pruneExpired(now.value)
  }, 10_000)
})
onBeforeUnmount(() => {
  if (pruneTimer !== null) clearInterval(pruneTimer)
})

/** 剩余有效期文案（分钟向上取整；已到点显示「即将过期」） */
function remainingLabel(a: AskRecord): string {
  if (!a.expiresAt) return ''
  const ms = new Date(a.expiresAt).getTime() - now.value
  if (ms <= 0) return t('ops.ask.expiringNow')
  return t('ops.ask.expiresIn', { n: Math.max(1, Math.ceil(ms / 60000)) })
}

// 自由文本形态的每卡草稿（选项形态无需草稿，点击即答）
const drafts = ref<Record<string, string>>({})
function submitDraft(a: AskRecord) {
  const v = (drafts.value[a.id] || '').trim()
  if (!v) return
  delete drafts.value[a.id]
  void answerText(a.id, v)
}
</script>

<template>
  <div
    v-if="asks.pendingCount > 0 && !isMonitorRoute"
    class="ask-stack"
    role="alertdialog"
    :aria-label="t('ops.ask.title')"
  >
    <div
      v-for="a in asks.pendingList"
      :key="a.id"
      class="ask-card"
    >
      <div class="ask-head">
        <span class="ask-dot" />
        <span class="ask-title">{{ t('ops.ask.title') }}</span>
        <span
          class="ask-agent"
          :title="a.agent || ''"
        >{{ agentLabel(a.agent) }}</span>
        <n-button
          v-if="a.terminalId"
          size="tiny"
          quaternary
          class="ask-jump"
          :title="t('agentTerminal.approvalJumpSession')"
          @click="jumpToSession(a.terminalId)"
        >
          {{ t('agentTerminal.approvalJumpSession') }}
        </n-button>
      </div>
      <div class="ask-question">
        {{ a.question }}
      </div>
      <!-- 选项形态：按钮即答案（answer 取选项原文） -->
      <div
        v-if="a.options && a.options.length > 0"
        class="ask-options"
      >
        <n-button
          v-for="opt in a.options"
          :key="opt"
          size="tiny"
          type="primary"
          secondary
          class="ask-option"
          @click="answerText(a.id, opt)"
        >
          {{ opt }}
        </n-button>
      </div>
      <!-- 自由文本形态：输入 + 提交 -->
      <div
        v-else
        class="ask-input-row"
      >
        <n-input
          v-model:value="drafts[a.id]"
          size="small"
          :placeholder="t('ops.ask.placeholder')"
          class="ask-input"
          @keydown.enter.prevent="submitDraft(a)"
        />
        <n-button
          size="tiny"
          type="primary"
          :disabled="!(drafts[a.id] || '').trim()"
          @click="submitDraft(a)"
        >
          {{ t('ops.ask.submit') }}
        </n-button>
      </div>
      <div
        v-if="remainingLabel(a)"
        class="ask-expiry"
      >
        {{ remainingLabel(a) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.ask-stack {
  display: flex; flex-direction: column; gap: 8px; width: 100%;
}
.ask-card {
  background: var(--bg-panel); border: 1px solid var(--accent-blue);
  border-left-width: 3px; border-radius: 8px; padding: 10px 12px;
  box-shadow: var(--shadow-pop-lg);
}
.ask-head { display: flex; align-items: center; gap: 6px; }
.ask-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent-blue);
  animation: ask-pulse 1.2s ease-in-out infinite;
}
@keyframes ask-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .ask-dot { animation: none; }
}
.ask-title { font-size: 0.82em; font-weight: 600; color: var(--text-primary); }
.ask-agent {
  margin-left: auto; font-size: 0.72em; line-height: 1.4;
  color: var(--text-secondary); border: 1px solid var(--accent-blue);
  border-radius: 4px; padding: 0 6px; opacity: 0.9;
}
.ask-jump { font-size: 0.72em; }
.ask-question {
  margin-top: 6px; font-size: 0.88em; color: var(--text-primary); line-height: 1.5;
  word-break: break-word; white-space: pre-wrap;
}
.ask-options {
  margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end;
}
.ask-option { max-width: 100%; }
.ask-option :deep(.n-button__content) {
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ask-input-row {
  margin-top: 8px; display: flex; gap: 6px; align-items: center;
}
.ask-input { flex: 1; min-width: 0; }
.ask-expiry {
  margin-top: 6px; font-size: 0.72em; color: var(--text-muted);
}
/* 触屏热区放大（P-20261003-128，审批卡同案同栈族）：提问卡的点选项即作答、
   提交按钮是自由文本作答出口——手机作答场景 tiny 按钮（22px）热区远小于
   44px 触控指南，coarse 指针（触屏为主指针的设备）下 min-height 40px +
   按钮间距增大；fine 指针（桌面鼠标）不进此分支，呈现零变化。卡头「跳转」
   辅助小钮与值班大屏内联卡（MonitorView 自持呈现）不放大——前者非作答动作，
   后者是桌面值守面 */
@media (pointer: coarse) {
  .ask-options { gap: 10px; }
  .ask-options .n-button { min-height: 40px; }
  .ask-input-row { gap: 10px; }
  .ask-input-row .n-button { min-height: 40px; }
}
</style>
