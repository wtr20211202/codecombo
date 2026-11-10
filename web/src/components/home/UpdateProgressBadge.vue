<script setup lang="ts">
/**
 * 全局更新进度徽标（P-20261109-10）：自更新进行中/刚出结局时 App 层常驻、全路由
 * 可见——离开版本面板（关弹窗/切路由/做别的事）也能随时看到实时阶段与下载百分比。
 * ApprovalModeBadge 同款先例：独立 fixed 锚点、z 1500 低于 modal（指示不挡浮层）、
 * 非模态（只看不拦，更新全程可做别的事）。
 * 点击：进行中/失败/回滚/未知 → 打开版本面板（设置 → 关于，大屏路由先回首页）；
 * 成功 → 刷新页面（自更新后本页仍跑旧 bundle，刷新才加载新界面）。结局态可 ×
 * 关闭；结局 toast 在此单点发出（面板不重复，多标签各出各的属本页反馈）。
 * 落点左下：右下角是审批卡堆/放行徽标/「最近裁决」触发条的锚点（三者已有让位
 * 互动），左下与之镜像不争位。项目页清开左侧活动栏与底部状态栏；底部面板打开
 * 且非最大化时抬到面板上沿之上（App.vue stackPanelYield 同公式），不压面板行。
 * 状态零自持：全部取自 updateProgress store。
 */
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NIcon, useMessage } from 'naive-ui'
import { CloseOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { useUpdateProgressStore, phaseLabelKey, type UpdateOutcome } from '../../stores/updateProgress'

const { t } = useI18n()
const message = useMessage()
const route = useRoute()
const progress = useUpdateProgressStore()
const { showBottomPanel, bottomPanelHeight, bottomPanelMaximized, bottomPanelEditorMaximized, terminalMaximized } = usePanelLayout()

// 项目页让位：活动栏 44px + 间距、状态栏 24px（StatusBar.vue .status-bar）+ 间距
const RAIL_CLEAR_PX = 56
const STATUS_BAR_H = 24
const anchorStyle = computed<Record<string, string> | undefined>(() => {
  if (route.path !== '/project') return undefined
  const panelOpen = showBottomPanel.value && !bottomPanelMaximized.value
    && !bottomPanelEditorMaximized.value && !terminalMaximized.value
  const bottom = STATUS_BAR_H + (panelOpen ? bottomPanelHeight.value : 0) + 8
  return { left: `${RAIL_CLEAR_PX}px`, bottom: `${bottom}px` }
})

const phaseText = computed(() => t(phaseLabelKey(progress.phase)))

const label = computed(() => {
  const o = progress.outcome
  if (o) {
    if (o.phase === 'success') {
      return o.version ? t('update.badge.success', { version: o.version }) : t('update.badge.successBare')
    }
    if (o.phase === 'rolled_back') return t('update.badge.rolledBack')
    if (o.phase === 'unknown') return t('update.badge.unknown')
    return t('update.badge.failed')
  }
  if (progress.phase === 'downloading' && progress.percent > 0) {
    return t('update.badge.runningPercent', { phase: phaseText.value, percent: progress.percent })
  }
  return t('update.badge.running', { phase: phaseText.value })
})

const tip = computed(() =>
  progress.outcome?.phase === 'success' ? t('update.badge.tipSuccess') : t('update.badge.tip'))

/** 色调：进行中 running / 成功 success / 失败与未知 failed / 回滚 waiting */
const tone = computed(() => {
  const ph = progress.outcome?.phase
  if (!ph) return 'running'
  if (ph === 'success') return 'success'
  if (ph === 'rolled_back') return 'waiting'
  return 'failed'
})

/** 下载阶段且有字节进度 → 确定进度条；其余在途阶段 → 不定进度（流动条） */
const determinate = computed(() => progress.phase === 'downloading' && progress.percent > 0)

function onClick(): void {
  if (progress.outcome?.phase === 'success') {
    window.location.reload()
    return
  }
  void progress.openPanel()
}

function toastOutcome(o: UpdateOutcome): void {
  if (o.phase === 'success') {
    message.success(o.version ? t('update.notify.successTitle', { version: o.version }) : t('update.notify.successTitleBare'))
  } else if (o.phase === 'rolled_back') {
    message.warning(t('update.notify.rolledBackTitle'))
  } else if (o.phase === 'unknown') {
    message.warning(t('update.phase.unknown'))
  } else {
    message.error(t('update.notify.failedTitleBare'))
  }
}

// 结局边沿（无 → 有）出一次 toast：dismiss 清空后再出结局才会再提示
watch(() => progress.outcome, (o, prev) => {
  if (o && !prev) toastOutcome(o)
})
</script>

<template>
  <div
    v-if="progress.badgeVisible"
    class="upd-badge"
    :class="`upd-badge--${tone}`"
    :style="anchorStyle"
    data-testid="update-progress-badge"
  >
    <button
      type="button"
      class="upd-badge-main"
      :title="tip"
      data-testid="update-progress-badge-main"
      @click="onClick"
    >
      <span class="upd-badge-dot" />
      <span
        class="upd-badge-text"
        data-testid="update-progress-badge-text"
      >{{ label }}</span>
    </button>
    <button
      v-if="progress.outcome"
      type="button"
      class="upd-badge-close"
      :title="t('update.badge.dismiss')"
      :aria-label="t('update.badge.dismiss')"
      data-testid="update-progress-badge-dismiss"
      @click.stop="progress.dismiss()"
    >
      <n-icon size="12">
        <CloseOutline />
      </n-icon>
    </button>
    <span
      v-if="progress.inFlight"
      class="upd-badge-bar"
      :class="{ 'upd-badge-bar--indeterminate': !determinate }"
    >
      <span
        class="upd-badge-fill"
        :style="determinate ? { width: progress.percent + '%' } : undefined"
      />
    </span>
  </div>
</template>

<style scoped>
/* 独立 fixed 锚点（左下，与右下审批族镜像不争位）；z 1500 刻意低于 modal
   （~2000+）高于页面内容——指示让位浮层，见组件头注释 */
.upd-badge {
  position: fixed; left: 16px; bottom: 16px; z-index: 1500;
  display: inline-flex; align-items: center; gap: 2px;
  max-width: min(360px, calc(100vw - 32px));
  border: 1px solid var(--status-running); border-radius: 999px;
  background: var(--bg-panel); color: var(--text-primary);
  box-shadow: var(--shadow-pop-sm);
  overflow: hidden;
}
.upd-badge--success { border-color: var(--status-success); }
.upd-badge--failed { border-color: var(--status-failed); }
.upd-badge--waiting { border-color: var(--status-waiting); }
.upd-badge-main {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0;
  border: none; background: transparent; color: inherit;
  font-size: 0.72em; line-height: 1.4; padding: 4px 10px;
  cursor: pointer;
}
.upd-badge-main:hover { filter: brightness(1.1); }
.upd-badge-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upd-badge-dot {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  background: var(--status-running);
  animation: upd-badge-pulse 1.2s ease-in-out infinite;
}
.upd-badge--success .upd-badge-dot { background: var(--status-success); animation: none; }
.upd-badge--failed .upd-badge-dot { background: var(--status-failed); animation: none; }
.upd-badge--waiting .upd-badge-dot { background: var(--status-waiting); animation: none; }
.upd-badge-close {
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: var(--text-dim);
  padding: 4px 8px 4px 2px; cursor: pointer;
}
.upd-badge-close:hover { color: var(--text-primary); }
/* 底边进度条：下载阶段按字节百分比，其余在途阶段流动条 */
.upd-badge-bar {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  background: var(--border-default);
}
.upd-badge-fill {
  display: block; height: 100%; width: 0;
  background: var(--status-running);
}
.upd-badge-bar--indeterminate .upd-badge-fill {
  width: 30%;
  animation: upd-badge-flow 1.4s ease-in-out infinite;
}
@keyframes upd-badge-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@keyframes upd-badge-flow {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(340%); }
}
@media (prefers-reduced-motion: reduce) {
  .upd-badge-dot, .upd-badge-bar--indeterminate .upd-badge-fill { animation: none; }
}
</style>
