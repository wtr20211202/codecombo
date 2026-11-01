<script setup lang="ts">
import { computed } from 'vue'
import { useInstanceStore } from '../../stores/instance'
import { useI18n } from '../../composables/useI18n'
import { useOverlayDwell } from '../../composables/useOverlayDwell'
import { getInstanceDisplayName } from './instanceStatus'

// 实例切换全屏遮罩：盖住切换期间（新实例项目拉取 + 路由决策 + 视图 remount）
// 的陈旧 UI，等新视图首帧渲染后淡出
const instanceStore = useInstanceStore()
const { t } = useI18n()

// 目标实例从 instances 推导（selectInstance 的守卫保证遮罩期间必然能找到）
const target = computed(() =>
  instanceStore.instances.find(i => i.id === instanceStore.switchTargetId) || instanceStore.currentInstance,
)

// 显隐源加最小驻留去抖（P-20261011-1 ②）：switching 直绑网络敏感流程，弱网
// 远控下连续切换/失败重试会让遮罩高频进出（全屏闪烁源）。离场缓冲 150ms +
// 重进静默窗 300ms：短暂回落不闪、连发切换并成一次在场；store 侧另有
// SWITCH_OVERLAY_LINGER_MS=150（等新视图首帧），双层叠加后最短驻留约 300ms
const shown = useOverlayDwell(computed(() => instanceStore.switching), {
  hideDelayMs: 150,
  reenterDelayMs: 300,
})
</script>

<template>
  <!-- :duration 显式钉过渡时长（P-20261011-1 ①同款防御）：transitionend
       丢失（低帧率/事件节流环境）时 Vue 走 setTimeout 兜底 resolve -->
  <Transition
    name="instance-switch-fade"
    :duration="{ enter: 120, leave: 200 }"
  >
    <div
      v-if="shown"
      class="instance-switch-overlay"
    >
      <!-- 复用 App.vue 全局定义的 .app-boot-spinner -->
      <span class="app-boot-spinner" />
      <span class="switch-text">{{ t('instance.switchingTo', { name: getInstanceDisplayName(target) }) }}</span>
    </div>
  </Transition>
</template>

<style scoped>
/* z-index 低于锁屏遮罩（10000）与启动遮罩（10001），高于业务内容 */
.instance-switch-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}
.switch-text {
  font-size: 13px;
  color: var(--text-secondary);
  font-family: var(--font-ui);
}
/* 快速淡入，稍慢淡出；离场 pointer-events:none（P-20261011-1 ②）：
   离场余韵不拦截交互，过渡挂起的残留遮罩不再吞全页点击 */
.instance-switch-fade-enter-active { transition: opacity 0.12s ease; }
.instance-switch-fade-leave-active {
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.instance-switch-fade-enter-from,
.instance-switch-fade-leave-to { opacity: 0; }

/* 串流/触屏环境淡入淡出减半（P-20261011-1 ③，App.vue 全局规则同款机制） */
@media (pointer: coarse) {
  .instance-switch-fade-enter-active { transition-duration: 0.06s; }
  .instance-switch-fade-leave-active { transition-duration: 0.1s; }
}
</style>
