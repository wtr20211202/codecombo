<script setup lang="ts">
// 进行中克隆任务常驻指示条（P-20261003-58）：首页头部下缘细条，多任务并列。
// 数据源 useCloneTracker 全会话注册表（弹窗关闭/路由切换不中断跟踪）；条目
// running 态同族视觉（呼吸圆点，AgentSidebarSessionTree ats-pulse 同款节奏），
// 点击经 open 事件由父组件重开 CloneModal 附加进度视图
import { useCloneTracker } from '../../composables/useCloneTracker'
import { useI18n } from '../../composables/useI18n'

const emit = defineEmits<{
  open: [taskId: string]
}>()

const { items } = useCloneTracker()
const { t } = useI18n()
</script>

<template>
  <div
    v-if="items.length > 0"
    class="clone-status-bar"
    data-testid="clone-status-bar"
    :aria-label="t('home.cloneBar.label')"
  >
    <button
      v-for="task in items"
      :key="task.taskId"
      class="clone-status-item"
      data-testid="clone-status-item"
      :title="task.stage || t('layout.clonePreparing')"
      @click="emit('open', task.taskId)"
    >
      <span class="cs-dot" />
      <span class="cs-name">{{ task.name }}</span>
      <span class="cs-stage">{{ task.stage || t('layout.clonePreparing') }}</span>
      <span class="cs-track">
        <span
          class="cs-fill"
          :style="{ width: `${task.progress}%` }"
        />
      </span>
      <span class="cs-percent">{{ task.progress }}%</span>
    </button>
  </div>
</template>

<style scoped>
/* 细指示条：贴首页头部下缘、项目内容之上；条目可点多开，换行容纳多任务 */
.clone-status-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  padding: 5px 28px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.clone-status-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 520px;
  padding: 2px 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  color: var(--text-secondary);
  border-radius: 4px;
  transition: background var(--motion-base);
}
.clone-status-item:hover {
  background: var(--bg-hover);
}

/* running 呼吸圆点：与会话树/任务运行器 running 态同族 */
.cs-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--status-running);
  flex-shrink: 0;
  animation: cs-pulse 1.6s ease-in-out infinite;
}
@keyframes cs-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-running) 45%, transparent); }
  50% { box-shadow: 0 0 0 4px transparent; }
}

.cs-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  flex-shrink: 0;
}
.cs-stage {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* 细进度轨：VersionPanel version-progress 同族（4px + accent-blue 填充） */
.cs-track {
  width: 72px;
  height: 4px;
  border-radius: 2px;
  background: var(--border-default);
  overflow: hidden;
  flex-shrink: 0;
}
.cs-fill {
  display: block;
  height: 100%;
  background: var(--accent-blue);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.cs-percent {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 34px;
  text-align: right;
}
</style>
