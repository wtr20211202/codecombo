<script setup lang="ts">
/**
 * 全局放行常驻徽标（P-20261002-126 + P-20261003-316 三档化）：审批档位为任一
 * 放行档（会话级 / 24h / 永久）期间，悬浮于右下角审批卡堆同锚点（全路由可见）
 * ——「高危操作正在被静默放行」这一安全面必须常驻可见，不能只在不弹卡的缺席里
 * 被动感知。按档分语：永久「全局放行中」/ 24h 带剩余时限（分钟粒度自走）/
 * 会话级带放行会话数。
 * 层级刻意低于 modal（1500）：放行是指示不是闸门，不得遮挡/挡点设置弹层
 * 等浮层（否则点击徽标打开的恢复入口自身会被徽标挡住保存钮）；审批卡
 * （.agent-input-stack，z 3000）在场时徽标让位于卡片，裁决面优先。P-226 起
 * 卡堆无卡时也常驻「最近裁决」触发条占住本角——该形态下让位方向反转，徽标
 * 上抬到触发条上方（liftAboveRecent），常驻可见性与恢复入口不缩水。
 * 悬停说明全局语义（native title，与审批卡按钮同口径）；点击直达恢复入口
 * （设置 → 通用 → 高危操作审批档位下拉，经 OPEN_SETTINGS_EVENT 既有通道，
 * show 由宿主 Layout/HomeView 监听同一事件置位）。大屏路由（/monitor）无
 * 设置弹窗宿主，先路由回首页待监听挂载后再发定位事件。
 * 档位镜像来源：approvals store（mode/expiresAt/sessionCount——启动首查 +
 * settings.changed 广播跟随 + 档位裁决同帧镜像），本组件零独立状态；24h 到期
 * 由分钟自走钟检测，到点即拉 refreshMode（服务端 10min 巡检物化兜底）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from '../../composables/useI18n'
import { useApprovalsStore } from '../../stores/approvals'
import { openSettingsTab } from '../../utils/openSettings'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const approvals = useApprovalsStore()

const allowActive = computed(() => approvals.allowActive)

// P-226 让位反转（无卡形态）：卡堆无 pending 卡但「最近裁决」触发条常驻本角
// 时（近期有过终态审批的活跃实例近乎恒在），徽标上抬到触发条上方——放行态
// 安全指示与设置恢复入口不得被常驻元素挡死（pending 卡在场仍是徽标让位卡片
// 的既有语义，临时遮挡可接受）。上抬量 = 触发条高 ~28px + 卡堆 gap 8px
// （ApprovalCards 触发条样式若调整需同步此值）；大屏路由卡堆整体让位（不出
// 触发条），无需上抬
const liftAboveRecent = computed(() =>
  approvals.pendingCount === 0 && approvals.recent.length > 0 && route.name !== 'monitor')

/** 24h 剩余时限（分钟粒度）：expiresAt 由 store 镜像，nowMin 自走钟驱动重算；
 *  已到点（≤0）显示「即将恢复询问」弱化态（refreshMode 纠正档位后的下一帧
 *  徽标整体退场） */
const nowMin = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  ticker = setInterval(() => {
    nowMin.value = Date.now()
    // 到点即拉一次镜像（服务端巡检物化最迟 10min 后到，徽标不显陈旧放行态）
    if (approvals.mode === 'allow-24h' && remainingMs.value <= 0) void approvals.refreshMode()
  }, 30_000)
})
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})

const remainingMs = computed(() => {
  if (!approvals.expiresAt) return 0
  return new Date(approvals.expiresAt).getTime() - nowMin.value
})

/** 剩余文案：≥1h 显「Xh Ym」，否则「Ym」；插值走命名参数（vue-i18n 纪律） */
const remainingText = computed(() => {
  const ms = remainingMs.value
  if (ms <= 0) return ''
  const totalMin = Math.ceil(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? t('approval.badge.remainingHM', { h, m }) : t('approval.badge.remainingM', { m })
})

/** 徽标文案（按档分语） */
const badgeText = computed(() => {
  if (approvals.mode === 'allow-24h') {
    return remainingText.value
      ? t('approval.badge.h24', { remaining: remainingText.value })
      : t('approval.badge.h24Ending')
  }
  if (approvals.mode === 'allow-session') {
    return t('approval.badge.session', { n: approvals.sessionCount })
  }
  return t('approval.badge.always')
})

/** 悬停说明（按档分语，恢复入口指引同原） */
const badgeTip = computed(() => {
  if (approvals.mode === 'allow-24h') return t('approval.badge.tip24h')
  if (approvals.mode === 'allow-session') return t('approval.badge.tipSession')
  return t('approval.badge.tipAlways')
})

/** 恢复入口：设置弹窗定位「通用」分区。大屏路由先回首页——OPEN_SETTINGS_EVENT
 * 的 show 宿主监听（useHomeGlobalListeners）随 HomeView 挂载注册，nextTick
 * 冲刷后再发事件，直达不落空 */
async function openRecovery(): Promise<void> {
  if (route.name === 'monitor') {
    await router.push({ name: 'home' })
    await nextTick()
  }
  openSettingsTab('general')
}
</script>

<template>
  <button
    v-if="allowActive"
    type="button"
    class="aprv-allow-badge"
    :class="{ 'aprv-allow-badge--lifted': liftAboveRecent }"
    data-test="aprv-allow-badge"
    :title="badgeTip"
    :aria-label="badgeTip"
    @click="openRecovery"
  >
    <span class="aprv-allow-dot" />
    {{ badgeText }}
  </button>
</template>

<style scoped>
/* 独立 fixed 锚点与审批卡堆同角（bottom 76 清开底部工具条）；z 1500 刻意
   低于 modal（~2000+）高于页面内容——指示让位浮层，见组件头注释 */
.aprv-allow-badge {
  position: fixed; right: 16px; bottom: 76px; z-index: 1500;
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--status-waiting); border-radius: 999px;
  background: var(--bg-panel); color: var(--text-primary);
  font-size: 0.72em; line-height: 1.4; padding: 3px 10px;
  cursor: pointer; box-shadow: var(--shadow-pop-sm);
}
.aprv-allow-badge:hover { border-color: var(--status-waiting); filter: brightness(1.1); }
/* 无卡仅「最近裁决」触发条形态的上抬位（liftAboveRecent）：底距 = 原位 76px
   + 触发条高 ~28px + 卡堆 gap 8px——ApprovalCards 触发条样式若调整需同步 */
.aprv-allow-badge--lifted { bottom: 112px; }
.aprv-allow-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--status-waiting);
  animation: aprv-allow-pulse 1.2s ease-in-out infinite;
}
@keyframes aprv-allow-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .aprv-allow-dot { animation: none; }
}
</style>
