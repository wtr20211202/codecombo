<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { NButton, NDropdown, NIcon, NInput, NSpin } from 'naive-ui'
import { AddOutline, FlashOutline, FolderOutline, GridOutline, SearchOutline, SwapVerticalOutline, TerminalOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { agentLabelOf } from '../../composables/useApprovalActions'
import { useProjectStore } from '../../stores/project'
import BrandIcon from '../common/BrandIcon.vue'
import ClaudeSessionPicker from '../claude/ClaudeSessionPicker.vue'
import AgentSidebarSessionTree from './AgentSidebarSessionTree.vue'
import type { AgentTermSession } from '../../composables/useAgentTerminal'
import type { ProjectGroupItem } from '../../composables/useAgentSidebarDnd'
import {
  groupSessionsByRuntime,
  runtimeFilterOptions,
  sessionMatchesRuntimeFilter,
  RUNTIME_FALLBACK_KEY,
} from '../../utils/sessionRuntimeGroups'
import type { SessionGroupMode } from '../../stores/terminal-sessions'

/** 会话排序方式（与 terminal-sessions store 的同名导出语义一致） */
type SessionSortMode = 'default' | 'name' | 'activity'

/**
 * 智能体会话侧栏：新建会话 / 会话列表（可分组）/ 分组管理。
 * 分组仅是展示层组织（分组数据持久化在 uiState）；会话本体在服务端终端管理器。
 * 右键菜单：重命名 / 移动分组 / 结束会话（结束的确认弹窗由宿主承担）。
 * 项目分组：可折叠收起（宿主持有持久化）、右键新建项目会话/打开项目、
 * 组头拖动排序、组内会话拖动排序（顺序同样由宿主落 uiState）。
 *
 * 区块拆分（P-20261001-20）：三个列表区（项目分组树/未分组/自定义分组）+
 * 右键菜单 + 内联重命名 + 多选批操作在 AgentSidebarSessionTree 子组件，
 * 拖拽排序机制在 useAgentSidebarDnd 组合式；本文件持有页签/排序/即时筛选。
 * 按 runtime 分组视图（P-20261003-238）：页签行 toggle（store 持久化），
 * 归组投影在 utils/sessionRuntimeGroups 纯函数，组段渲染仍在树子组件。
 */
const props = defineProps<{
  sessions: AgentTermSession[]
  groups: { id: string; name: string; sessionIds: string[] }[]
  activeId: string
  booting: boolean
  /** 项目分组树（自动归组，项目名由调用方映射） */
  projectGroups?: ProjectGroupItem[]
  /** 当前右侧渲染中的会话 id（agent 或被接管的项目会话） */
  selectedId?: string
  /** 会话粒度运行态（OSC 133，统一 store 写入） */
  runningMap?: Record<string, boolean>
  /** 会话未读新输出（P-20261003-310，统一 store 写入；会话行小圆点渲染） */
  unreadMap?: Record<string, boolean>
  /** 侧栏列表页签：终端会话（项目树+系统会话）/ Claude 会话 */
  listTab?: 'terminals' | 'claude'
  /** 会话排序方式（宿主绑定 store 持久化 action） */
  sortMode?: 'default' | 'name' | 'activity'
  /** 分组视图（P-20261003-238，宿主绑定 store 持久化 action）：flat=既有
   *  呈现 / runtime=按运行时分组（组头标签+计数；纯展示层投影） */
  groupMode?: SessionGroupMode
  /** runtime 筛选选中集（P-20261004-84，宿主绑定 store 持久化 action）：
   *  多选 OR 语义（命中任一），空集 = 不过滤 */
  runtimeFilter?: Set<string>
  /** 会话最近活动时间戳（OSC 133，tooltip 展示用） */
  activityMap?: Record<string, number>
  /** 会话 id → 创建时间 ISO（时间 chips 兜底基点：activityMap 是会话期内存态，
   *  刷新后为空，纯活动判定会把全部会话清出时间窗口——见 hitTime 注记） */
  createdMap?: Record<string, string>
  /** 项目分组折叠集合（宿主持有并持久化） */
  collapsedProjects?: Set<string>
  /** 自定义分组折叠集合（P-20261111-1-S1，宿主持有并持久化） */
  collapsedGroups?: Set<string>
  /** 会话 id → 项目相对 dir（「在文件树中定位」可用性；无条目 = 不可定位） */
  locateDirs?: Record<string, string>
  /** 直通输入持权投影（P-20261024-1，透传 AgentSidebarSessionTree）：会话行
   *  橙点徽标与右键「收回访客输入」项的数据面 */
  directHolds?: Record<string, { nick?: string; visitorTail?: string }>
  /** 直播中会话 id → 徽标 title（P-20261106-7，透传 AgentSidebarSessionTree）：
   *  会话行红点徽标与右键「直播分享/结束直播」翻转的数据面 */
  liveTitles?: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'update:listTab', v: 'terminals' | 'claude'): void
  (e: 'update:sortMode', v: SessionSortMode): void
  (e: 'update:groupMode', v: SessionGroupMode): void
  /** runtime 筛选芯片点选（宿主调 store action 落持久化，P-20261004-84） */
  (e: 'toggle-runtime-filter', key: string): void
  /** runtime 筛选「全部」恢复档（清空选中集） */
  (e: 'clear-runtime-filter'): void
  (e: 'select', id: string): void
  (e: 'create'): void
  /** 接管项目会话到管理页 */
  (e: 'attach-project', id: string): void
  /** 跳转项目视图（不指定会话） */
  (e: 'open-project', projectId: string): void
  /** 跳转项目视图并激活指定会话 */
  (e: 'open-project-session', payload: { projectId: string; sessionId: string }): void
  /** 项目分组折叠切换 */
  (e: 'toggle-project', projectId: string): void
  /** 自定义分组折叠切换（P-20261111-1-S1，透传会话树） */
  (e: 'toggle-group', groupId: string): void
  /** 项目分组右键菜单：新建项目会话 / 打开项目 */
  (e: 'project-action', payload: { projectId: string; key: 'create-session' | 'open' }): void
  /** 项目会话右键菜单：在文件树中定位 / 结束会话（确认由宿主承担） */
  (e: 'project-session-action', payload: { sessionId: string; key: 'destroy' | 'locate-tree' }): void
  /** 会话行「在文件树中定位」（宿主持有解析层，逐行派发 OPS_LOCATE_IN_TREE） */
  (e: 'locate-tree', sessionId: string): void
  /** 会话行「交叉审查」（宿主选定源会话并开弹层，P-20261003-6） */
  (e: 'cross-review', sessionId: string): void
  /** 会话行「完成后接续…」（宿主选定源会话并开弹层，P-20261004-38） */
  (e: 'chain-continue', sessionId: string): void
  /** 会话行「标记审阅基线」（宿主调 API 并反馈，P-20261003-217） */
  (e: 'review-mark', sessionId: string): void
  /** 会话行「标记/取消敏感」（宿主调 API 并反馈，P-20261003-155） */
  (e: 'toggle-sensitive', sessionId: string): void
  /** 会话行「收回访客输入」（P-20261024-1，透传宿主处理） */
  (e: 'direct-revoke', sessionId: string): void
  /** 会话行能力四件（P-20261106-7，透传宿主接线 useTerminalShareActions）：
   *  直播分享/冻结分享/分享回放/导出输出——与底部终端 tab 右键同一实现 */
  (e: 'capability-action', payload: { sessionId: string; key: 'liveShare' | 'frozenShare' | 'replayShare' | 'exportOutput' }): void
  /** 会话行「重新发起」（宿主解析源会话并预填新建对话框，P-20261003-146） */
  (e: 'relaunch', sessionId: string): void
  /** 会话行「复盘报告」（宿主写 postmortem store 打开 App 层弹层，P-20261004-60） */
  (e: 'postmortem', sessionId: string): void
  /** name 直传 = 双击内联重命名；缺省 = 宿主走输入对话框 */
  (e: 'session-action', payload: { sessionId: string; key: 'rename' | 'destroy' | 'kill' | `move:${string}` | 'move:__root__'; name?: string }): void
  /** 项目会话重命名（双击内联；项目会话不经 session-action 的分组语义） */
  (e: 'rename-project', payload: { sessionId: string; name: string }): void
  (e: 'group-action', payload: { key: 'create' | `rename:${string}` | `delete:${string}`; name?: string }): void
  /** 拖拽语义（顺序由宿主写入 uiState 持久化） */
  (e: 'reorder-groups', orderedIds: string[]): void
  (e: 'reorder-group-sessions', payload: { groupId: string; orderedIds: string[] }): void
  (e: 'move-session', payload: { sessionId: string; toGroupId: string | '__root__' }): void
  /** 项目分组拖拽：组序 / 组内会话序 */
  (e: 'reorder-project-groups', orderedIds: string[]): void
  (e: 'reorder-project-sessions', payload: { projectId: string; orderedIds: string[] }): void
  /** 多选批操作 */
  (e: 'batch-move', payload: { sessionIds: string[]; toGroupId: string | '__root__' }): void
  (e: 'batch-destroy', sessionIds: string[]): void
}>()

const { t } = useI18n()
const projectGroups = computed(() => props.projectGroups ?? [])
// hasAny 含自定义分组（P-20261004-79）：自定义分组是「仅结构」实体（成员可为
// 幽灵会话/空），filteredNamedGroups 的注释意图本就是空组可见可移入会话——
// 不入门槛会在「零会话 + 有分组」形态下让整棵树（含刚恢复/新建的组）被引导
// 空态顶掉（工作区预设恢复会话组结构后组头不可见即此处）
const hasAny = computed(() => props.sessions.length > 0 || projectGroups.value.length > 0 || props.groups.length > 0)
/** 终端会话页签：页签语义互斥——Claude 页签只渲染 Claude 列表，不再把终端
 *  分组树堆叠在其下方（两段内容挤一列，视觉归属混乱） */
const isTermTab = computed(() => (props.listTab ?? 'terminals') === 'terminals')

// ============== 即时筛选（终端会话页签；纯展示层过滤，不改数据源与分组持久化） ==============
const filterQuery = ref('')
function hitName(target: string): boolean {
  const q = filterQuery.value.trim().toLowerCase()
  return !q || target.toLowerCase().includes(q)
}

// ============== 时间过滤 chips（P-20261003-174）：今天/本周/全部 ==============
// 与名称即时筛选 AND 叠加、与 Claude 页签 chips 同族互不影响；纯展示层过滤。
// 「本周」= 滚动 7 天窗口（与 Claude 列表既有「最近 7 天」时间分段同口径）：
// 日历周起点随 locale/周一约定漂移且周一清晨近退化，滚动窗口三平台语义一致。
/** 点选互斥（single-select，激活项即当前窗口；「全部」= 不过滤） */
type SessionTimeFilter = 'today' | 'week' | 'all'
const timeFilterMarks: SessionTimeFilter[] = ['today', 'week', 'all']
const timeFilter = ref<SessionTimeFilter>('all')
/** 会话时间基点（ms）：运行中恒为「现在」（runningMap 不依赖输出事件）；
 *  其次活动时间（OSC 133）；都缺回退创建时间——activityMap 只由已连接宿主
 *  的输出事件写入，页面刷新后为空，无兜底会把今天创建的会话也清出「今天」。
 *  全缺返回 0 = 不属任何窗口（仅「全部」可见，不虚构时间） */
function sessionTs(id: string): number {
  if (props.runningMap?.[id] === true) return Date.now()
  const act = props.activityMap?.[id]
  if (act) return act
  const created = props.createdMap?.[id]
  if (created) {
    const t = Date.parse(created)
    if (!Number.isNaN(t)) return t
  }
  return 0
}
function hitTime(id: string): boolean {
  if (timeFilter.value === 'all') return true
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const start = timeFilter.value === 'today' ? startOfToday : startOfToday - 6 * 86_400_000
  return sessionTs(id) >= start
}

// ============== runtime 筛选芯片（P-20261004-84）：多选 OR 维度过滤 ==============
// 与名称/时间过滤 AND 叠加（三过滤正交，先 runtime 后名称只是阅读顺序——判定
// 相互独立）；选中集持久化在 store（宿主传 prop + toggle/clear 两 action 回写，
// 同 sortMode/groupMode 的宿主绑定形态）。命中判定/候选清单走
// utils/sessionRuntimeGroups 纯函数——与分组视图（P-20261003-238）同一键空间
//（空值归 shell、同款组序），两呈现面不分叉。
const runtimeSel = computed(() => props.runtimeFilter ?? new Set<string>())
/** 命中判定收口：项目分组条目不携 runtime 字段（项目会话按构造是 kind=shell），
 *  传 undefined 由纯函数归一 shell——调用方不自行补键 */
function hitRuntime(runtime?: string): boolean {
  return sessionMatchesRuntimeFilter(runtime, runtimeSel.value)
}
/** 芯片候选 = 系统会话 runtime 去重（不过滤后集合——过滤态收窄芯片会把退出的
 *  路收走）∪ 项目分组存在时的 shell 键（项目会话按构造归 shell，见 hitRuntime）。
 *  无成员的 runtime 不产芯片（动态清单） */
const runtimeChipKeys = computed(() => {
  const keys = runtimeFilterOptions(props.sessions)
  if (projectGroups.value.length > 0 && !keys.includes(RUNTIME_FALLBACK_KEY)) {
    keys.push(RUNTIME_FALLBACK_KEY)
  }
  return keys
})

const filteredProjectGroups = computed(() =>
  projectGroups.value
    .map((pg) => {
      const nameHit = hitName(pg.name)
      // 时间过滤激活时项目名命中不再整组保留：组内会话仍须落在时间窗口内
      if (nameHit && timeFilter.value === 'all' && runtimeSel.value.size === 0) return pg
      return { ...pg, sessions: pg.sessions.filter(s => (nameHit || hitName(s.name)) && hitTime(s.id) && hitRuntime()) }
    })
    .filter(pg => pg.sessions.length > 0),
)
const filteredRootSessions = computed(() => {
  const grouped = new Set(props.groups.flatMap(g => g.sessionIds))
  const roots = props.sessions.filter(s => !grouped.has(s.id))
  return roots.filter(s => hitName(s.name) && hitTime(s.id) && hitRuntime(s.runtime))
})
const filteredNamedGroups = computed(() => {
  // 无查询且无时间过滤且无 runtime 筛选：渲染全部分组（含新建的空组——过滤掉
  // 会永远不可见、也无法移入会话）；过滤态（任一激活）：仅保留名称命中或含
  // 命中会话的分组（时间/runtime 过滤下空组无会话可显，随项目分组同语义隐藏）
  if (!filterQuery.value.trim() && timeFilter.value === 'all' && runtimeSel.value.size === 0) return props.groups
  return props.groups
    .map((g) => {
      const nameHit = hitName(g.name)
      return { ...g, sessionIds: sessionsOf(g.id).filter(s => (nameHit || hitName(s.name)) && hitTime(s.id) && hitRuntime(s.runtime)).map(s => s.id) }
    })
    .filter(g => g.sessionIds.length > 0)
})

// ============== 按 runtime 分组视图（P-20261003-238）：平铺/分组 toggle ==============
// 纯展示层投影：全部系统会话（含自定义分组内的——分组视图盖过自定义分组的
// 组织方式，uiState 数据不动，切回 flat 全量还原）按 runtime 注册名归组。
// 名称筛选/时间 chips 照常 AND 叠加（正交组合）；项目分组树不受影响（项目
// 维度与运行时维度互斥呈现，会话行不双渲染）。组序/组内序见纯函数注记。
const runtimeView = computed(() => isTermTab.value && (props.groupMode ?? 'flat') === 'runtime')
const runtimeGroups = computed(() => {
  if (!runtimeView.value) return []
  return groupSessionsByRuntime(props.sessions.filter(s => hitName(s.name) && hitTime(s.id) && hitRuntime(s.runtime)))
})

const filterActive = computed(() => !!filterQuery.value.trim() || timeFilter.value !== 'all' || runtimeSel.value.size > 0)
const filterNoMatch = computed(() => {
  if (!filterActive.value) return false
  if (runtimeView.value) return runtimeGroups.value.length === 0 && filteredProjectGroups.value.length === 0
  return (
    filteredProjectGroups.value.length === 0 &&
    filteredRootSessions.value.length === 0 &&
    filteredNamedGroups.value.length === 0
  )
})

/** 组内会话寻址（筛选态需要按原始分组还原会话列表） */
function sessionsOf(groupId: string): AgentTermSession[] {
  const g = props.groups.find(gg => gg.id === groupId)
  if (!g) return []
  const byId = new Map(props.sessions.map(s => [s.id, s]))
  return g.sessionIds.map(id => byId.get(id)).filter((s): s is AgentTermSession => !!s)
}

// ============== 舰队发起入口（P-20261005-152） ==============
// 经 Layout 桥（useLayoutBridge.openFleetBulkAgent）打开宿主 FleetBulkAgentDialog
// ——与 palette「批量 agent 任务」同一条弹层同一状态位，不另起实例；桥未注入
//（独立渲染/单测）时整钮隐藏（openTerminalInDir 同款注入缺省降级）。
// 置灰门槛：项目数 <2（编队语义至少两个项目），与弹层内选项目校验同语义前置——
// gate 读 project store（引导期/变更流刷新均回填，computed 响应式自愈）
const fleetEntry = inject<(() => void) | undefined>('openFleetBulkAgent', undefined)
const projectStore = useProjectStore()
const fleetGateReady = computed(() => projectStore.projects.length >= 2)
const fleetEntryTitle = computed(() =>
  fleetGateReady.value ? t('agentTerminal.fleet.sidebarEntry') : t('agentTerminal.fleet.needProjects'),
)

// ============== 新建分组（内联输入） ==============
const creatingGroup = ref(false)
const newGroupName = ref('')
function confirmCreateGroup() {
  // Enter 触发后 v-if 卸载输入框会再触发 blur：退出创建态后忽略重复确认
  if (!creatingGroup.value) return
  const name = newGroupName.value.trim()
  if (!name) {
    creatingGroup.value = false
    return
  }
  emit('group-action', { key: 'create', name })
  newGroupName.value = ''
  creatingGroup.value = false
}

// ============== 排序方式（终端会话页签内；选项即 store 的 sortMode） ==============
const sortMenu = ref(false)
const sortMenuX = ref(0)
const sortMenuY = ref(0)
const sortMarks: SessionSortMode[] = ['default', 'name', 'activity']
const sortLabel: Record<SessionSortMode, string> = {
  default: t('agentTerminal.sortDefault'),
  name: t('agentTerminal.sortByName'),
  activity: t('agentTerminal.sortRecent'),
}
const sortOptions = computed(() => {
  const mode = props.sortMode ?? 'default'
  return sortMarks.map(m => ({ label: `${mode === m ? '✓ ' : ''}${sortLabel[m]}`, key: m }))
})
function openSortMenu(e: MouseEvent) {
  sortMenuX.value = e.clientX
  sortMenuY.value = e.clientY
  sortMenu.value = true
}
</script>

<template>
  <aside class="ats-root">
    <!-- 新建会话 + 舰队发起（P-20261005-152）：同排 quaternary 小钮直达 Layout
         宿主的 FleetBulkAgentDialog（palette「批量 agent 任务」同一条弹层）；
         项目数不足两枚置灰、title 说明门槛；桥未注入时按钮降级隐藏 -->
    <div
      v-if="isTermTab"
      class="ats-new-row"
    >
      <n-button
        size="small"
        type="primary"
        block
        class="ats-new"
        data-sc-selection-drop="new-session"
        @click="emit('create')"
      >
        <template #icon>
          <n-icon size="13">
            <AddOutline />
          </n-icon>
        </template>
        {{ t('agentTerminal.newSession') }}
      </n-button>
      <n-button
        v-if="fleetEntry"
        size="small"
        quaternary
        class="ats-fleet"
        :disabled="!fleetGateReady"
        :title="fleetEntryTitle"
        :aria-label="fleetEntryTitle"
        data-test="fleet-launch-entry"
        @click="fleetEntry()"
      >
        <template #icon>
          <n-icon size="13">
            <FlashOutline />
          </n-icon>
        </template>
      </n-button>
    </div>

    <!-- 列表页签：终端会话 / Claude 会话（方案 A：文字页签，可扩展第三类会话） -->
    <div class="ats-tabs">
      <button
        class="ats-tab"
        :class="{ active: (props.listTab ?? 'terminals') === 'terminals' }"
        @click="emit('update:listTab', 'terminals')"
      >
        <n-icon size="11">
          <TerminalOutline />
        </n-icon>
        <span>{{ t('agentTerminal.termSessionsTab') }}</span>
      </button>
      <button
        class="ats-tab"
        :class="{ active: props.listTab === 'claude' }"
        :title="t('claudeSessions.title')"
        @click="emit('update:listTab', 'claude')"
      >
        <BrandIcon
          name="claude"
          :size="12"
        />
        <span>Claude</span>
      </button>
      <button
        v-if="(props.listTab ?? 'terminals') === 'terminals'"
        class="ats-gmode"
        :class="{ active: runtimeView }"
        :title="runtimeView ? t('agentTerminal.groupFlat') : t('agentTerminal.groupByRuntime')"
        :aria-label="runtimeView ? t('agentTerminal.groupFlat') : t('agentTerminal.groupByRuntime')"
        data-test="session-group-toggle"
        @click.stop="emit('update:groupMode', runtimeView ? 'flat' : 'runtime')"
      >
        <n-icon size="12">
          <GridOutline />
        </n-icon>
      </button>
      <button
        v-if="(props.listTab ?? 'terminals') === 'terminals'"
        class="ats-sort"
        :title="t('agentTerminal.sortLabel')"
        @click.stop="openSortMenu"
      >
        <n-icon size="12">
          <SwapVerticalOutline />
        </n-icon>
      </button>
      <!-- trigger=manual + x/y 定位的 dropdown 不渲染默认插槽（naive-ui positionManually
           路径返回 null），触发按钮必须是其兄弟节点、dropdown 自闭合 -->
      <n-dropdown
        v-if="(props.listTab ?? 'terminals') === 'terminals'"
        trigger="manual"
        :show="sortMenu"
        :options="sortOptions"
        placement="bottom-end"
        :x="sortMenuX"
        :y="sortMenuY"
        @select="(key: string) => { sortMenu = false; emit('update:sortMode', key as SessionSortMode) }"
        @clickoutside="sortMenu = false"
      />
    </div>

    <!-- 即时筛选（终端会话页签；纯展示层过滤） -->
    <n-input
      v-if="(props.listTab ?? 'terminals') === 'terminals' && hasAny"
      v-model:value="filterQuery"
      size="tiny"
      clearable
      :placeholder="t('agentTerminal.searchPlaceholder')"
      class="ats-filter"
    >
      <template #prefix>
        <n-icon size="11">
          <SearchOutline />
        </n-icon>
      </template>
    </n-input>

    <!-- 时间过滤 chips（P-20261003-174）：与名称筛选 AND 叠加；筛选态即便
         无会话也保持可见（否则「今天」过滤出空后无从退出） -->
    <div
      v-if="isTermTab && (hasAny || timeFilter !== 'all')"
      class="ats-time-chips"
      data-test="session-time-chips"
    >
      <button
        v-for="m in timeFilterMarks"
        :key="m"
        class="ats-time-chip"
        :class="{ active: timeFilter === m }"
        :data-test="`session-time-chip-${m}`"
        @click="timeFilter = m"
      >
        {{ t(`agentTerminal.timeChip.${m}`) }}
      </button>
    </div>

    <!-- runtime 筛选芯片（P-20261004-84）：多选 OR 语义（命中任一选中 runtime），
         与名称/时间过滤 AND 叠加；候选 = 当前会话集合动态去重（无成员不产芯片），
         「全部」= 清空选中集的恢复档。筛选态即便候选清空也保持可见（选中集剪枝
         随会话对账同汰，但快照间隙里不能让用户失去退出筛选的入口） -->
    <div
      v-if="isTermTab && (runtimeChipKeys.length > 0 || runtimeSel.size > 0)"
      class="ats-runtime-chips"
      data-test="session-runtime-chips"
    >
      <button
        class="ats-runtime-chip"
        :class="{ active: runtimeSel.size === 0 }"
        data-test="session-runtime-chip-all"
        :title="t('agentTerminal.runtimeChipLabel')"
        :aria-label="t('agentTerminal.runtimeChipLabel')"
        @click="emit('clear-runtime-filter')"
      >
        {{ t('agentTerminal.runtimeChipAll') }}
      </button>
      <button
        v-for="key in runtimeChipKeys"
        :key="key"
        class="ats-runtime-chip"
        :class="{ active: runtimeSel.has(key) }"
        :data-test="`session-runtime-chip-${key}`"
        :title="t('agentTerminal.runtimeChipLabel')"
        :aria-label="`${t('agentTerminal.runtimeChipLabel')} ${agentLabelOf(key, key)}`"
        @click="emit('toggle-runtime-filter', key)"
      >
        {{ agentLabelOf(key, key) }}
      </button>
    </div>

    <!-- Claude 会话列表（scope=global，含项目筛选） -->
    <ClaudeSessionPicker
      v-if="props.listTab === 'claude'"
      scope="global"
      class="ats-claude"
      @resumed="(id: string) => { emit('update:listTab', 'terminals'); emit('select', id) }"
    />

    <n-spin
      v-if="isTermTab && booting"
      size="small"
      class="ats-boot"
    />
    <!-- 引导式空态：说明 + 主操作（与远程主机列表空态同款惯例） -->
    <div
      v-else-if="isTermTab && !hasAny"
      class="ats-empty"
    >
      {{ t('agentTerminal.noSessions') }}
    </div>
    <div
      v-else-if="isTermTab"
      class="ats-list"
    >
      <!-- 三个列表区 + 右键菜单 + 重命名 + 多选批操作（AgentSidebarSessionTree）；
           runtime 分组视图下树内改渲染运行时组段（显式开关 + 投影注入） -->
      <AgentSidebarSessionTree
        :sessions="sessions"
        :groups="groups"
        :project-groups="projectGroups"
        :filtered-project-groups="filteredProjectGroups"
        :filtered-root-sessions="filteredRootSessions"
        :filtered-named-groups="filteredNamedGroups"
        :runtime-view="runtimeView"
        :runtime-groups="runtimeGroups"
        :active-id="activeId"
        :selected-id="selectedId"
        :running-map="runningMap"
        :activity-map="activityMap"
        :unread-map="unreadMap"
        :collapsed-projects="collapsedProjects"
        :collapsed-groups="collapsedGroups"
        :locate-dirs="locateDirs"
        :direct-holds="directHolds"
        :live-titles="liveTitles"
        @select="(id) => emit('select', id)"
        @attach-project="(id) => emit('attach-project', id)"
        @toggle-project="(projectId) => emit('toggle-project', projectId)"
        @toggle-group="(groupId) => emit('toggle-group', groupId)"
        @exit-runtime-view="emit('update:groupMode', 'flat')"
        @project-action="(payload) => emit('project-action', payload)"
        @project-session-action="(payload) => emit('project-session-action', payload)"
        @capability-action="(payload) => emit('capability-action', payload)"
        @session-action="(payload) => emit('session-action', payload)"
        @locate-tree="(id) => emit('locate-tree', id)"
        @cross-review="(id) => emit('cross-review', id)"
        @chain-continue="(id) => emit('chain-continue', id)"
        @review-mark="(id) => emit('review-mark', id)"
        @toggle-sensitive="(id) => emit('toggle-sensitive', id)"
        @direct-revoke="(id) => emit('direct-revoke', id)"
        @relaunch="(id) => emit('relaunch', id)"
        @postmortem="(id) => emit('postmortem', id)"
        @rename-project="(payload) => emit('rename-project', payload)"
        @group-action="(payload) => emit('group-action', payload)"
        @reorder-groups="(ids) => emit('reorder-groups', ids)"
        @reorder-group-sessions="(payload) => emit('reorder-group-sessions', payload)"
        @move-session="(payload) => emit('move-session', payload)"
        @reorder-project-groups="(ids) => emit('reorder-project-groups', ids)"
        @reorder-project-sessions="(payload) => emit('reorder-project-sessions', payload)"
        @batch-move="(payload) => emit('batch-move', payload)"
        @batch-destroy="(ids) => emit('batch-destroy', ids)"
      />

      <!-- 筛选无结果 -->
      <div
        v-if="filterNoMatch"
        class="ats-no-match"
      >
        {{ t('agentTerminal.noMatchSession') }}
      </div>
    </div>

    <!-- 新建分组入口（终端会话页签专属：分组是终端树的组织概念；runtime
         分组视图下自定义分组不渲染，此入口随之隐藏——建了看不见的组是死胡同，
         会话移入分组回到平铺视图进行） -->
    <div
      v-if="isTermTab && !runtimeView"
      class="ats-footer"
    >
      <n-input
        v-if="creatingGroup"
        v-model:value="newGroupName"
        size="tiny"
        :placeholder="t('agentTerminal.groupNamePlaceholder')"
        autofocus
        @keyup.enter="confirmCreateGroup"
        @blur="confirmCreateGroup"
      />
      <n-button
        v-else
        size="tiny"
        quaternary
        block
        @click="creatingGroup = true"
      >
        <template #icon>
          <n-icon size="12">
            <FolderOutline />
          </n-icon>
        </template>
        {{ t('agentTerminal.newGroup') }}
      </n-button>
    </div>
  </aside>
</template>

<style scoped>
.ats-root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 10px;
  gap: 8px;
  min-height: 0;
}
/* 新建会话 + 舰队发起同排（P-20261005-152）：主钮吃满剩余宽度，舰队小钮
   定宽（flex-shrink:0）不被窄栏挤压；最小侧栏宽 160px 下主钮文字仍完整 */
.ats-new-row { display: flex; gap: 6px; flex-shrink: 0; }
.ats-new { flex: 1; min-width: 0; }
.ats-fleet { flex-shrink: 0; }
.ats-boot, .ats-empty { flex: 1; display: flex; align-items: center; justify-content: center; }
.ats-list { flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }

.ats-footer { flex-shrink: 0; }

/* 列表页签：终端会话 / Claude 会话（方案 A 文字页签） */
.ats-tabs {
  display: flex;
  gap: 4px;
  padding: 6px 8px 4px;
  flex-shrink: 0;
}
.ats-tab {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 11px;
  cursor: pointer;
}
/* 窄面板下页签文字不换行（挤压时省略号兜底，不破坏行高） */
.ats-tab span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ats-tab:hover { background: var(--bg-hover); color: var(--text-secondary); }
.ats-tab.active {
  background: var(--bg-active);
  color: var(--text-primary);
  font-weight: 500;
  border-color: var(--border-default);
}
/* 排序方式按钮（页签行右端，固定宽度不参与 tab 拉伸） */
.ats-sort {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  flex-shrink: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.ats-sort:hover { background: var(--bg-hover); color: var(--text-secondary); }
/* 分组视图 toggle（P-20261003-238）：排序钮同款视觉语，激活态亮显（与页签
   active 同源变量）——当前处于哪个呈现面恒可见 */
.ats-gmode {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  flex-shrink: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.ats-gmode:hover { background: var(--bg-hover); color: var(--text-secondary); }
.ats-gmode.active {
  background: var(--bg-active);
  color: var(--text-primary);
  border-color: var(--border-default);
}
/* 即时筛选输入框 */
.ats-filter { flex-shrink: 0; }
/* 时间过滤 chips（P-20261003-174）：与 cp-cc-chip 同视觉语（CSS 变量零硬编码色） */
.ats-time-chips { display: flex; gap: 4px; flex-shrink: 0; }
.ats-time-chip {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 10px;
  cursor: pointer;
  transition: all var(--motion-fast);
}
.ats-time-chip:hover { border-color: var(--brand-accent); color: var(--brand-accent); }
.ats-time-chip.active { border-color: currentColor; color: var(--brand-accent); font-weight: 600; }
/* runtime 筛选芯片（P-20261004-84）：时间 chips 同族视觉语（多选 toggle，
 * 「全部」恢复档亮显 = 未过滤态）；窄面板换行不溢出 */
.ats-runtime-chips { display: flex; gap: 4px; flex-shrink: 0; flex-wrap: wrap; }
.ats-runtime-chip {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 10px;
  font-family: var(--font-mono);
  cursor: pointer;
  transition: all var(--motion-fast);
}
.ats-runtime-chip:hover { border-color: var(--brand-accent); color: var(--brand-accent); }
.ats-runtime-chip.active { border-color: currentColor; color: var(--brand-accent); font-weight: 600; }
/* 筛选无结果提示 */
.ats-no-match {
  padding: 10px 6px;
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
}
.ats-claude { flex: 1; min-height: 0; }

.ats-empty { padding: 16px 10px; font-size: 0.82em; color: var(--text-muted); text-align: center; }
</style>
