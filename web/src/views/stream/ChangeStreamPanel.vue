<script setup lang="ts">
// 跨项目实时变更流面板（P-20261003-232）：活动栏独立面板形态——值班大屏卡
// 之外的 IDE 内入口，「多项目并行时免逐项目切换感知刚刚发生了什么」。
// 数据与值班卡同源 useChangeStream（各宿主独立实例化，两形态不同路由不会
// 双倍轮询）：挂载启动 5s 轮询，手动刷新同径。条目可点深链（P-20261006-52，
// 语义见 ChangeStreamTimeline/useChangeStream）；服务端重启清空快照 → 空态
// 如实呈现（内存观测面语义）
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { NButton, NIcon, NSpin } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useChangeStream } from '../../composables/useChangeStream'
import { usePanelLayout } from '../../composables/usePanelLayout'
import ChangeStreamTimeline from '../../components/monitor/ChangeStreamTimeline.vue'

const { t } = useI18n()
const { batches, loading, failed, loaded, dropped, refresh, start, stop } = useChangeStream()

onMounted(start)
onBeforeUnmount(stop)
// 侧栏容器是 v-show（SidePanel）：收起侧栏不卸载本面板——轮询随可见性停/起，
// 隐藏态不做无观测价值的后台拉取（值班卡/重开侧栏时 start 即时补拉）
const layout = usePanelLayout()
watch(layout.showSidePanel, (visible) => {
  if (visible) start()
  else stop()
})
</script>

<template>
  <div
    class="cs-panel"
    data-testid="change-stream-panel"
  >
    <div class="csp-header">
      <span class="csp-title">{{ t('changeStream.panelTitle') }}</span>
      <span
        v-if="failed && loaded"
        class="csp-stale"
        data-testid="change-stream-stale"
      >{{ t('changeStream.staleHint') }}</span>
      <NButton
        quaternary
        size="tiny"
        class="csp-refresh"
        :title="t('changeStream.refresh')"
        :aria-label="t('changeStream.refresh')"
        data-testid="change-stream-refresh"
        @click="refresh()"
      >
        <template #icon>
          <NIcon><RefreshOutline /></NIcon>
        </template>
      </NButton>
    </div>
    <NSpin
      :show="loading && !loaded"
      size="small"
      class="csp-spin"
    >
      <div class="csp-body">
        <ChangeStreamTimeline
          v-if="batches.length > 0"
          :batches="batches"
          :dropped="dropped"
        />
        <div
          v-else
          class="csp-empty"
          data-testid="change-stream-empty"
        >
          {{ failed && !loaded ? t('changeStream.loadFailed') : t('changeStream.empty') }}
        </div>
      </div>
    </NSpin>
  </div>
</template>

<style scoped>
.cs-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.csp-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 6px;
  flex-shrink: 0;
}
.csp-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.csp-stale {
  font-size: 10px;
  color: var(--accent-yellow-warm);
}
.csp-refresh {
  margin-left: auto;
}
.csp-spin {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.csp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 10px;
}
.csp-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
