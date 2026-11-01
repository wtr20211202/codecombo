<script setup lang="ts">
/**
 * 放行时限三选一弹层（P-20261003-316）：「完全允许」的二次确认面从二值
 * Popconfirm 升级为三档选择——会话级 / 24 小时（推荐）/ 永久，点击即按档落盘
 * （服务端 ApplyApprovalHorizon 同语义：档位切换总走显式选择）。触发器经默认
 * slot 注入（审批卡与值班大屏两宿主复用），弹层选项行发 apply 事件，档位裁决
 * 链留宿主（useApprovalActions.decide 同一收口）。
 *
 * P-126 全局语义防护精神保留：触发按钮 → 弹层选项 = 两跳显式操作（与原
 * Popconfirm 确认可跳数等价），选项行文案明示各自作用面（本会话/全局 24h/全局
 * 永久），误触不静默放开安全面。z-index 抬过审批卡堆锚点（3000）、低于 modal。
 *
 * 键盘（P-1 键 2 开本弹层）：弹层打开即聚焦首个选项行，行内 1/2/3 直选三档、
 * Esc 关闭；行内 keydown stopPropagation——全局审批热键监听在 document 冒泡位，
 * 弹层在场时数字键归属弹层，两套键位不错位。
 */
import { NButton, NPopover } from 'naive-ui'
import { nextTick, ref } from 'vue'
import { useI18n } from '../../composables/useI18n'
import type { ApprovalHorizon } from '../../api/domains/opsconfirm'

const emit = defineEmits<{ apply: [horizon: ApprovalHorizon] }>()

const { t } = useI18n()

// 受控显隐（单点状态）：触发点击 / 选项行 / 取消钮 / 宿主键盘键 2 链全部收口到
// show——不依赖 naive-ui 实例的命令式 setShow（uncontrolled 模式下与 click 触发
// 器内部状态双源，程序化关闭不可靠）
const show = ref(false)

/** 命令式开合（宿主键盘键 2 链 / 选项行与取消钮共用）：open 即 P-1 旧链的
 *  showAllowAlwaysConfirm 落点，打开后 after-enter 聚焦首选项行 */
function open(): void {
  show.value = true
}
function close(): void {
  show.value = false
}
defineExpose({ open, close })

/** 三档选项元数据（顺序 = 弹层呈现序 = 键盘 1/2/3；24h 为建议档排中间，
 *  「推荐」标记在前两行视觉锚点后仍醒目） */
const TIERS: { horizon: ApprovalHorizon; labelKey: string; descKey: string; testId: string }[] = [
  { horizon: 'session', labelKey: 'approval.tier.session', descKey: 'approval.tier.sessionDesc', testId: 'aprv-tier-session' },
  { horizon: '24h', labelKey: 'approval.tier.h24', descKey: 'approval.tier.h24Desc', testId: 'aprv-tier-24h' },
  { horizon: 'always', labelKey: 'approval.tier.always', descKey: 'approval.tier.alwaysDesc', testId: 'aprv-tier-always' },
]

/** 选项行点击：发档位 + 收弹层（裁决链在宿主） */
function apply(horizon: ApprovalHorizon): void {
  close()
  emit('apply', horizon)
}

/** 弹层打开后聚焦首个选项行（键盘流起点：键 2 → 1/2/3 两段完成） */
function onPopoverAfterShow(): void {
  void nextTick(() => {
    document.querySelector<HTMLElement>('.aprv-tier-pop .aprv-tier-opt')?.focus()
  })
}

/** 选项行键盘：1/2/3 直选 / Esc 收起；stopPropagation 阻断 document 冒泡位
 *  的全局审批热键（弹层在场时数字归属弹层，全局键不错位触发） */
function tierKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  const idx = ['1', '2', '3'].indexOf(e.key)
  if (idx >= 0 && !e.isComposing) {
    e.preventDefault()
    e.stopPropagation()
    apply(TIERS[idx]!.horizon)
  } else if (e.key === 'Enter' || e.key === ' ') {
    // 焦点行 Enter/Space = 点击该行（button 原生语义兜底，防 stopPropagation 后吞点击）
    e.stopPropagation()
  }
}
</script>

<template>
  <n-popover
    :show="show"
    trigger="click"
    placement="top-end"
    :z-index="3100"
    raw
    @update:show="(v: boolean) => { show = v }"
    @after-enter="onPopoverAfterShow"
  >
    <template #trigger>
      <slot />
    </template>
    <div
      class="aprv-tier-pop"
      data-test="aprv-tier-pop"
      role="menu"
      :aria-label="t('approval.tier.title')"
    >
      <div class="aprv-tier-title">
        {{ t('approval.tier.title') }}
      </div>
      <button
        v-for="(tier, i) in TIERS"
        :key="tier.horizon"
        type="button"
        class="aprv-tier-opt"
        :data-test="tier.testId"
        @click="apply(tier.horizon)"
        @keydown="tierKeydown"
      >
        <span class="aprv-tier-key">{{ i + 1 }}</span>
        <span class="aprv-tier-body">
          <span class="aprv-tier-label">
            {{ t(tier.labelKey) }}
            <span
              v-if="tier.horizon === '24h'"
              class="aprv-tier-suggest"
            >{{ t('approval.tier.suggest') }}</span>
          </span>
          <span class="aprv-tier-desc">{{ t(tier.descKey) }}</span>
        </span>
      </button>
      <n-button
        size="tiny"
        quaternary
        class="aprv-tier-cancel"
        data-test="aprv-tier-cancel"
        @click="close"
      >
        {{ t('approval.tier.cancel') }}
      </n-button>
    </div>
  </n-popover>
</template>

<style scoped>
/* raw popover：内容样式自持（scoped 不跨组件，选项行类名供键盘聚焦/测试锚定）。
   颜色全走主题变量；危险档（永久）警示色与审批卡警告色同源 */
.aprv-tier-pop {
  display: flex; flex-direction: column; gap: 6px;
  min-width: 260px; padding: 10px;
  background: var(--bg-panel); border: 1px solid var(--status-waiting);
  border-radius: 8px; box-shadow: var(--shadow-pop-lg);
}
.aprv-tier-title {
  font-size: 0.78em; font-weight: 600; color: var(--text-secondary);
}
.aprv-tier-opt {
  appearance: none; font: inherit; text-align: left; cursor: pointer;
  display: flex; align-items: flex-start; gap: 8px; width: 100%;
  background: none; border: 1px solid var(--border-default);
  border-radius: 6px; padding: 6px 8px;
}
.aprv-tier-opt:hover,
.aprv-tier-opt:focus-visible {
  border-color: var(--status-waiting);
  background: var(--bg-hover);
  outline: none;
}
.aprv-tier-key {
  flex: none; width: 16px; height: 16px; line-height: 16px; text-align: center;
  font-size: 0.72em; color: var(--text-secondary);
  border: 1px solid currentColor; border-radius: 4px; margin-top: 1px;
}
.aprv-tier-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.aprv-tier-label {
  font-size: 0.82em; font-weight: 600; color: var(--text-primary);
  display: inline-flex; align-items: center; gap: 6px;
}
.aprv-tier-suggest {
  font-size: 0.78em; font-weight: 400; padding: 0 5px;
  color: var(--status-waiting); border: 1px solid var(--status-waiting);
  border-radius: 4px;
}
.aprv-tier-desc {
  font-size: 0.74em; color: var(--text-secondary); line-height: 1.45;
}
.aprv-tier-cancel { align-self: flex-end; font-size: 0.74em; }
</style>
