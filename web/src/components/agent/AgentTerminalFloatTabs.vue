<script setup lang="ts">
import { NIcon } from 'naive-ui'
import { LocateOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'

/**
 * 智能体终端悬浮窗 tab 条（P-20261001-20 从 AgentTerminalView 拆出的渲染层）：
 * 多会话切换（系统会话 + 被接管的项目会话），单会话时由宿主 v-if 隐藏。
 * 点击/关闭语义（系统会话销毁确认、项目会话归还）由宿主承接。
 * 「在文件树中定位」（P-20261002-125）：dir 在当前项目内的 tab 渲染行内定位
 * 按钮（同 P-32 工具条按钮的图标语义），不可定位 tab 不渲染（窄条不放死钮）；
 * 解析与派发在宿主（复用 useTerminalTreeLocate）。
 */
const props = defineProps<{
  tabs: { id: string; name: string; kind: 'agent' | 'project' }[]
  /** 当前激活 tab 的会话 id（被接管的项目会话优先） */
  activeKey: string
  /** 会话 id → 项目相对 dir（有解析值才渲染定位按钮） */
  locateDirs?: Record<string, string>
  /** 会话未读新输出（P-20261003-310，统一 store 写入）：tab 名字前小圆点 */
  unreadMap?: Record<string, boolean>
}>()

const emit = defineEmits<{
  (e: 'tab-click', tab: { id: string; kind: 'agent' | 'project' }): void
  (e: 'tab-close', tab: { id: string; kind: 'agent' | 'project' }): void
  (e: 'tab-locate', tab: { id: string; kind: 'agent' | 'project' }): void
}>()

const { t } = useI18n()

/** 定位按钮 tooltip：带 dir 与 P-32 工具条按钮同文案（根 dir 显示动作名本身） */
function locateTitle(id: string): string {
  const dir = props.locateDirs?.[id]
  if (dir === undefined) return t('terminal.locate.inTree')
  return dir === '' ? t('terminal.locate.inTree') : t('terminal.locate.inTreeDir', { dir })
}
</script>

<template>
  <div class="atv-tabs">
    <div
      v-for="s in tabs"
      :key="s.id"
      class="agt-tab"
      :class="{ active: s.id === activeKey }"
      :title="s.kind === 'project' ? t('agentTerminal.attachedTip') : s.name"
      @click="emit('tab-click', s)"
    >
      <!-- 未读活动点（P-20261003-310）：后台会话有新输出/终态，名字前小圆点，
           点击切换即清（清账在宿主可见登记收口） -->
      <span
        v-if="props.unreadMap?.[s.id]"
        class="agt-tab-unread"
        :title="t('terminal.tabUnread')"
      />
      <span class="agt-tab-name">{{ s.name }}</span>
      <button
        v-if="locateDirs?.[s.id] !== undefined"
        class="agt-tab-locate"
        :data-testid="`float-tab-locate-${s.id}`"
        :title="locateTitle(s.id)"
        :aria-label="locateTitle(s.id)"
        @click.stop="emit('tab-locate', s)"
      >
        <n-icon size="11">
          <LocateOutline />
        </n-icon>
      </button>
      <button
        class="agt-tab-close"
        :title="s.kind === 'project' ? t('agentTerminal.resumeToPanel') : t('agentTerminal.destroy')"
        @click.stop="emit('tab-close', s)"
      >
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 悬浮窗 tab 条（多会话切换） */
.atv-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-default);
  overflow-x: auto;
  flex-shrink: 0;
  scrollbar-width: thin;
}
.atv-tabs .agt-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 140px;
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}
.atv-tabs .agt-tab:hover { background: var(--bg-hover); }
.atv-tabs .agt-tab.active { background: var(--bg-active); color: var(--text-primary); font-weight: 500; }
.atv-tabs .agt-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 未读活动点（P-20261003-310）：进行中蓝档语义色，一次性布尔无频闪 */
.atv-tabs .agt-tab-unread {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  background: var(--accent-blue);
}
.atv-tabs .agt-tab-locate {
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: var(--text-dim);
  cursor: pointer; padding: 0 1px; flex-shrink: 0;
}
.atv-tabs .agt-tab-locate:hover { color: var(--accent-blue); }
.atv-tabs .agt-tab-close {
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: var(--text-dim);
  cursor: pointer; padding: 0 2px; flex-shrink: 0;
}
.atv-tabs .agt-tab-close:hover { color: var(--accent-red); }
</style>
