<script setup lang="ts">
/**
 * 审批模式自学习建议条（P-20261006-28）：用户近 7 天同 op 前缀手动允许 ≥3 次
 * 且无规则覆盖时，建议把该模式升格为审批规则（P-35 规则可发现性缺口——每次
 * 都点允许但不知道规则可以固化这个模式）。检测/节流收口在
 * useApprovalRuleSuggest（utils/approvalPattern 纯函数面），本组件只负责
 * 呈现 + 三个动作：
 * - 首次展示落 7 天节流（提案：同模式只建议一次；标记在展示时刻而非关闭
 *   时刻——不点「暂不」只无视也不会重复打扰）
 * - 「创建规则」→ 规则表单预填该 op 前缀（用户确认粒度后自行保存）；大屏
 *   路由先回首页（设置弹窗 show 宿主监听随首页注册，ApprovalModeBadge
 *   openRecovery 同款前置）
 * - 「暂不」→ 会话内收起（7 天节流已由展示标记兜底）
 *
 * 全局卡片堆（ApprovalCards）与值班大屏（MonitorView）共用的单一实现
 * （ApprovalGuideBar 同款双宿主单实现），非弹窗不抢焦点——卡片内附属层。
 */
import { nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '../../composables/useI18n'
import {
  requestApprovalRulePrefill,
  useApprovalRuleSuggest,
} from '../../composables/useApprovalRuleSuggest'
import type { ApprovalPatternSuggestion } from '../../utils/approvalPattern'

const props = defineProps<{
  /** 宿主算好的建议（pending 堆首个过三门者；null = 不渲染） */
  suggestion: ApprovalPatternSuggestion | null
}>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { dismiss, markShown } = useApprovalRuleSuggest()

// 首次展示即落 7 天节流（见头注释）。watch 而非 onMounted：宿主建议从无到有
// /换模式时同样要标；双宿主同帧各标一次幂等（同键覆盖）
watch(() => props.suggestion?.pattern, (p) => { if (p) markShown(p) }, { immediate: true })

/** 「创建规则」：预填请求 + 设置弹窗直达安全分区；大屏路由先回首页再发
 *  （nextTick 冲刷让首页宿主监听就位，直达不落空） */
async function createRule(): Promise<void> {
  const pattern = props.suggestion?.pattern
  if (!pattern) return
  if (route.name === 'monitor') {
    await router.push({ name: 'home' })
    await nextTick()
  }
  requestApprovalRulePrefill(pattern)
}
</script>

<template>
  <div
    v-if="suggestion"
    class="aprv-suggest"
    data-test="aprv-rule-suggest"
    role="note"
  >
    <span
      class="aprv-suggest-text"
      data-test="aprv-rule-suggest-text"
    >{{ t('approval.ruleSuggest.text', { n: suggestion.count }) }}</span>
    <!-- 建议固化的前缀（规则表单将预填的值）：等宽芯片可辨，用户在表单里
         确认/改粒度 -->
    <code
      class="aprv-suggest-pattern"
      data-test="aprv-rule-suggest-pattern"
      :title="suggestion.pattern"
    >{{ suggestion.pattern }}</code>
    <span class="aprv-suggest-actions">
      <button
        type="button"
        class="aprv-suggest-create"
        data-test="aprv-rule-suggest-create"
        @click="createRule"
      >
        {{ t('approval.ruleSuggest.create') }}
      </button>
      <button
        type="button"
        class="aprv-suggest-later"
        data-test="aprv-rule-suggest-later"
        @click="dismiss(suggestion.pattern)"
      >
        {{ t('approval.ruleSuggest.later') }}
      </button>
    </span>
  </div>
</template>

<style scoped>
/* 视觉族对齐卡堆附属层（.aprv-guide/.aprv-summary 手法）：中立虚线边弱呈现
   ——建议是发现性引导不是告警，不与 pending 卡的警示虚线争视觉；颜色全走
   主题变量 */
.aprv-suggest {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: var(--bg-panel); border: 1px dashed var(--border-subtle);
  border-radius: 8px; padding: 5px 12px;
}
.aprv-suggest-text { font-size: 0.76em; line-height: 1.5; color: var(--text-secondary); }
.aprv-suggest-pattern {
  font-family: var(--font-mono, monospace); font-size: 0.74em;
  color: var(--text-primary); border: 1px solid var(--border-subtle);
  border-radius: 4px; padding: 0 6px; max-width: 220px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.aprv-suggest-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 10px; }
.aprv-suggest-create,
.aprv-suggest-later {
  appearance: none; font: inherit; border: none; background: none; padding: 0;
  font-size: 0.76em; cursor: pointer; text-underline-offset: 2px;
}
/* 创建规则＝本条唯一主动作，下划线+主文案色引导；暂不弱化为次级 */
.aprv-suggest-create {
  color: var(--text-primary); text-decoration: underline;
}
.aprv-suggest-create:hover,
.aprv-suggest-create:focus-visible { color: var(--status-waiting); }
.aprv-suggest-later { color: var(--text-muted); }
.aprv-suggest-later:hover,
.aprv-suggest-later:focus-visible { color: var(--text-secondary); }
.aprv-suggest-create:focus-visible,
.aprv-suggest-later:focus-visible {
  outline: 1px solid var(--status-waiting); outline-offset: 1px;
}
</style>
