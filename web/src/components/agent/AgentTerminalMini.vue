<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NDropdown, NEmpty, NIcon } from 'naive-ui'
import { ChatbubblesOutline, RefreshOutline } from '@vicons/ionicons5'
import { useRouter } from 'vue-router'
import { useI18n } from '../../composables/useI18n'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useProjectStore } from '../../stores/project'
import { useApprovalsStore } from '../../stores/approvals'
import { useAssistantTaskStore } from '../../stores/assistantTask'
import { usePreviewPortStore } from '../../stores/previewPort'
import { useInstanceStore } from '../../stores/instance'
import { safeStorage } from '../../utils/storage'
import { relativeTimeParts } from '../../utils/relative-time'
import { sessionBadgeDecision } from '../../utils/session-idle'
import { isDepositStatus } from '../../utils/notesDeposit'
import { parseRemoteTaskKey } from '../../utils/remoteTaskKey'
import { useNotesDeposit } from '../../composables/useNotesDeposit'
import { useStallTriageStore } from '../../stores/stallTriage'

/**
 * 智能体收起形态：可拖拽悬浮球/悬浮条/悬浮列表。
 * - 拖拽：pointer 事件自由移动（视口内夹紧），位置持久化 localStorage
 * - 单击（位移 < 阈值）：回到上次展开形态（float/docked）
 * - 右键：样式菜单（形态 球/条/列表、尺寸 小/中/大、透明度 标准/半透明），持久化
 * - 悬浮列表：全部会话按项目分组 + 运行点，点击项目会话=跳转项目并激活 tab、
 *   点击系统会话=展开悬浮窗；底部快捷操作 刷新/管理页/悬浮窗/关闭
 * - 进度：运行中呼吸环 + 条内步骤文本实时跟随 taskStore（ops-notify 上报）
 */
const { t } = useI18n()
const taskStore = useAssistantTaskStore()
const sessionsStore = useTerminalSessionsStore()
const projectStore = useProjectStore()
const router = useRouter()
const approvals = useApprovalsStore()
const stallTriage = useStallTriageStore()
const { sessions, running, open, refresh, setMode, hide, jumpToProjectSession, jumpToAgentSession } = useAgentTerminal()
const assistantTaskStore = useAssistantTaskStore()
const previewPortStore = usePreviewPortStore()
const { depositCurrentTask } = useNotesDeposit()

// ============== 形态与样式（持久化） ==============
const STYLE_KEY = 'sc.agentTerminal.ballStyle'
interface BallStyle {
  shape: 'ball' | 'bar' | 'list'
  size: 'small' | 'medium' | 'large'
  opacity: 'solid' | 'translucent'
}

function loadStyle(): BallStyle {
  try {
    const raw = safeStorage.getItem(STYLE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as BallStyle
      if ((s.shape === 'ball' || s.shape === 'bar' || s.shape === 'list') && (s.size === 'small' || s.size === 'medium' || s.size === 'large') && (s.opacity === 'solid' || s.opacity === 'translucent')) {
        return s
      }
    }
  } catch { /* 损坏即回默认 */ }
  return { shape: 'ball', size: 'medium', opacity: 'solid' }
}

const style = ref<BallStyle>(loadStyle())
function saveStyle() {
  safeStorage.setItem(STYLE_KEY, JSON.stringify(style.value))
}

// 尺寸 → 像素（球直径 / 条宽高 / 列表宽），拖拽夹紧与布局共用
const BALL_PX = { small: 40, medium: 52, large: 64 } as const
const BAR_PX = { small: { w: 190, h: 34 }, medium: { w: 240, h: 40 }, large: { w: 300, h: 46 } } as const
const LIST_W = { small: 220, medium: 260, large: 300 } as const
const box = computed(() => {
  if (style.value.shape === 'bar') {
    const b = BAR_PX[style.value.size]
    return { w: b.w, h: b.h }
  }
  if (style.value.shape === 'list') {
    return { w: LIST_W[style.value.size], h: 0 } // 列表高度自适应，夹紧只按宽
  }
  return { w: BALL_PX[style.value.size], h: BALL_PX[style.value.size] }
})

// ============== 位置（持久化 + 视口夹紧） ==============
const POS_KEY = 'sc.agentTerminal.ballPos'
function clampPos(p: { x: number; y: number }): { x: number; y: number } {
  const { w, h } = box.value
  return {
    x: Math.min(Math.max(p.x, w / 2 + 4), window.innerWidth - w / 2 - 4),
    y: Math.min(Math.max(p.y, h / 2 + 4), window.innerHeight - h / 2 - 4),
  }
}
function loadPos(): { x: number; y: number } {
  try {
    const raw = safeStorage.getItem(POS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as { x: number; y: number }
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) return clampPos(p)
    }
  } catch { /* 损坏即回默认 */ }
  return clampPos({ x: window.innerWidth - 60, y: 80 })
}

const pos = ref(loadPos())

// ============== 拖拽 vs 点击 ==============
const DRAG_THRESHOLD = 5
const dragging = ref(false) // 拖拽进行中：半透明反馈，避开「遮挡落点」
let dragStart = { mx: 0, my: 0, x: 0, y: 0 }
let moved = false

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  moved = false
  dragging.value = false
  dragStart = { mx: e.clientX, my: e.clientY, x: pos.value.x, y: pos.value.y }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}
function onPointerMove(e: PointerEvent) {
  const dx = e.clientX - dragStart.mx
  const dy = e.clientY - dragStart.my
  if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
  moved = true
  dragging.value = true
  pos.value = clampPos({ x: dragStart.x + dx, y: dragStart.y + dy })
}
function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  dragging.value = false
  if (moved) {
    safeStorage.setItem(POS_KEY, JSON.stringify(pos.value))
  } else if (style.value.shape !== 'list') {
    // 单击 = 跳到「进度所属会话」（P7 归属，CC_TERMINAL_ID 上报精确锚定）；
    // 无归属时回退上次展开形态（open 内部处理 mini 恢复与缺会话兜底）；
    // 列表形态自身承载交互，行点击不展开。
    // 远程归属（P-20261004-131）：会话本体在对端，本地直达无意义 → 跳实例
    //（通知 switch-instance 同款链；幂等守卫对未知/当前实例无副作用）
    const sid = assistantTaskStore.latestSessionId
    if (sid && taskStore.active) {
      const remote = parseRemoteTaskKey(sid)
      if (remote) {
        void useInstanceStore().selectInstance(remote.instanceId)
        return
      }
      const target = sessionsStore.sessions.find(ss => ss.id === sid)
      if (target?.kind === 'shell' && target.projectId) {
        void jumpToProjectSession(target.projectId, target.id, router)
        return
      }
      void jumpToAgentSession(sid)
      return
    }
    void open()
  }
}

// ============== 悬浮列表（第三形态）：全部会话导航 + 快捷操作 ==============
interface ListRow {
  id: string
  name: string
  kind: string
  projectId: string
  projectName: string
  running: boolean
}
const listRows = computed<ListRow[]>(() =>
  sessionsStore.sortedSessions
    .map(s => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      projectId: s.projectId,
      projectName: projectStore.projects.find(p => p.id === s.projectId)?.name || '',
      running: sessionsStore.runningMap[s.id] === true,
    })))
const refreshing = ref(false)
async function onRefreshList() {
  refreshing.value = true
  await refresh()
  refreshing.value = false
}
function onRowClick(row: ListRow) {
  if (row.kind === 'shell' && row.projectId) {
    void jumpToProjectSession(row.projectId, row.id, router)
  } else {
    void jumpToAgentSession(row.id)
  }
}

// ============== 悬浮列表窗口化渲染：固定行高按 scrollTop 切片 ==============
// 大量会话时只挂载视口 ± overscan 的行（spacer 撑总高 + 行绝对定位），
// 常规量级切片覆盖全量，行为与普通 v-for 无异
const LIST_ROW_H = 26
const LIST_OVERSCAN = 5
const listViewportRef = ref<HTMLElement | null>(null)
const listScrollTop = ref(0)
const listViewportH = ref(0)
// 列表容器随 listRows 非空才挂载（v-if）：watch ref 在元素出现时接 ResizeObserver，
// 卸载时随 onCleanup 断开——onMounted 时元素尚不存在，不能只挂一次
watch(listViewportRef, (el, _prev, onCleanup) => {
  if (!el) return
  listViewportH.value = el.clientHeight
  const ro = new ResizeObserver(() => {
    listViewportH.value = el.clientHeight
  })
  ro.observe(el)
  onCleanup(() => ro.disconnect())
})
function onListScroll() {
  listScrollTop.value = listViewportRef.value?.scrollTop ?? 0
}
/** 行静默/停滞标档位决策（P-20261004-37 共用纯函数）：停滞强标优先，弱标
 *  /pending 特化回落。读 nowTick 登记心跳依赖——分钟数随 30s 心跳随时间重算 */
function rowBadge(row: ListRow) {
  void assistantTaskStore.nowTick
  const p = assistantTaskStore.bySession[row.id]
  return sessionBadgeDecision({
    taskRunning: p?.status === 'running',
    running: sessionsStore.runningMap[row.id],
    lastActivity: sessionsStore.activityMap[row.id],
    lastReportAt: p?.updatedAt,
    hasPendingApproval: approvals.pendingSessionIds.has(row.id),
  })
}
/** 行标点击：停滞强标开分诊卡（截停防触发行跳转）；弱标不拦截——与既有
 *  「点行跳会话」行为一致 */
function onRowBadgeClick(row: ListRow, e: MouseEvent): void {
  if (!rowBadge(row).stall) return
  e.stopPropagation()
  stallTriage.openSession(row.id)
}
/** 行 tooltip：基础提示 + 最近活动相对时间（有活动记录时）+ 静默/停滞 hover 提示 */
function rowTitle(row: ListRow): string {
  const lines = [row.kind === 'shell' ? t('agentTerminal.attachTip') : t('agentTerminal.openFloat')]
  const ts = sessionsStore.activityMap[row.id]
  if (ts) {
    const p = relativeTimeParts(ts)
    lines.push(`${t('agentTerminal.lastActivity')}: ${t(`agentTerminal.${p.key}`, { n: p.n })}`)
  }
  const badge = rowBadge(row)
  if (badge.n > 0) lines.push(t(badge.tip))
  return lines.join('\n')
}
const listRangeStart = computed(() =>
  Math.max(0, Math.floor(listScrollTop.value / LIST_ROW_H) - LIST_OVERSCAN))
const listRangeEnd = computed(() =>
  Math.min(listRows.value.length, Math.ceil((listScrollTop.value + listViewportH.value) / LIST_ROW_H) + LIST_OVERSCAN))
const visibleListRows = computed(() => listRows.value.slice(listRangeStart.value, listRangeEnd.value))

/** 列表收起为悬浮球（切换形态 + 持久化） */
function collapseToBall() {
  style.value.shape = 'ball'
  saveStyle()
}

// ============== 右键样式菜单 ==============
const styleMenu = ref(false)
const styleMenuX = ref(0)
const styleMenuY = ref(0)
function openStyleMenu(e: MouseEvent) {
  styleMenuX.value = e.clientX
  styleMenuY.value = e.clientY
  styleMenu.value = true
}
const styleOptions = computed(() => {
  const mark = (on: boolean) => (on ? '✓ ' : '')
  return [
    { label: `${mark(style.value.shape === 'ball')}${t('agentTerminal.ballShapeBall')}`, key: 'shape:ball' },
    { label: `${mark(style.value.shape === 'bar')}${t('agentTerminal.ballShapeBar')}`, key: 'shape:bar' },
    { label: `${mark(style.value.shape === 'list')}${t('agentTerminal.ballShapeList')}`, key: 'shape:list' },
    { type: 'divider' as const, key: 'd1' },
    { label: `${mark(style.value.size === 'small')}${t('agentTerminal.ballSize_small')}`, key: 'size:small' },
    { label: `${mark(style.value.size === 'medium')}${t('agentTerminal.ballSize_medium')}`, key: 'size:medium' },
    { label: `${mark(style.value.size === 'large')}${t('agentTerminal.ballSize_large')}`, key: 'size:large' },
    { type: 'divider' as const, key: 'd2' },
    { label: `${mark(style.value.opacity === 'solid')}${t('agentTerminal.ballOpacitySolid')}`, key: 'opacity:solid' },
    { label: `${mark(style.value.opacity === 'translucent')}${t('agentTerminal.ballOpacityTranslucent')}`, key: 'opacity:translucent' },
  ]
})
function onStyleSelect(key: string) {
  const [kind, value] = key.split(':')
  if (kind === 'shape' && (value === 'ball' || value === 'bar' || value === 'list')) style.value.shape = value
  else if (kind === 'size' && (value === 'small' || value === 'medium' || value === 'large')) {
    style.value.size = value
    pos.value = clampPos(pos.value) // 尺寸变化后重新夹紧
  } else if (kind === 'opacity' && (value === 'solid' || value === 'translucent')) style.value.opacity = value
  saveStyle()
}

const isOn = computed(() => running.value || taskStore.active)
// 沉淀到笔记入口（P-20261003-292）：任务终态（done/failed）后可见——agent 忘了
// 手册「结论沉淀约定」时，人一键把预填模板写进项目笔记再编辑补充。
// 与状态点同一数据源（taskStore.status），终态保持到下一次任务上报前
const taskTerminal = computed(() => isDepositStatus(taskStore.status))
async function onDeposit() {
  await depositCurrentTask()
}
// 可能失联（P-20261003-303）：全局 running 且超时无上报——弱化「活着」的呼吸
// 环+条形态失联徽标（不清数据，真终态到达仍可覆盖）
const taskStale = computed(() => taskStore.isStale)
// 步骤清单（P-20261004-7）：displaySteps 取归属会话优先；step 为当前项指针
const stepsProgress = computed(() => {
  const steps = assistantTaskStore.displaySteps
  if (steps.length === 0) return null
  return { done: steps.filter(s => s.done).length, total: steps.length }
})
const statusTitle = computed(() => {
  const parts = [taskStore.task, taskStore.step].filter(Boolean)
  let base = parts.join(' · ') || t('agentTerminal.idle')
  // 远程来源注记（P-20261004-131）：进度所属会话是联邦派发的对端会话时，
  // tooltip 标注来源实例（徽标同源）
  const latestRemote = parseRemoteTaskKey(assistantTaskStore.latestSessionId)
  if (latestRemote) {
    const meta = assistantTaskStore.bySession[assistantTaskStore.latestSessionId!]?.remote
    base += `\n${t('agentTerminal.remoteBadgeTip', { instance: meta?.instanceName || latestRemote.instanceId })}`
  }
  // 失联弱预警行（P-20261003-303）：球/条 tooltip 说明为什么不呼吸
  if (taskStale.value) return `${base}\n${t('agentTerminal.staleTip')}`
  // 清单在位时 tooltip 附多行步骤表：✓ 已完成 / ▶ 当前项（step 指针对应）/ ○ 未完成
  const steps = assistantTaskStore.displaySteps
  if (steps.length === 0) return base
  const lines = steps.map(s => `${s.done ? '✓' : (!s.done && s.name === taskStore.step) ? '▶' : '○'} ${s.name}`)
  return [base, '', ...lines].join('\n')
})
// 任务文本优先显示「进度所属会话」的任务（P7 归属）；无归属时回退全局任务
const barText = computed(() => assistantTaskStore.displayTask || t('agentTerminal.sessionCount', { n: sessions.value.length }))
// 远程来源徽标（P-20261004-131）：进度所属会话是联邦派发的对端会话时，
// 球/条标实例名（来源标注区分本地/远程；名字取回流元数据，退实例 id）
const remoteBadge = computed(() => {
  const sid = assistantTaskStore.latestSessionId
  const remote = parseRemoteTaskKey(sid)
  if (!remote) return ''
  const meta = sid ? assistantTaskStore.bySession[sid]?.remote : undefined
  return meta?.instanceName || remote.instanceId
})

// ============== 预览端口直达快捷按钮（P-20261002-70） ==============
// agent 经 preview.port 上报后出现（会话内常驻——服务在任务结束后仍在跑）；
// 点击直达底部预览面板。按钮非拖拽面：pointerdown/click 双 stop 防触发球体
// 拖拽与「单击跳会话」。P-20261002-83：终端输出被动探测命中（source=detected）
// 走「检测到 :N」弱化样式（虚线描边+降不透明度），区别于 agent 实报的正式样式
const previewDetected = computed(() => previewPortStore.source === 'detected')
const previewBtnLabel = computed(() => {
  if (previewPortStore.port === null) return ''
  return previewDetected.value
    ? t('notify.preview.detectedOpen', { port: previewPortStore.port })
    : t('notify.preview.open', { port: previewPortStore.port })
})
const previewBtnTitle = computed(() =>
  previewPortStore.label || previewBtnLabel.value)
function openPreviewPort(): void {
  if (previewPortStore.port !== null) previewPortStore.openInPanel(previewPortStore.port)
}

function syncClamp() {
  pos.value = clampPos(pos.value)
}
onMounted(() => window.addEventListener('resize', syncClamp))
onBeforeUnmount(() => window.removeEventListener('resize', syncClamp))
</script>

<template>
  <div
    class="agm-root"
    :class="[`is-${style.shape}`, `is-${style.size}`, { 'is-translucent': style.opacity === 'translucent', 'is-running': isOn, 'is-failed': taskStore.status === 'failed', 'is-stale': taskStale, 'is-dragging': dragging }]"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    :title="statusTitle"
    @pointerdown="onPointerDown"
    @contextmenu.prevent="openStyleMenu"
  >
    <!-- 悬浮条：图标 + 会话数/任务步骤 + 状态点 -->
    <template v-if="style.shape === 'bar'">
      <n-icon
        size="16"
        class="agm-icon"
        :class="{ animated: isOn }"
      >
        <ChatbubblesOutline />
      </n-icon>
      <span class="agm-text">
        <span class="agm-task">{{ barText }}</span>
        <span
          v-if="taskStore.step || stepsProgress"
          class="agm-step-row"
        >
          <span
            v-if="taskStore.step"
            class="agm-step"
          >{{ taskStore.step }}</span>
          <!-- 步骤清单进度 n/m（P-20261004-7）：共几步/完成几步一眼可读；
               全表在悬浮球 tooltip（步骤指针 step 对应项 ▶ 标注） -->
          <span
            v-if="stepsProgress"
            class="agm-steps-count"
          >{{ stepsProgress.done }}/{{ stepsProgress.total }}</span>
        </span>
      </span>
      <span
        v-if="remoteBadge"
        class="agm-remote-badge"
        :title="t('agentTerminal.remoteBadgeTip', { instance: remoteBadge })"
      >{{ remoteBadge }}</span>
      <span
        class="agm-dot"
        :class="[taskStore.status, { stale: taskStale }]"
      />
      <!-- 失联弱预警徽标（P-20261003-303）：running 超时无上报，弱样式不弹窗 -->
      <span
        v-if="taskStale"
        class="agm-stale-badge"
        :title="t('agentTerminal.staleTip')"
      >{{ t('agentTerminal.staleBadge') }}</span>
      <!-- 预览端口直达（P-20261002-70）：agent 上报 preview.port 后常驻 -->
      <button
        v-if="previewPortStore.port !== null"
        class="agm-preview-btn"
        :class="{ 'is-detected': previewDetected }"
        :title="previewBtnTitle"
        @pointerdown.stop
        @click.stop="openPreviewPort"
      >
        {{ previewBtnLabel }}
      </button>
      <!-- 沉淀到笔记（P-20261003-292）：任务终态次级入口（非拖拽面，双 stop 防误触拖拽/跳转） -->
      <button
        v-if="taskTerminal"
        class="agm-deposit-btn"
        :title="t('notes.deposit.action')"
        data-testid="agent-notes-deposit"
        @pointerdown.stop
        @click.stop="onDeposit"
      >{{ t('notes.deposit.action') }}</button>
    </template>
    <!-- 悬浮球：图标 + 运行呼吸环 + 会话数徽标 -->
    <template v-else-if="style.shape === 'ball'">
      <n-icon
        size="20"
        class="agm-icon"
        :class="{ animated: isOn }"
      >
        <ChatbubblesOutline />
      </n-icon>
      <span
        v-if="sessions.length > 1"
        class="agm-badge"
      >{{ sessions.length }}</span>
      <span
        v-if="approvals.pendingCount > 0"
        class="agm-badge aprv-badge"
        :title="t('agentTerminal.approvalTitle')"
      >{{ approvals.pendingCount }}</span>
      <!-- 远程来源徽标（P-20261004-131）：进度归属为对端会话时球角标实例名 -->
      <span
        v-if="remoteBadge"
        class="agm-remote-badge"
        :title="t('agentTerminal.remoteBadgeTip', { instance: remoteBadge })"
      >{{ remoteBadge }}</span>
      <!-- 预览端口直达（P-20261002-70）：球形态下挂在球体正下方的小药丸 -->
      <button
        v-if="previewPortStore.port !== null"
        class="agm-preview-btn"
        :class="{ 'is-detected': previewDetected }"
        :title="previewBtnTitle"
        @pointerdown.stop
        @click.stop="openPreviewPort"
      >
        {{ previewBtnLabel }}
      </button>
      <!-- 沉淀到笔记（P-20261003-292）：球形态下同挂球体正下方（预览药丸在位时下移让位，见样式） -->
      <button
        v-if="taskTerminal"
        class="agm-deposit-btn"
        :title="t('notes.deposit.action')"
        data-testid="agent-notes-deposit"
        @pointerdown.stop
        @click.stop="onDeposit"
      >{{ t('notes.deposit.action') }}</button>
    </template>
    <!-- 悬浮列表：会话导航 + 快捷操作（拖拽手柄=头部，行点击=跳转） -->
    <template v-else>
      <div class="agm-list-head">
        <n-icon
          size="13"
          class="agm-icon"
          :class="{ animated: isOn }"
        >
          <ChatbubblesOutline />
        </n-icon>
        <span class="agm-list-title">{{ t('agentTerminal.title') }}</span>
        <span class="agm-list-count">{{ sessions.length }}</span>
        <button
          class="agm-list-btn"
          :title="t('agentTerminal.refreshList')"
          @click.stop="onRefreshList"
        >
          <n-icon
            size="12"
            :class="{ spinning: refreshing }"
          >
            <RefreshOutline />
          </n-icon>
        </button>
        <button
          class="agm-list-btn"
          :title="t('agentTerminal.openFloat')"
          @click.stop="setMode('float')"
        >
          <n-icon size="12">
            <ChatbubblesOutline />
          </n-icon>
        </button>
        <button
          class="agm-list-btn"
          :title="t('common.close')"
          @click.stop="hide()"
        >
          <n-icon size="12">
            ×
          </n-icon>
        </button>
      </div>
      <div
        v-if="listRows.length > 0"
        ref="listViewportRef"
        class="agm-list-body"
        @scroll.passive="onListScroll"
      >
        <!-- 窗口化渲染：大量会话时只挂载视口 ± overscan 的行（spacer 撑起总高，
             行绝对定位）——固定行高切片，避免外部虚拟列表组件对定高的强依赖 -->
        <div
          class="agm-list-spacer"
          :style="{ height: `${listRows.length * LIST_ROW_H}px` }"
        >
          <button
            v-for="(row, i) in visibleListRows"
            :key="row.id"
            class="agm-list-row"
            :style="{ top: `${(listRangeStart + i) * LIST_ROW_H}px`, height: `${LIST_ROW_H}px` }"
            :title="rowTitle(row)"
            @click.stop="onRowClick(row)"
          >
            <span
              class="agm-list-row-name"
              :title="row.name"
            >{{ row.name }}</span>
            <span
              v-if="row.projectName"
              class="agm-list-row-proj"
            >{{ row.projectName }}</span>
            <span
              v-if="rowBadge(row).n > 0"
              class="agm-list-row-idle"
              :class="{ 'is-stall': rowBadge(row).stall }"
              :title="t(rowBadge(row).tip)"
              @click="onRowBadgeClick(row, $event)"
            >{{ t(rowBadge(row).badge, { n: rowBadge(row).n }) }}</span>
            <span
              v-if="row.running"
              class="agm-item-dot running"
            />
          </button>
        </div>
      </div>
      <n-empty
        v-else
        size="small"
        :description="t('agentTerminal.noSessions')"
        class="agm-list-empty"
      />
      <div class="agm-list-foot">
        <!-- 预览端口直达（P-20261002-70）：agent 上报后列表形态也不缺席 -->
        <button
          v-if="previewPortStore.port !== null"
          class="agm-list-foot-btn"
          :class="{ 'is-detected': previewDetected }"
          :title="previewBtnTitle"
          @pointerdown.stop
          @click.stop="openPreviewPort"
        >
          {{ previewBtnLabel }}
        </button>
        <button
          class="agm-list-foot-btn"
          @click.stop="setMode('docked')"
        >
          {{ t('agentTerminal.dock') }}
        </button>
        <button
          class="agm-list-foot-btn"
          @click.stop="collapseToBall"
        >
          {{ t('agentTerminal.ballShapeBall') }}
        </button>
      </div>
    </template>
  </div>

  <!-- 右键样式菜单 -->
  <NDropdown
    trigger="manual"
    placement="bottom-start"
    :show="styleMenu"
    :x="styleMenuX"
    :y="styleMenuY"
    :options="styleOptions"
    @select="onStyleSelect"
    @clickoutside="styleMenu = false"
  />
</template>

<style scoped>
.agm-root {
  position: fixed;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2500;
  border-radius: 999px;
  border: 1px solid var(--border-default);
  background: var(--bg-panel);
  box-shadow: var(--shadow-soft);
  color: var(--text-primary);
  cursor: grab;
  user-select: none;
  transition: opacity var(--motion-base), box-shadow var(--motion-base);
}
/* 拖拽中半透明：拖动跟随的悬浮体不遮挡落点视野（透明度随既有 opacity transition 过渡） */
.agm-root.is-dragging { opacity: 0.5; }
.agm-root:active { cursor: grabbing; }
.agm-root.is-translucent { opacity: 0.55; }
.agm-root.is-translucent:hover { opacity: 1; }
/* 运行中呼吸环：绿色描边脉动；失败红；失联（P-20261003-303）转警示黄停脉动
 * ——「可能已失联」的弱预警（真终态到达仍可覆盖） */
.agm-root.is-running { border-color: var(--status-running); animation: agm-pulse 1.6s ease-in-out infinite; }
.agm-root.is-failed { border-color: var(--status-failed); animation: none; }
.agm-root.is-stale { border-color: var(--status-waiting); animation: none; }
@keyframes agm-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-running) 45%, transparent); }
  50% { box-shadow: 0 0 0 8px transparent; }
}
/* 悬浮条内部 */
.agm-root.is-bar { justify-content: flex-start; gap: 8px; padding: 0 12px; overflow: hidden; }
.agm-icon { color: var(--text-secondary); flex-shrink: 0; }
.agm-icon.animated { color: var(--status-running); }
.agm-text { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.25; }
.agm-task { font-size: 12px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agm-step-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.agm-step { font-size: 10px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 步骤清单进度 n/m（P-20261004-7）：等宽小字收在步骤行尾，不挤占任务文本 */
.agm-steps-count { flex-shrink: 0; font-size: 10px; color: var(--status-running); font-family: var(--font-mono); }
.agm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--status-running); flex-shrink: 0; }
.agm-dot.failed { background: var(--status-failed); }
.agm-dot.stale { background: var(--status-waiting); }
/* 失联弱预警徽标（P-20261003-303）：条形态内联在状态点后，弱样式不弹窗 */
.agm-stale-badge {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1.4;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--status-waiting);
  border: 1px solid color-mix(in srgb, var(--status-waiting) 55%, transparent);
  background: transparent;
  white-space: nowrap;
}
/* 远程来源徽标（P-20261004-131）：进度归属为对端会话——条形态内联在状态点前
 * （蓝描边弱样式，与失联黄徽标同语言）；球形态绝对定位挂在球右上角 */
.agm-remote-badge {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1.4;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--accent-blue);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 45%, transparent);
  background: transparent;
  white-space: nowrap;
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agm-root.is-ball .agm-remote-badge {
  position: absolute;
  top: -6px;
  right: -10px;
  max-width: 72px;
}
/* 会话数徽标：球右下角小圆 */
.aprv-badge { background: var(--status-waiting); color: var(--on-accent-warm, #1f2328); margin-left: 2px; }
.agm-badge {
  position: absolute;
  right: -2px;
  bottom: -2px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--brand-accent);
  color: var(--text-on-accent);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}
/* 预览端口直达快捷按钮（P-20261002-70）：条形态内联在状态点后；
 * 球形态绝对定位挂在球体正下方（不挤占 40~64px 的圆形本体）。
 * 沉淀到笔记（P-20261003-292）药丸同形复用本组样式 */
.agm-preview-btn,
.agm-deposit-btn {
  flex-shrink: 0;
  margin-left: 6px;
  padding: 2px 8px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
}
.agm-preview-btn:hover,
.agm-deposit-btn:hover {
  color: var(--text-primary);
  border-color: var(--brand-accent);
}
/* 弱化样式（P-20261002-83）：被动探测命中区别于 agent 实报——虚线描边 +
 * 降不透明度，hover 恢复实线强调（可点击性不打折，仅视觉降噪） */
.agm-preview-btn.is-detected,
.agm-list-foot-btn.is-detected {
  border-style: dashed;
  opacity: 0.7;
}
.agm-preview-btn.is-detected:hover,
.agm-list-foot-btn.is-detected:hover {
  border-style: solid;
  opacity: 1;
}
.agm-root.is-ball .agm-preview-btn,
.agm-root.is-ball .agm-deposit-btn {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  margin-left: 0;
}
/* 球形态下预览与沉淀两药丸并存时纵向让位（:has 前向兼容——不支持时两药丸
 * 同位重叠属可接受的降级，两入口互斥出现的常态不受影响） */
.agm-root.is-ball:has(.agm-preview-btn) .agm-deposit-btn {
  top: calc(100% + 34px);
}
</style>
<style scoped>
/* 悬浮列表形态：面板化布局（覆盖球的圆形样式） */
.agm-root.is-list {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  border-radius: 10px;
  padding: 0;
  gap: 0;
  max-height: min(420px, 70vh);
  cursor: default;
}
.agm-list-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-default);
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.agm-list-head:active { cursor: grabbing; }
.agm-list-title { font-size: 12px; font-weight: 600; color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agm-list-count {
  font-size: 10px; color: var(--text-tertiary);
  background: var(--bg-hover); border-radius: 8px; padding: 0 6px; line-height: 15px;
}
.agm-list-btn {
  display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border: none; border-radius: 4px;
  background: transparent; color: var(--text-secondary); cursor: pointer; padding: 0;
}
.agm-list-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.agm-list-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px; }
/* 窗口化渲染：spacer 撑总高，行绝对定位（top 由行号 × 行高内联给出） */
.agm-list-spacer { position: relative; }
.agm-list-empty { padding: 14px 0; }
.agm-list-row {
  position: absolute;
  left: 0;
  right: 0;
  display: flex; align-items: center; gap: 6px;
  padding: 0 8px;
  border: none; border-radius: 5px;
  background: transparent; color: var(--text-body);
  cursor: pointer; text-align: left; font-size: 12px;
}
.agm-list-row:hover { background: var(--bg-hover); }
.agm-list-row-name { flex-shrink: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
.agm-list-row-proj { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-tertiary); font-size: 11px; }
/* 会话静默弱标（P-20261003-53）：灰调小徽标，弱样式不弹窗不打断。
   停滞强标档（P-20261004-37）：警示橙描边升级 + 指针可点开分诊卡（弱标保持
   行跳转语义不拦截） */
.agm-list-row-idle {
  flex-shrink: 0; font-size: 10px; padding: 0 4px; border-radius: 2px;
  background: color-mix(in srgb, var(--text-dim) 12%, transparent); color: var(--text-dim);
  white-space: nowrap;
}
.agm-list-row-idle.is-stall {
  cursor: pointer;
  color: var(--status-waiting);
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--status-waiting) 55%, transparent);
}
.agm-list-row-idle.is-stall:hover { background: color-mix(in srgb, var(--status-waiting) 12%, transparent); }
.agm-item-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--status-running);
}
.agm-item-dot.running { animation: agm-pulse 1.6s ease-in-out infinite; }
.agm-list-foot {
  display: flex; gap: 6px;
  padding: 6px 10px;
  border-top: 1px solid var(--border-default);
  flex-shrink: 0;
}
.agm-list-foot-btn {
  flex: 1;
  padding: 4px 0;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.agm-list-foot-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.spinning { animation: agm-spin 0.8s linear infinite; }
@keyframes agm-spin { to { transform: rotate(360deg); } }
</style>
