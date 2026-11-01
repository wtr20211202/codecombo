<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NDropdown, NIcon, NTag } from 'naive-ui'
import {
  ChevronBackOutline, ChevronForwardOutline, CloseOutline,
  GitCommitOutline, OpenOutline, ChevronUpOutline, AddOutline, TerminalOutline, FolderOpenOutline,
  GitCompareOutline,
  ChatbubblesOutline,
  BookOutline,
  GitNetworkOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useAssistantTaskStore } from '../../stores/assistantTask'
import { isDepositStatus } from '../../utils/notesDeposit'
import { useNotesDeposit } from '../../composables/useNotesDeposit'

/**
 * 智能体终端头部 chrome（P-20261001-20 从 AgentTerminalView 拆出的渲染层）：
 * 标题/会话数/运行状态点 + 新建会话/项目会话下拉/形态切换/折叠/产出面板/关闭。
 * 轻量头在悬浮窗形态下即拖拽手柄：pointer 事件原样上抛（header-pointerdown），
 * 由宿主的悬浮窗几何 composable 消费；头部按钮的事件正常冒泡触发，
 * 位移阈值内不影响点击。
 */
const props = defineProps<{
  /** 会话总数 = 系统会话 + 全部项目会话 */
  sessionCount: number
  /** 全局任务运行中（状态点高亮） */
  running: boolean
  isFloat: boolean
  /** 独立模式（首页全屏 overlay）：头部显示关闭按钮 */
  standalone?: boolean
  sidebarCollapsed: boolean
  showActivity: boolean
  /** 新建项目会话下拉项（宿主组装，首项为禁用的说明头） */
  projectCreateOptions: { label: string; key: string; disabled?: boolean }[]
}>()

const emit = defineEmits<{
  (e: 'compare'): void
  (e: 'chains'): void
  (e: 'new'): void
  (e: 'create-project', key: string): void
  (e: 'dock'): void
  (e: 'toggle-sidebar'): void
  (e: 'float'): void
  (e: 'collapse'): void
  (e: 'toggle-activity'): void
  (e: 'close'): void
  (e: 'header-pointerdown', ev: PointerEvent): void
}>()

const { t } = useI18n()
const taskStore = useAssistantTaskStore()
const { depositCurrentTask } = useNotesDeposit()

// 可能失联（P-20261003-303）：全局 running 且超时无上报——状态点转警示黄停
// 呼吸（呼吸=「活着」信号），tooltip 说明；不清数据，真终态到达仍可覆盖
const taskStale = computed(() => props.running && taskStore.isStale)

// 沉淀到笔记入口（P-20261003-292）：任务终态（done/failed）后可见——agent 忘了
// ops 手册「结论沉淀约定」时，人一键把预填模板写进项目笔记（写回后自动打开
// 笔记面板编辑补充）。终态保持到下一次任务上报前，与状态点同一数据源
const taskTerminal = computed(() => isDepositStatus(taskStore.status))

// 状态点提示：全局任务运行中显示当前任务/步骤
const statusTitle = computed(() => {
  const parts = [taskStore.task, taskStore.step].filter(Boolean)
  const base = parts.join(' · ') || t('agentTerminal.idle')
  if (taskStale.value) return `${base}\n${t('agentTerminal.staleTip')}`
  return base
})
</script>

<template>
  <div
    class="atv-header"
    :class="{ 'is-draggable': isFloat }"
    @pointerdown="emit('header-pointerdown', $event)"
  >
    <div class="atv-header-left">
      <n-icon
        size="16"
        class="atv-title-icon"
      >
        <TerminalOutline />
      </n-icon>
      <span class="atv-title">{{ t('agentTerminal.title') }}</span>
      <n-tag
        v-if="sessionCount"
        size="tiny"
        :bordered="false"
        class="atv-count"
      >
        {{ t('agentTerminal.sessionCount', { n: sessionCount }) }}
      </n-tag>
      <span
        class="atv-dot"
        :class="{ running: running, stale: taskStale }"
        :title="statusTitle"
      />
    </div>
    <div class="atv-header-actions">
      <!-- 沉淀到笔记（P-20261003-292）：任务终态次级入口（docked 管理页与悬浮窗共用本头部） -->
      <n-button
        v-if="taskTerminal"
        size="small"
        quaternary
        :title="t('notes.deposit.action')"
        data-testid="agent-notes-deposit"
        @click="depositCurrentTask"
      >
        <template #icon>
          <n-icon><BookOutline /></n-icon>
        </template>
      </n-button>
      <!-- 新建会话：对话框为主入口（运行时/名称/工作目录/启动命令可选）；
           亦是编辑器选区拖拽的「新建区」落点（P-20261003-162，与侧栏新建钮同键） -->
      <n-button
        size="small"
        type="primary"
        data-sc-selection-drop="new-session"
        @click="emit('new')"
      >
        <template #icon>
          <n-icon><AddOutline /></n-icon>
        </template>
        {{ t('agentTerminal.newSession') }}
      </n-button>
      <!-- 对比实验（P-20261003-46）：双 agent 同题竞写入口（命令面板同源） -->
      <n-button
        size="small"
        quaternary
        :title="t('experiment.title')"
        data-testid="agent-compare-entry"
        @click="emit('compare')"
      >
        <template #icon>
          <n-icon><GitCompareOutline /></n-icon>
        </template>
      </n-button>
      <!-- 接续链（P-20261004-38）：会话串行接力链列表管理入口 -->
      <n-button
        size="small"
        quaternary
        :title="t('agentchain.panelTitle')"
        data-testid="agent-chain-entry"
        @click="emit('chains')"
      >
        <template #icon>
          <n-icon><GitNetworkOutline /></n-icon>
        </template>
      </n-button>
      <!-- 新建项目会话：项目选择器，新建即接管到本页 -->
      <n-dropdown
        trigger="click"
        placement="bottom-end"
        :options="projectCreateOptions"
        @select="(key: string) => emit('create-project', key)"
      >
        <n-button
          size="small"
          quaternary
          :title="t('agentTerminal.newProjectSession')"
        >
          <template #icon>
            <n-icon><FolderOpenOutline /></n-icon>
          </template>
        </n-button>
      </n-dropdown>
      <n-button
        v-if="isFloat"
        size="small"
        quaternary
        :title="t('agentTerminal.dock')"
        @pointerdown.stop
        @click="emit('dock')"
      >
        <template #icon>
          <n-icon><ChatbubblesOutline /></n-icon>
        </template>
      </n-button>
      <n-button
        v-if="!isFloat"
        size="small"
        quaternary
        :title="sidebarCollapsed ? t('agentTerminal.expandSidebar') : t('agentTerminal.collapseSidebar')"
        @click="emit('toggle-sidebar')"
      >
        <template #icon>
          <n-icon>
            <ChevronBackOutline v-if="!sidebarCollapsed" />
            <ChevronForwardOutline v-else />
          </n-icon>
        </template>
      </n-button>
      <n-button
        size="small"
        quaternary
        :title="t('agentTerminal.openFloat')"
        @click="emit('float')"
      >
        <template #icon>
          <n-icon><OpenOutline /></n-icon>
        </template>
      </n-button>
      <n-button
        size="small"
        quaternary
        :title="t('agentTerminal.collapse')"
        @click="emit('collapse')"
      >
        <template #icon>
          <n-icon><ChevronUpOutline /></n-icon>
        </template>
      </n-button>
      <n-button
        v-if="!isFloat"
        size="small"
        quaternary
        :class="{ 'atv-btn-active': showActivity }"
        :title="t('agentTerminal.activityTitle')"
        @click="emit('toggle-activity')"
      >
        <template #icon>
          <n-icon><GitCommitOutline /></n-icon>
        </template>
      </n-button>
      <n-button
        v-if="props.standalone"
        size="small"
        quaternary
        :title="t('common.close')"
        @click="emit('close')"
      >
        <template #icon>
          <n-icon><CloseOutline /></n-icon>
        </template>
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.atv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-panel);
  flex-shrink: 0;
}
.atv-header.is-draggable { cursor: grab; user-select: none; touch-action: none; }
.atv-header.is-draggable:active { cursor: grabbing; }
.atv-header.is-draggable .n-button,
.atv-header.is-draggable button { touch-action: auto; }
.atv-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.atv-title-icon { color: var(--text-secondary); flex-shrink: 0; }
.atv-title { font-size: 15px; font-weight: 600; color: var(--text-primary); white-space: nowrap; }
.atv-count { font-size: 10px; }
.atv-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--text-tertiary); flex-shrink: 0;
}
.atv-dot.running { background: var(--status-running); animation: atv-pulse 1.6s ease-in-out infinite; }
/* 失联弱预警（P-20261003-303）：running 超时无上报——警示黄停呼吸，弱样式不弹窗 */
.atv-dot.stale { background: var(--status-waiting); animation: none; opacity: 0.75; }
@keyframes atv-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-running) 45%, transparent); }
  50% { box-shadow: 0 0 0 5px transparent; }
}
.atv-header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
</style>
