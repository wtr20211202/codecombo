<script setup lang="ts">
// 跨项目实时变更流卡（P-20261003-232）：值班大屏的「刚刚发生了什么」——
// file.changed 跨项目聚合时间线（项目徽标 + 文件 + 相对时间，同项目 2s 窗
// 去抖分批）。数据走 useChangeStream（与活动栏独立面板同源）：挂载启动
// 5s 轮询 + defineExpose refresh() 供大屏 refreshAll（R 键/刷新按钮）同步。
// 常显卡：实例空闲空态时同样在位（MonitorView 在 isEmpty 守卫之外渲染）。
// 条目可点深链（P-20261006-52，语义见 ChangeStreamTimeline/useChangeStream）。
// 样式自包含镜像 mon-card 卡片语言——scoped
// 样式只有子组件根节点会拿到父作用域（InstanceHealthCard/FleetNotifyCard
// 同款注记）
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useChangeStream } from '../../composables/useChangeStream'
import ChangeStreamTimeline from './ChangeStreamTimeline.vue'

const { t } = useI18n()
const { batches, failed, loaded, dropped, refresh, start, stop } = useChangeStream()

onMounted(start)
onBeforeUnmount(stop)
defineExpose({ refresh })
</script>

<template>
  <article
    class="csc-card"
    data-testid="monitor-change-stream-card"
  >
    <div class="csc-head">
      <span class="csc-kind">{{ t('changeStream.title') }}</span>
      <span
        v-if="failed && loaded"
        class="csc-stale"
        data-testid="change-stream-stale"
      >{{ t('changeStream.staleHint') }}</span>
    </div>
    <ChangeStreamTimeline
      v-if="batches.length > 0"
      :batches="batches"
      :dropped="dropped"
      compact
      class="csc-list"
    />
    <div
      v-else
      class="csc-empty"
      data-testid="change-stream-empty"
    >
      {{ failed && !loaded ? t('changeStream.loadFailed') : t('changeStream.empty') }}
    </div>
    <div class="csc-foot">{{ t('changeStream.cardHint', { sec: 5 }) }}</div>
  </article>
</template>

<style scoped>
/* 镜像 mon-card 卡片语言（值班大屏 .mon-wall 网格内消费），见文件头注释 */
.csc-card {
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  box-shadow: var(--shadow-soft);
}
.csc-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.csc-kind {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  flex-shrink: 0;
}
.csc-stale {
  margin-left: auto;
  font-size: 10px;
  color: var(--accent-yellow-warm);
  flex-shrink: 0;
}
.csc-list {
  flex: 1;
  min-height: 0;
  /* 卡墙网格按内容撑高：时间线钳到 ~10 行（紧凑行高），更旧的事件让位给
     独立面板全量看——值班卡以速览为界，不把卡墙撑成滚动页 */
  max-height: 244px;
  overflow: hidden;
}
.csc-empty {
  font-size: 12px;
  color: var(--text-muted);
}
.csc-foot {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
