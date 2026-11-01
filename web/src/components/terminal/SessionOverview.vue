<script setup lang="ts">
import { NIcon } from 'naive-ui'
import { GridOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import type { SessionGroup, SessionSummary, SessionStatus } from '../../utils/sessionOverview'

// 会话总览浮层：跨项目终端会话一览（多项目并行开发时快捷切换 + 进度感知）。
// 只渲染不持有状态：分组数据由宿主（TerminalView）从既有 tabs 状态计算传入。
// 点击会话条目上抛 jump(tabId, projectId)——跨项目条目由宿主先 selectProject 再选中 tab。

defineProps<{
  groups: SessionGroup[]
  summary: SessionSummary
}>()

const emit = defineEmits<{
  (e: 'jump', tabId: string, projectId: string): void
  (e: 'close'): void
}>()

const { t } = useI18n()

// 状态点语义：运行中（强调色呼吸）/ 失败（红）/ 正常（绿）/ 从未执行（暗）
function dotClass(status: SessionStatus): string {
  return `so-dot-${status}`
}

function statusText(status: SessionStatus, exitCode?: number): string {
  if (status === 'running') return t('terminal.overview.running')
  if (status === 'failed') return t('terminal.overview.failed', { code: exitCode ?? '?' })
  if (status === 'ok') return t('terminal.overview.ok')
  return t('terminal.overview.new')
}

function onJump(tabId: string, projectId: string): void {
  emit('jump', tabId, projectId)
  emit('close')
}
</script>

<template>
  <div
    class="so-backdrop"
    @click="emit('close')"
    @contextmenu.prevent="emit('close')"
  >
    <div
      class="so-panel"
      @click.stop
    >
      <div class="so-header">
        <n-icon
          size="13"
          class="so-header-icon"
        >
          <GridOutline />
        </n-icon>
        <span class="so-title">{{ t('terminal.overview.title') }}</span>
        <span class="so-summary">
          <span
            v-if="summary.running"
            class="so-sum-running"
          >{{ t('terminal.overview.runningCount', { count: summary.running }) }}</span>
          <span
            v-if="summary.failed"
            class="so-sum-failed"
          >{{ t('terminal.overview.failedCount', { count: summary.failed }) }}</span>
          <span class="so-sum-total">{{ t('terminal.overview.totalCount', { count: summary.total }) }}</span>
        </span>
      </div>
      <div class="so-body">
        <template v-if="groups.length">
          <div
            v-for="group in groups"
            :key="group.projectId"
            class="so-group"
          >
            <div
              class="so-project"
              :class="{ 'is-current': group.isCurrent }"
            >
              <span class="so-project-name">{{ group.projectName }}</span>
              <span
                v-if="group.isCurrent"
                class="so-project-tag"
              >{{ t('terminal.overview.currentProject') }}</span>
              <span class="so-project-count">{{ group.sessions.length }}</span>
            </div>
            <button
              v-for="session in group.sessions"
              :key="session.tabId"
              class="so-session"
              :class="{ 'is-active': session.active }"
              @click="onJump(session.tabId, group.projectId)"
            >
              <span
                class="so-dot"
                :class="dotClass(session.status)"
              />
              <span
                class="so-session-name"
                :title="session.name"
              >{{ session.name }}</span>
              <span
                v-if="session.panes > 1"
                class="so-session-split"
                :title="t('terminal.overview.splitPanes', { count: session.panes })"
              >{{ t('terminal.overview.splitTag') }}</span>
              <span
                class="so-session-cmd"
                :title="session.lastCmd"
              >{{ session.lastCmd || statusText(session.status, session.exitCode) }}</span>
            </button>
          </div>
        </template>
        <div
          v-else
          class="so-empty"
        >
          {{ t('terminal.overview.noSessions') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.so-backdrop {
  position: absolute;
  inset: 0;
  z-index: 60;
  /* 透明遮罩：仅承接点击关闭，不遮挡视觉 */
  background: transparent;
}
.so-panel {
  position: absolute;
  top: 100%;
  right: 8px;
  margin-top: 4px;
  width: 360px;
  max-width: 90%;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: var(--shadow-pop-lg);
  overflow: hidden;
}
.so-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-subtle, var(--border-default));
  flex-shrink: 0;
}
.so-header-icon { color: var(--brand-accent); flex-shrink: 0; }
.so-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.so-summary {
  margin-left: auto;
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.so-sum-running { color: var(--status-running); }
.so-sum-failed { color: var(--status-failed); }
.so-body {
  overflow-y: auto;
  padding: 4px 0 6px;
}
.so-group + .so-group {
  margin-top: 4px;
}
.so-project {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px 3px;
  font-size: 11px;
  color: var(--text-secondary);
}
.so-project.is-current .so-project-name {
  color: var(--text-primary);
  font-weight: 600;
}
.so-project-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.so-project-tag {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--brand-accent);
  border: 1px solid var(--brand-accent-soft, var(--border-default));
  border-radius: 3px;
  padding: 0 4px;
}
.so-project-count {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--text-dim);
}
.so-session {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 4px 10px 4px 14px;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--text-body);
}
.so-session:hover {
  background: var(--bg-hover);
}
.so-session.is-active {
  background: var(--bg-active, var(--bg-hover));
}
.so-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-dim);
}
.so-dot-running {
  background: var(--status-running);
  animation: so-pulse 1.6s ease-in-out infinite;
}
.so-dot-failed { background: var(--status-failed); }
.so-dot-ok { background: var(--status-success, var(--brand-accent)); }
@keyframes so-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.so-session-name {
  flex-shrink: 0;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.so-session.is-active .so-session-name {
  color: var(--text-primary);
  font-weight: 600;
}
.so-session-split {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-dim);
  border: 1px solid var(--border-default);
  border-radius: 3px;
  padding: 0 3px;
}
.so-session-cmd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
}
.so-session.is-active .so-session-cmd { color: var(--text-body); }
.so-empty {
  padding: 18px 10px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
}
</style>
