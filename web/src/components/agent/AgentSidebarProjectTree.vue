<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { NDropdown, NIcon, NInput } from 'naive-ui'
import { ArrowRedoOutline, ChatboxEllipsesOutline, ChevronDownOutline, ChevronForwardOutline, FolderOpenOutline, LockClosedOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import type { ProjectGroupItem } from '../../composables/useAgentSidebarDnd'
import { useProjectStore } from '../../stores/project'
import { useAgentQueueStore } from '../../stores/agentQueue'
import AgentSessionQueuePanel from './AgentSessionQueuePanel.vue'
import { sidebarTreeSharedKey } from './agentSidebarTreeShared'

/**
 * 智能体侧栏项目分组树（P-20261001-20 从 AgentSidebarSessionTree 拆出）：
 * 底部终端的项目会话自动按项目归组（可折叠；组头右键/拖拽排序；
 * 组头「打开项目」跳转）。拖拽/内联重命名状态经 provide/inject 与宿主共享
 * （同一次拖拽会话跨列表区全局唯一），列表数据与折叠集合由宿主传入。
 * 组头锁徽标（P-20261004-143）：项目落锁时组头小锁提示——组内项目会话是
 * 锁前开出的存量终端，API 写族已 403 但 shell 命令不受锁约束（诚实边界）。
 * 会话行排队指令入口（P-20261007-12 补 P-20261003-248 自认缝）：与会话树
 * 会话行同款入口+内联面板（面板组件自包含 sessionId 直复用），计数经
 * agentQueue store 全局单例与另一树自然同步。
 */
const props = defineProps<{
  /** 项目分组树（宿主筛选后的展示序） */
  projectGroups: ProjectGroupItem[]
  /** 当前右侧渲染中的会话 id（agent 或被接管的项目会话） */
  selectedId?: string
  /** 项目分组折叠集合（宿主持有并持久化） */
  collapsedProjects?: Set<string>
  /** 会话 id → 项目相对 dir（「在文件树中定位」可用性；无条目 = 不可定位置灰） */
  locateDirs?: Record<string, string>
  /** 直播中会话 id → 徽标 title（P-20261106-7，会话树透传）：行红点徽标 +
   *  右键「直播分享/结束直播」文案翻转；缺条目 = 未直播 */
  liveTitles?: Record<string, string>
}>()

const emit = defineEmits<{
  /** 接管项目会话到管理页 */
  (e: 'attach-project', id: string): void
  /** 项目分组折叠切换 */
  (e: 'toggle-project', projectId: string): void
  /** 项目分组右键菜单：新建项目会话 / 打开项目 */
  (e: 'project-action', payload: { projectId: string; key: 'create-session' | 'open' }): void
  /** 项目会话右键菜单：在文件树中定位 / 结束会话（确认由宿主承担） */
  (e: 'project-session-action', payload: { sessionId: string; key: 'destroy' | 'locate-tree' }): void
  /** 项目会话行能力四件（P-20261106-7 双入口纪律）：与会话树行同事件合流上抛，
   *  宿主接线 useTerminalShareActions（底部终端 tab 右键同一实现） */
  (e: 'capability-action', payload: { sessionId: string; key: 'liveShare' | 'frozenShare' | 'replayShare' | 'exportOutput' }): void
}>()

const { t } = useI18n()

// 拖拽与内联重命名状态与宿主共享（provide/inject；见 agentSidebarTreeShared.ts）
const {
  dragOverKey,
  startDrag,
  onDragOverProjectGroupHead, onDragOverProjectGroupSection, onDragOverProjectSessionItem,
  onDropProjectGroupHead, onDropProjectSessionItem,
  onDragEnd,
  renamingSessionId, renamingSessionName,
  startRenameSession, confirmRenameSession,
  itemTitle, idleBadge, idleTip, isStallBadge, onIdleBadgeClick,
} = inject(sidebarTreeSharedKey)!

/** 项目分组是否折叠（宿主持有集合，读写上抛） */
function isProjectCollapsed(projectId: string): boolean {
  return props.collapsedProjects?.has(projectId) ?? false
}

// 组头锁徽标（P-20261004-143）：锁态由 project store 的 projects.changed 订阅
// 保鲜（锁定即现、解锁即摘）；组头常显（不随 hover），组内会话全部受益于提示
const projectStore = useProjectStore()
function isProjectLocked(projectId: string): boolean {
  return projectStore.projects.find(p => p.id === projectId)?.locked === true
}

// ============== 排队指令（P-20261003-248 / P-20261007-12）：会话行入口 + 内联面板 ==============
// 数据面在 agentQueue store（全局单例，服务端为事实源）——与会话树同源直用
// store（不经 props/inject 逐层下发，approvals/task 同款口径），一处入队两树
// 计数自然同步；这里只管行内入口的展开/收起。手风琴为本树局部 state：两树
// 各自至多展开一个——两树会话集不相交（项目会话只在本树、agent 会话只在
// 会话树），同一会话不存在两树同开的可能，跨树共享展开 id 只添耦合无收益
const queueStore = useAgentQueueStore()
const queueOpenId = ref('')
function toggleQueue(id: string): void {
  queueOpenId.value = queueOpenId.value === id ? '' : id
}
function queueCount(id: string): number {
  return queueStore.countFor(id)
}
// 首拉兜底：宿主（会话树）挂载已拉过，此处 loaded 判空为独立挂载形态自洽
// （refreshAll 有 loading 互斥，双挂载不产生重复请求）
onMounted(() => {
  if (!queueStore.loaded) void queueStore.refreshAll()
})

// ============== 项目分组 / 项目会话右键菜单 ==============
const menuProjectId = ref('')
const menuProjectSessionId = ref('')
const menuX = ref(0)
const menuY = ref(0)
function openProjectMenu(projectId: string, e: MouseEvent) {
  menuProjectId.value = projectId
  menuX.value = e.clientX
  menuY.value = e.clientY
}
function openProjectSessionMenu(sessionId: string, e: MouseEvent) {
  menuProjectSessionId.value = sessionId
  menuX.value = e.clientX
  menuY.value = e.clientY
}
const projectMenuOptions = computed(() => [
  { label: t('agentTerminal.newProjectSession'), key: 'create-session' },
  { label: t('agentTerminal.openProject'), key: 'open' },
])
// 在文件树中定位（P-20261002-125）：会话 dir 不在当前项目内（含项目会话归属
// 他项目）时无解析值 → 置灰；菜单随 menuProjectSessionId 逐行求可用性。
// 能力四件（P-20261106-7 双入口纪律）：项目会话同时是底部终端 tab，本树行
// 右键与 tab 右键同款同序（直播按锚点态翻转「结束直播」/ 快照 / 回放 / 导出），
// 列表只收存活会话故不设禁用态；动作实现在宿主 useTerminalShareActions
const projectSessionMenuOptions = computed(() => [
  { label: t('agentTerminal.rename'), key: 'rename' },
  { label: t('terminal.locate.inTree'), key: 'locate-tree', disabled: props.locateDirs?.[menuProjectSessionId.value] === undefined },
  { label: t(props.liveTitles?.[menuProjectSessionId.value] ? 'terminal.endLiveShare' : 'terminal.liveShare'), key: 'liveShare' },
  { label: t('terminal.frozenShare'), key: 'frozenShare' },
  { label: t('terminal.shareReplay'), key: 'replayShare' },
  { label: t('terminal.exportOutput'), key: 'exportOutput' },
  { label: t('agentTerminal.destroy'), key: 'destroy' },
])
function onProjectMenu(key: string) {
  if (menuProjectId.value) emit('project-action', { projectId: menuProjectId.value, key: key as 'create-session' | 'open' })
  menuProjectId.value = ''
}
function onProjectSessionMenu(key: string) {
  const id = menuProjectSessionId.value
  menuProjectSessionId.value = ''
  if (!id) return
  if (key === 'locate-tree') {
    emit('project-session-action', { sessionId: id, key: 'locate-tree' })
    return
  }
  if (key === 'liveShare' || key === 'frozenShare' || key === 'replayShare' || key === 'exportOutput') {
    emit('capability-action', { sessionId: id, key })
    return
  }
  if (key === 'rename') {
    // 重命名走双击同款内联输入（confirmRenameSession 按会话归属自动路由到
    // rename-project），当前名从项目分组里找
    for (const pg of props.projectGroups) {
      const s = pg.sessions.find(ss => ss.id === id)
      if (s) {
        startRenameSession(id, s.name)
        return
      }
    }
    return
  }
  emit('project-session-action', { sessionId: id, key: 'destroy' })
}
</script>

<template>
  <!-- 组段整区落点（P-20261111-1-S2）：与自定义分组同款——dragover/drop 上提
       到组段容器，组头窄行死区消灭（内层行 dragover 认领时让位，组源掠过
       项目会话行由组段兜底承接组序）；高亮同键挂组段，与自定义分组视觉一致 -->
  <div
    v-for="pg in projectGroups"
    :key="pg.projectId"
    class="ats-section"
    :class="{ 'ats-drag-over': dragOverKey === `pgroup:${pg.projectId}` }"
    @dragover="onDragOverProjectGroupSection(pg.projectId, $event)"
    @drop.prevent="onDropProjectGroupHead(pg.projectId)"
  >
    <div
      class="ats-group-head is-group"
      draggable="true"
      :title="t('agentTerminal.projectGroupDragTip')"
      @dragstart="startDrag({ kind: 'project-group', projectId: pg.projectId }, $event)"
      @dragover="onDragOverProjectGroupHead(pg.projectId, $event)"
      @drop.prevent="onDropProjectGroupHead(pg.projectId)"
      @dragend="onDragEnd"
      @click="emit('toggle-project', pg.projectId)"
      @contextmenu.prevent="openProjectMenu(pg.projectId, $event)"
    >
      <n-icon
        size="11"
        class="ats-fold"
      >
        <component :is="isProjectCollapsed(pg.projectId) ? ChevronForwardOutline : ChevronDownOutline" />
      </n-icon>
      <n-icon size="12">
        <FolderOpenOutline />
      </n-icon>
      <span
        class="ats-group-name"
        :title="pg.name"
      >{{ pg.name }}</span>
      <!-- 项目硬锁徽标（P-20261004-143）：组内项目会话=锁前开出的存量终端 -->
      <n-icon
        v-if="isProjectLocked(pg.projectId)"
        class="ats-group-locked"
        size="11"
        :title="t('project.locked.terminalBadgeTitle')"
        data-test="project-group-locked-badge"
      >
        <LockClosedOutline />
      </n-icon>
      <span class="ats-group-count">{{ pg.sessions.length }}</span>
      <button
        class="ats-open-project"
        :title="t('agentTerminal.openProject')"
        @click.stop="emit('project-action', { projectId: pg.projectId, key: 'open' })"
      >
        <n-icon size="11">
          <ArrowRedoOutline />
        </n-icon>
      </button>
    </div>
    <template v-if="!isProjectCollapsed(pg.projectId)">
      <!-- template v-for：行 + 排队面板同循环作用域（会话树区同款——面板是行的
           展开附件，需要在 `s` 可见的兄弟位渲染） -->
      <template
        v-for="s in pg.sessions"
        :key="s.id"
      >
        <div
          class="ats-item"
          :class="{ active: s.id === selectedId, attached: s.attached, 'ats-drag-over': dragOverKey === `psession:${s.id}` }"
          :title="itemTitle(s.id, s.attached ? t('agentTerminal.attachedTip') : t('agentTerminal.attachTip'))"
          draggable="true"
          @dragstart="startDrag({ kind: 'project-session', sessionId: s.id, projectId: pg.projectId }, $event)"
          @dragover="onDragOverProjectSessionItem(s, pg.projectId, $event)"
          @drop.prevent="onDropProjectSessionItem(s, pg.projectId)"
          @dragend="onDragEnd"
          @click="emit('attach-project', s.id)"
          @dblclick.stop="startRenameSession(s.id, s.name)"
          @contextmenu.prevent="openProjectSessionMenu(s.id, $event)"
        >
          <n-input
            v-if="renamingSessionId === s.id"
            v-model:value="renamingSessionName"
            size="tiny"
            autofocus
            @keyup.enter="confirmRenameSession"
            @blur="confirmRenameSession"
            @click.stop
          />
          <template v-else>
            <!-- 直播中徽标（P-20261106-7 双入口）：项目会话在底部终端 tab 与本树
                 两处可见，红点同数据源（useTerminalShareActions.liveTitles）同视觉语 -->
            <span
              v-if="props.liveTitles?.[s.id]"
              class="ats-item-live"
              :title="props.liveTitles[s.id]"
              data-test="session-live-badge"
            />
            <span
              class="ats-item-title"
              :title="s.name"
            >{{ s.name }}</span>
          </template>
          <span
            v-if="idleBadge(s.id)"
            class="ats-item-idle"
            :class="{ 'is-stall': isStallBadge(s.id) }"
            :title="idleTip(s.id)"
            @click="onIdleBadgeClick(s.id, $event)"
          >{{ idleBadge(s.id) }}</span>
          <!-- 排队指令入口（P-20261007-12）：有排队常显计数，无排队 hover 显图标
               （会话树行同形态同位——idle 徽标与 running 点之间） -->
          <button
            class="ats-item-queue"
            :class="{ 'has-items': queueCount(s.id) > 0 }"
            :title="t('agentTerminal.queue.toggle')"
            data-testid="session-queue-toggle"
            @click.stop="toggleQueue(s.id)"
          >
            <n-icon size="11">
              <ChatboxEllipsesOutline />
            </n-icon>
            <span
              v-if="queueCount(s.id) > 0"
              class="ats-item-queue-count"
            >{{ queueCount(s.id) }}</span>
          </button>
          <span
            v-if="s.running"
            class="ats-item-dot running"
          />
          <span
            v-if="s.attached"
            class="ats-item-badge"
          >{{ t('agentTerminal.attachedBadge') }}</span>
        </div>
        <!-- 排队指令面板（本树手风琴，同时至多展开一个）；会话归属项目随组
        传入——面板 @ 文件补全（P-20261005-196）按所属项目取文件清单 -->
        <AgentSessionQueuePanel
          v-if="queueOpenId === s.id"
          :session-id="s.id"
          :project-id="pg.projectId"
        />
      </template>
    </template>
  </div>

  <!-- 项目分组右键菜单：新建项目会话 / 打开项目 -->
  <n-dropdown
    trigger="manual"
    :show="!!menuProjectId"
    :options="projectMenuOptions"
    placement="bottom-start"
    :x="menuX"
    :y="menuY"
    @select="onProjectMenu"
    @clickoutside="menuProjectId = ''"
  />
  <!-- 项目会话右键菜单：重命名（内联）/ 结束会话 -->
  <n-dropdown
    trigger="manual"
    :show="!!menuProjectSessionId"
    :options="projectSessionMenuOptions"
    placement="bottom-start"
    :x="menuX"
    :y="menuY"
    @select="onProjectSessionMenu"
    @clickoutside="menuProjectSessionId = ''"
  />
</template>

<style scoped>
.ats-section { display: flex; flex-direction: column; gap: 2px; }
.ats-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 4px 6px;
  border-radius: 4px;
  user-select: none;
}
.ats-group-head.is-group { cursor: pointer; }
.ats-group-head.is-group:hover { background: var(--bg-hover); color: var(--text-secondary); }
.ats-group-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 项目分组折叠箭头（旋转指示可折叠语义） */
.ats-fold { flex-shrink: 0; color: var(--text-dim); }
/* 组头项目硬锁徽标（P-20261004-143）：accent-orange 中性呈现（锁是状态不是
 * 错误，首页 .project-locked-badge 同款语义色），常显不随 hover */
.ats-group-locked { flex-shrink: 0; color: var(--accent-orange); }
.ats-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-body);
  font-size: 12px;
  transition: background var(--motion-base);
}
.ats-item:hover { background: var(--bg-hover); }
.ats-item.active { background: var(--bg-active); color: var(--text-primary); font-weight: 500; }
.ats-item-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ats-item-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--status-running);
}
.ats-item-dot.running { animation: ats-pulse 1.6s ease-in-out infinite; }
@keyframes ats-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-running) 45%, transparent); }
  50% { box-shadow: 0 0 0 4px transparent; }
}
/* 直播中徽标（P-20261106-7）：与会话树行 / 底部终端 tab 同视觉语（红点缩放呼吸，
   语义红档 --status-failed）；scoped 样式不跨组件，此处同款复刻 */
.ats-item-live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--status-failed);
  animation: ats-live-pulse 1.6s ease-in-out infinite;
}
@keyframes ats-live-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}
/* 会话静默弱标（P-20261003-53）：灰调小徽标，弱样式不弹窗不打断（与宿主同款） */
.ats-item-idle {
  flex-shrink: 0; font-size: 0.72em; padding: 0 4px; border-radius: 2px;
  background: color-mix(in srgb, var(--text-dim) 12%, transparent); color: var(--text-dim);
  white-space: nowrap;
}
/* 排队指令入口（P-20261007-12）：与宿主会话树行同款同位（AgentSidebarSessionTree
   的 scoped 样式不出组件，本树行需自带一份——两处形态刻意一致，改一处须同步另一处）。
   行尾小图标钮，有排队常显计数（蓝档语义色），无排队 hover 显形——可发现但不占
   静息密度；flex-shrink: 0 + 标题 ellipsis 兜住窄侧栏并排宽度（不折行，挤标题） */
.ats-item-queue {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  border: none;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0 3px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.ats-item:hover .ats-item-queue,
.ats-item-queue.has-items { opacity: 1; }
.ats-item-queue:hover { color: var(--text-primary); background: var(--bg-hover); }
.ats-item-queue.has-items { color: var(--accent-blue); }
.ats-item-queue-count { font-size: 0.72em; font-weight: 600; }

/* 拖拽落点指示（项目组段整区 / 项目会话条目行级插入态；S2 起组区高亮挂
   .ats-section 整段——与自定义分组同款同键，两树视觉一致） */
.ats-drag-over {
  outline: 1px dashed var(--accent-blue);
  outline-offset: -1px;
  border-radius: 4px;
}
/* 项目组头：会话数 + 「打开项目」跳转按钮 */
.ats-group-count {
  font-size: 10px;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  border-radius: 8px;
  padding: 0 6px;
  line-height: 15px;
}
.ats-open-project {
  display: flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; border: none; border-radius: 4px;
  background: transparent; color: var(--text-tertiary); cursor: pointer;
  padding: 0; opacity: 0; transition: opacity var(--motion-base);
}
.ats-group-head:hover .ats-open-project { opacity: 1; }
.ats-open-project:hover { background: var(--bg-hover); color: var(--accent-blue); }
/* 被接管的项目会话条目 */
.ats-item.attached .ats-item-title { color: var(--brand-accent); }
.ats-item-badge {
  font-size: 9px;
  color: var(--brand-accent);
  border: 1px solid var(--brand-accent);
  border-radius: 3px;
  padding: 0 3px;
  line-height: 12px;
  flex-shrink: 0;
  opacity: 0.85;
}
</style>
