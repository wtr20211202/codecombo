<script setup lang="ts">
/**
 * 审批卡首触说明条（P-20261003-311）：新用户的第一张审批卡是懵的——agent
 * 为什么突然停了？「允许/拒绝」各意味什么？「完全允许」为什么有二次确认和
 * 常驻指示？手册面向 agent 不面向用户，本条补用户侧认知层：首次出现审批卡
 * （localStorage 一次性标记）时在卡顶展示三行说明（agent 在等你裁决高危操作
 * / 允许=继续执行 拒绝=中止该操作 / 完全允许=同类不再询问，设置页可改回）。
 *
 * 本组件是全局卡片堆（ApprovalCards）与值班大屏（MonitorView）共用的单一
 * 实现：同标记键（useApprovalGuide 单例），两处首触语义一致。展开/收起为
 * 组件内会话级状态（默认展开保证首触可读，收起只收本次，刷新或下次首触
 * 恢复展开）；「不再显示」经 useApprovalGuide.dismiss 落一次性标记后永不
 * 重现。挂载时机归宿主（有审批卡在场才挂载），本组件不感知卡堆状态。
 */
import { ref } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useApprovalGuide } from '../../composables/useApprovalGuide'

const { t } = useI18n()
const { dismissed, dismiss } = useApprovalGuide()

// 展开/收起：默认展开（首触引导收起即失去意义）；仅会话内记忆（不持久化）
const expanded = ref(true)
</script>

<template>
  <div
    v-if="!dismissed"
    class="aprv-guide"
    data-test="aprv-guide"
  >
    <button
      type="button"
      class="aprv-guide-head"
      data-test="aprv-guide-toggle"
      :title="expanded ? t('approval.guide.collapse') : t('approval.guide.expand')"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="aprv-guide-mark">{{ t('approval.guide.title') }}</span>
      <span class="aprv-guide-toggle">{{ expanded ? t('approval.guide.collapse') : t('approval.guide.expand') }}</span>
    </button>
    <!-- 三行说明（提案定稿文案口径）：首触即读，收起后可再展开 -->
    <ul
      v-show="expanded"
      class="aprv-guide-lines"
      data-test="aprv-guide-lines"
    >
      <li>{{ t('approval.guide.line1') }}</li>
      <li>{{ t('approval.guide.line2') }}</li>
      <li>{{ t('approval.guide.line3') }}</li>
    </ul>
    <div class="aprv-guide-foot">
      <button
        type="button"
        class="aprv-guide-dismiss"
        data-test="aprv-guide-dismiss"
        :title="t('approval.guide.dismiss')"
        @click="dismiss"
      >
        {{ t('approval.guide.dismiss') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 视觉族对齐审批卡（.aprv-card 黄暖虚线族）：说明条是卡的附属认知层，
   虚线边与卡片实线区分层次（同 .aprv-summary 手法）；颜色全走主题变量 */
.aprv-guide {
  background: var(--bg-panel); border: 1px dashed var(--status-waiting);
  border-radius: 8px; padding: 6px 12px;
}
.aprv-guide-head {
  appearance: none; font: inherit; line-height: 1.4; text-align: left;
  display: flex; align-items: center; gap: 8px; width: 100%;
  background: none; border: none; padding: 0; cursor: pointer;
  color: var(--text-primary);
}
.aprv-guide-mark { font-size: 0.8em; font-weight: 600; }
.aprv-guide-toggle { margin-left: auto; font-size: 0.75em; opacity: 0.85; color: var(--text-secondary); }
.aprv-guide-lines {
  margin: 4px 0 0; padding-left: 18px;
  font-size: 0.78em; line-height: 1.6; color: var(--text-secondary);
}
.aprv-guide-foot { display: flex; justify-content: flex-end; margin-top: 2px; }
.aprv-guide-dismiss {
  appearance: none; font: inherit; border: none; background: none; padding: 0;
  font-size: 0.72em; color: var(--text-muted); cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.aprv-guide-dismiss:hover,
.aprv-guide-dismiss:focus-visible { color: var(--text-primary); }
.aprv-guide-dismiss:focus-visible {
  outline: 1px solid var(--accent-yellow-warm); outline-offset: 1px;
}
</style>
