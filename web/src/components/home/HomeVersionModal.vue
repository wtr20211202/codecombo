<script setup lang="ts">
import AppLogo from '../common/AppLogo.vue'
import VersionPanel from './VersionPanel.vue'

/**
 * 首页版本信息弹窗（自 HomeView 抽出的纯 UI）：
 * 展示版本/commit/构建信息，commit 点击复制由宿主处理（copyCommitId 事件）。
 */
defineProps<{
  show: boolean
  buildInfo: {
    version: string
    commit: string
    buildTime: string
    goVersion: string
    platform: string
  } | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'copyCommit'): void
  (e: 'updateDetected'): void
}>()
</script>

<template>
  <div
    v-if="show && buildInfo"
    class="version-overlay"
    @click.self="emit('close')"
  >
    <div class="version-card">
      <div class="version-card-header">
        <div class="version-card-title">
          <AppLogo :size="24" />
          <span class="version-card-name">Codecombo</span>
        </div>
        <button
          class="version-close"
          @click="emit('close')"
        >
          &times;
        </button>
      </div>
      <VersionPanel
        :build-info="buildInfo"
        @update-detected="emit('updateDetected')"
      />
    </div>
  </div>
</template>

<style scoped>
.version-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: var(--overlay-mask);
  display: flex;
  align-items: center;
  justify-content: center;
}
.version-card {
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  width: 480px;
  max-width: calc(100vw - 32px);
  /* 视口钳高内滚（P-20261109-10 R11）：卡片随内容增高（更新说明/进度/结局块）
     超出视口时，居中布局会把上下两端裁出视口且无从滚动 */
  max-height: calc(100vh - 32px);
  box-shadow: var(--shadow-pop-lg);
  overflow-x: hidden;
  overflow-y: auto;
}
.version-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
}
.version-card-title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.version-card-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}
.version-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.version-close:hover { color: var(--text-primary); }
</style>
