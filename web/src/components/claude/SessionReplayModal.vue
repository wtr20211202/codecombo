<script setup lang="ts">
/**
 * 会话回放弹层宿主（P-20261002-82）：SessionTimeline 的模态包装，供审批卡
 * 「回放」/审批历史列表等入口共用（ClaudeSessionPicker 的内联弹层早于此存在，
 * 不强迁）。focusAt 透传时间线定位：打开后滚动到最近早于该时刻的条目并
 * 呼吸高亮 2s——「审批那一刻前后 agent 在干什么」一步直达。
 *
 * 弹层内「继续此会话」（P-20261002-96）成功即关弹层：恢复链路由时间线自办
 * （新建终端注入 --resume 并激活），宿主只负责收起弹层。
 */
import { NModal } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import type { ClaudeSessionInfo } from '../../api/domains/claude'
import SessionTimeline from './SessionTimeline.vue'

const props = defineProps<{
  show: boolean
  /** 回放目标会话（null = 关闭态占位） */
  session: ClaudeSessionInfo | null
  /** 定位目标时刻（RFC3339，可选）：审批卡入口传审批 createdAt */
  focusAt?: string
  /** 定位目标条目（0-based，可选，P-20261003-154 回放深链）：深链 turn 换算
   *  的精确索引定位，优先于 focusAt 的「最近早于时刻」模糊定位 */
  focusTurn?: number
}>()

const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const { t } = useI18n()
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="session
      ? t('claudeSessions.timelineTitle', { title: session.title.slice(0, 40) })
      : ''"
    :style="{ width: 'var(--modal-w-lg)', maxWidth: '94vw' }"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <div class="srm-body">
      <SessionTimeline
        v-if="session"
        :session="session"
        :focus-at="focusAt"
        :focus-turn="focusTurn"
        @resumed="emit('update:show', false)"
        @summarized="emit('update:show', false)"
      />
    </div>
  </n-modal>
</template>

<style scoped>
.srm-body {
  height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.srm-body > :deep(*) { flex: 1; min-height: 0; }
</style>
