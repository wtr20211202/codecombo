<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import TerminalPane from './TerminalPane.vue'
import TerminalFloatChrome from './TerminalFloatChrome.vue'
import { useI18n } from '../../composables/useI18n'
import type { TermTab } from '../../composables/useTerminalTabs'
import type { TerminalFloatApi } from '../../composables/useTerminalFloat'
import type { OscEvent } from '../../composables/useTerminalSession'
import { useAssistantTaskStore } from '../../stores/assistantTask'

/**
 * 终端内容区：v-for 渲染每个 tab 的 pane 布局（单 pane / 水平/垂直分屏）。
 * v-show 由父级通过 display 控制可见性——tab 始终挂载，xterm 实例不销毁。
 * 交互（焦点/右键/分屏/divider）全部经 handlers 对象上抛宿主。
 * 从 TerminalView.vue 抽出（债项拆分）。
 *
 * 独占挂接（P1）：被终端会话管理页接管的会话（suspendedIds）不在此渲染 xterm，
 * 渲染轻占位卡；点击占位 = 取回（onResume），pane 重新挂载并经服务端重放恢复。
 *
 * 浮动窗（拖出 tab）：float API 由宿主注入。浮动 tab 的 .term-tab-content
 * 以 CSS morph（is-floating class）变 fixed 几何——pane DOM 零迁移，xterm
 * 不重初始化；原生 resize 把手的尺寸变化经 ResizeObserver 回写几何并 refit。
 */
const props = defineProps<{
  tabs: TermTab[]
  activeTabId: string
  currentProjectId: string | null
  splitResizing: { first: number; second: number; tabId: string } | null
  scrollbackLines: number
  /** 被管理页接管（挂起）的会话 id 集合：这些 pane 渲染占位卡而非 xterm */
  suspendedIds?: Set<string>
  /** 浮动窗 API（宿主 useTerminalFloat 实例）：缺省 = 无浮动能力 */
  float?: TerminalFloatApi
  /** pane 临时最大化态（P-20261004-64，usePanelLayout 模块单例投影）：
   *  null = 无；否则该 pane v-show 独占、兄弟 pane 隐藏（xterm 保活不断连） */
  paneMaximized?: { tabId: string; paneId: string } | null
  handlers: {
    getTerminalWsUrl: (sessionId: string) => string
    uploadPaste: (file: File, kind: 'image' | 'file') => Promise<string | null>
    onOscEvent: (ev: OscEvent, sessionId: string) => void
    resizeTerminal: (id: string, rows: number, cols: number, silent?: boolean) => void
    /** 显示失步权威重绘（tmux refresh-client，native 服务端 no-op） */
    redrawTerminal: (id: string) => void
    setPaneRef: (paneId: string, el: unknown) => void
    secondaryPaneRefFn: (tab: TermTab) => (el: unknown) => void
    handlePaneClick: (tab: TermTab, paneId: string) => void
    /** 键盘切换 pane（P-20261004-111）：按键 pane 所在 tab 双 pane 互切。返回
     *  是否完成切换（true=键位拦截）；单 pane 返回 false 放行 PTY */
    focusOtherPane: (sessionId: string) => boolean
    /** bufferLine = 右键命中的缓冲行（P-20261004-16「标记此行」），解析失败缺省 */
    openContextMenu: (tabId: string, e: MouseEvent, bufferLine?: number) => void
    splitActiveTab: (direction: 'horizontal' | 'vertical') => void
    closeActivePane: () => void
    switchTabBy: (delta: number) => void
    switchTabTo: (index: number) => void
    startPaneResize: (e: MouseEvent, tab: TermTab) => void
    resetPaneSplit: (tab: TermTab) => void
    onDividerKeydown: (e: KeyboardEvent, tab: TermTab) => void
    /** 取回被接管的会话（占位卡点击） */
    onResume: (paneId: string) => void
    /** refit 指定 pane（浮动几何变化 / 收回面板后调用） */
    fitPane: (paneId: string) => void
    /** 浮动窗收回面板（宿主负责 fit 收尾） */
    onDockBack: (tabId: string) => void
    /** pane 临时最大化 toggle（P-20261004-64）：宿主校验双 pane 后转调
     *  usePanelLayout.toggleTerminalPaneMaximized */
    togglePaneMaximize: (tabId: string, paneId: string) => void
  }
}>()

const { t } = useI18n()
const h = props.handlers

// ============== 浮动窗（CSS morph） ==============
function isFloated(tab: TermTab): boolean {
  return props.float?.isFloating(tab.id) ?? false
}
function floatStyle(tab: TermTab): Record<string, string> | undefined {
  const api = props.float
  const g = api?.floatMap.get(tab.id)
  if (!api || !g) return undefined
  // 层级基座：高于应用面板/悬浮球（2500），高于终端最大化（100，与底部面板
  // 全屏同层）——悬浮终端窗在最大化态下仍可拖动置前
  return {
    left: `${g.x}px`,
    top: `${g.y}px`,
    width: `${g.w}px`,
    height: `${g.h}px`,
    zIndex: String(api.zOf(tab.id) + 3000),
  }
}

// ============== 浮动窗 chrome（P-20261004-91）：状态档 + 活动窗判定 ==============
const taskStore = useAssistantTaskStore()

/** 浮动窗状态档：task.progress（bySession）优先，无进度归属回落 shell 层
 *  tab.running（纯终端会话跑命令也有「进行中」一瞥可知） */
function floatTier(tab: TermTab): 'running' | 'done' | 'failed' | 'idle' {
  const p = taskStore.bySession[tab.id]
  if (p?.status === 'failed') return 'failed'
  if (p?.status === 'done') return 'done'
  if (p?.status === 'running' || tab.running) return 'running'
  return 'idle'
}

/** 多浮动窗中的活动窗（z 序顶层，bringToFront 维护的 zMap 取最大）：
 *  is-top 驱动窗口边框/标题条高亮——点哪扇窗哪扇即活动窗 */
const topFloatId = computed(() => {
  const api = props.float
  if (!api) return ''
  let top = ''
  let topZ = -1
  for (const id of api.floatingIds.value) {
    const z = api.zOf(id)
    if (z > topZ) {
      topZ = z
      top = id
    }
  }
  return top
})

// ============== pane 临时最大化（P-20261004-64） ==============
/** 本 tab 当前最大化的 paneId（状态不属于本 tab 时返回 null） */
function tabMaxPaneId(tab: TermTab): string | null {
  const m = props.paneMaximized
  return m && m.tabId === tab.id ? m.paneId : null
}
/** pane 是否被对侧最大化隐藏（v-show 保活：xterm 实例与 WS 会话零重建） */
function isPaneHidden(tab: TermTab, paneId: string): boolean {
  const max = tabMaxPaneId(tab)
  return max !== null && max !== paneId
}

// ============== 浮动尺寸联动：原生 resize 把手 → 几何回写 + xterm refit ==============
const floatEls = new Map<string, HTMLElement>()
const fitTimers = new Map<string, ReturnType<typeof setTimeout>>()
let floatRO: ResizeObserver | null = null
function ensureFloatRO(): ResizeObserver {
  if (floatRO) return floatRO
  floatRO = new ResizeObserver((entries) => {
    for (const en of entries) {
      const el = en.target as HTMLElement
      const id = el.dataset.tabId
      if (!id) continue
      // CSS resize 把手改的是元素实际尺寸，回写几何保持唯一事实源一致
      props.float?.setGeometry(id, { w: el.offsetWidth, h: el.offsetHeight })
      // 拖把手过程中 RO 高频触发：trailing 防抖后一次性 refit 两 pane
      const prev = fitTimers.get(id)
      if (prev) clearTimeout(prev)
      fitTimers.set(id, setTimeout(() => {
        fitTimers.delete(id)
        h.fitPane(id)
        const tab = props.tabs.find(tb => tb.id === id)
        if (tab?.panes?.[1]) h.fitPane(tab.panes[1])
      }, 80))
    }
  })
  return floatRO
}
function setTabContentEl(tabId: string): (el: unknown) => void {
  return (el) => {
    if (el) {
      const el0 = el as HTMLElement
      floatEls.set(tabId, el0)
      if (props.float?.isFloating(tabId)) ensureFloatRO().observe(el0)
    } else {
      const old = floatEls.get(tabId)
      floatEls.delete(tabId)
      if (old) floatRO?.unobserve(old)
    }
  }
}
// 浮动态在元素不重建的前提下切换（class morph）：watch 集合变化维护 observe 关系
watch(() => props.float?.floatingIds.value, (ids) => {
  if (!props.float) return
  ensureFloatRO()
  for (const [id, el] of floatEls) {
    if (ids?.has(id)) floatRO?.observe(el)
    else floatRO?.unobserve(el)
  }
})
onBeforeUnmount(() => {
  floatRO?.disconnect()
  floatRO = null
  for (const timer of fitTimers.values()) clearTimeout(timer)
  fitTimers.clear()
})
</script>

<template>
  <div
    v-for="tab in tabs"
    v-show="isFloated(tab) || (activeTabId === tab.id && tab.projectId === currentProjectId)"
    :key="tab.id"
    :ref="setTabContentEl(tab.id)"
    class="term-tab-content"
    :class="{ 'is-floating': isFloated(tab), 'is-top': isFloated(tab) && topFloatId === tab.id }"
    :data-tab-id="tab.id"
    :style="floatStyle(tab)"
    @pointerdown.capture="props.float?.bringToFront(tab.id)"
  >
    <!-- 浮动窗轻 chrome（识别/状态/收回三合一，TerminalFloatChrome）：
         常驻 4px 状态条 + hover/键盘聚焦显现的标题条（拖拽移动经 startBarDrag） -->
    <TerminalFloatChrome
      v-if="isFloated(tab)"
      :name="tab.name"
      :tier="floatTier(tab)"
      :top="topFloatId === tab.id"
      @drag-start="(e: PointerEvent) => props.float?.startBarDrag(tab.id, e)"
      @dock="h.onDockBack(tab.id)"
    />
    <!-- 始终用 flex 容器包裹：单 pane 时全宽，split 时按 CSS 变量分宽
         关键：主 pane 始终保留，避免 split 切换时销毁 xterm Terminal 实例
         is-pane-max（P-20261004-64）：pane 临时最大化——可见 pane 占满、
         divider 隐藏（宽高变量不动，还原即回原比例） -->
    <div
      :class="[
        'term-pane-layout',
        tab.panes && tab.panes.length === 2 && tab.paneDirection
          ? [tab.paneDirection, 'split']
          : 'single',
        tabMaxPaneId(tab) !== null ? 'is-pane-max' : '',
      ]"
      :data-tab-id="tab.id"
    >
      <!-- 拖动 divider 时显示当前 split 比例浮层 -->
      <div
        v-if="splitResizing && splitResizing.tabId === tab.id"
        class="term-split-ratio"
      >
        {{ Math.round(splitResizing.first) }}% | {{ Math.round(splitResizing.second) }}%
      </div>
      <!-- 主 pane：被接管时渲染占位卡（独占挂接，不双渲染）。
           v-show 隐藏 = 对侧 pane 临时最大化（保活不断连） -->
      <TerminalPane
        v-if="!props.suspendedIds?.has(tab.id)"
        v-show="!isPaneHidden(tab, tab.id)"
        :ref="(el: unknown) => h.setPaneRef(tab.id, el)"
        :session-id="tab.id"
        :ws-url-factory="h.getTerminalWsUrl"
        :upload-paste="h.uploadPaste"
        :osc-hook="h.onOscEvent"
        :resize-call="h.resizeTerminal"
        :redraw-call="h.redrawTerminal"
        :scrollback-lines="scrollbackLines"
        :active="!tab.panes || tab.panes.length < 2 || tab.activePaneId === tab.id"
        :maximizable="!!tab.panes && tab.panes.length === 2"
        :maximized="tabMaxPaneId(tab) === tab.id"
        :focus-other-pane="h.focusOtherPane"
        @activate="h.handlePaneClick(tab, tab.id)"
        @contextmenu="(e: MouseEvent, line?: number) => h.openContextMenu(tab.id, e, line)"
        @split-horizontal="h.splitActiveTab('horizontal')"
        @split-vertical="h.splitActiveTab('vertical')"
        @close-pane="h.closeActivePane()"
        @toggle-maximize="h.togglePaneMaximize(tab.id, tab.id)"
        @switch-tab="h.switchTabBy"
        @switch-to-tab="h.switchTabTo"
      />
      <button
        v-else
        class="term-pane-suspended"
        :title="t('agentTerminal.suspendedTip')"
        @click="h.onResume(tab.id)"
      >
        <span class="term-pane-suspended-icon">⇄</span>
        <span class="term-pane-suspended-name">{{ tab.name }}</span>
        <span class="term-pane-suspended-hint">{{ t('agentTerminal.suspendedCard') }}</span>
        <span class="term-pane-suspended-action">{{ t('agentTerminal.resumeToPanel') }}</span>
      </button>
      <template v-if="tab.panes && tab.panes.length === 2 && tab.paneDirection">
        <div
          v-show="tabMaxPaneId(tab) === null"
          class="term-split-divider"
          :class="`term-split-divider-${tab.paneDirection}`"
          tabindex="0"
          role="separator"
          :aria-label="t('terminal.splitDivider')"
          @mousedown="(e: MouseEvent) => h.startPaneResize(e, tab)"
          @dblclick="h.resetPaneSplit(tab)"
          @keydown="(e: KeyboardEvent) => h.onDividerKeydown(e, tab)"
        />
        <TerminalPane
          v-if="!props.suspendedIds?.has(tab.panes![1]!)"
          v-show="!isPaneHidden(tab, tab.panes![1]!)"
          :ref="h.secondaryPaneRefFn(tab)"
          :session-id="tab.panes![1]!"
          :ws-url-factory="h.getTerminalWsUrl"
          :upload-paste="h.uploadPaste"
          :osc-hook="h.onOscEvent"
          :resize-call="h.resizeTerminal"
          :redraw-call="h.redrawTerminal"
          :scrollback-lines="scrollbackLines"
          :active="tab.activePaneId === tab.panes![1]"
          :maximizable="true"
          :maximized="tabMaxPaneId(tab) === tab.panes![1]"
          :focus-other-pane="h.focusOtherPane"
          @activate="h.handlePaneClick(tab, tab.panes![1]!)"
          @contextmenu="(e: MouseEvent, line?: number) => h.openContextMenu(tab.panes![1]!, e, line)"
          @split-horizontal="h.splitActiveTab('horizontal')"
          @split-vertical="h.splitActiveTab('vertical')"
          @close-pane="h.closeActivePane()"
          @toggle-maximize="h.togglePaneMaximize(tab.id, tab.panes![1]!)"
          @switch-tab="h.switchTabBy"
          @switch-to-tab="h.switchTabTo"
        />
        <button
          v-else
          class="term-pane-suspended"
          :title="t('agentTerminal.suspendedTip')"
          @click="h.onResume(tab.panes![1]!)"
        >
          <span class="term-pane-suspended-icon">⇄</span>
          <span class="term-pane-suspended-hint">{{ t('agentTerminal.suspendedCard') }}</span>
          <span class="term-pane-suspended-action">{{ t('agentTerminal.resumeToPanel') }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* .term-tab-content 始终 absolute fill 父级；
   内部 .term-pane-layout 用 flex，单 / split 共用结构 */
.term-tab-content {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  /* 三层背景：tabbar(--bg-panel) → 内容区(--bg-surface) → xterm(colors.background) */
  background: var(--bg-surface);
}
.term-pane-layout {
  display: flex;
  width: 100%;
  height: 100%;
  /* 由 divider 拖拽动态覆盖（split 模式） */
  --term-split-first: 50%;
  --term-split-second: 50%;
}
.term-pane-layout.horizontal {
  flex-direction: row;
}
.term-pane-layout.vertical {
  flex-direction: column;
}
.term-pane-layout.single {
  /* 单 pane 无需特殊处理，子项 flex:1 自动 fill */
}
/* ============== 浮动窗（CSS morph）：absolute 100% → fixed 几何 ==============
   pane DOM 零迁移；resize: both 给出原生缩放把手（overflow 必须非 visible）。
   几何数值（left/top/width/height/zIndex）由 floatStyle 内联注入 */
.term-tab-content.is-floating {
  position: fixed;
  display: flex;
  flex-direction: column;
  resize: both;
  overflow: hidden;
  min-width: 380px;
  min-height: 240px;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  background: var(--bg-surface);
  box-shadow: var(--shadow-pop-xl);
}
/* 活动浮动窗（多窗 z 序顶层，P-20261004-91）：边框走焦点色混合高亮——
   收起态标题条不可见时仍可辨「点哪扇窗哪扇收输入」；标题条内高亮在
   TerminalFloatChrome（is-top 下发） */
.term-tab-content.is-floating.is-top {
  border-color: color-mix(in srgb, var(--accent-blue) 55%, var(--border-default));
}
/* 浮动内部：chrome（状态条+标题条）占顶部，pane 布局吃剩余高度（覆盖 height:100%） */
.term-tab-content.is-floating .term-pane-layout {
  height: auto;
  flex: 1 1 0;
  min-height: 0;
}
/* 单 pane 模式 */
.term-pane-layout.single .term-pane {
  flex: 1 1 auto;
}
/* split 模式：两 pane 按 CSS 变量分宽 */
.term-pane-layout.horizontal.split .term-pane:first-child,
.term-pane-layout.vertical.split .term-pane:first-child {
  flex: 0 0 var(--term-split-first);
}
.term-pane-layout.horizontal.split .term-pane:last-of-type,
.term-pane-layout.vertical.split .term-pane:last-of-type {
  flex: 0 0 var(--term-split-second);
}
/* pane 临时最大化（P-20261004-64）：可见 pane 占满。兄弟 pane v-show 隐藏
 * （display:none 不占格），但定宽 flex-basis 仍会留白——同特异性后置覆盖
 * 把 basis 抬满（--term-split-* 变量不动，还原即回原比例）；隐藏侧命中同
 * 规则无视觉影响。xterm 尺寸变化由宿主布局态 watch 统一 refit 自愈 */
.term-pane-layout.is-pane-max.split .term-pane:first-child,
.term-pane-layout.is-pane-max.split .term-pane:last-of-type {
  flex: 1 1 100%;
}

/* 通用 pane 容器（兼容旧 .term-container 类名）。
   注：pane 根元素由 TerminalPane 渲染，父级 scoped 样式可作用于子组件根节点；
   内部元素（搜索条/浮层/xterm）样式在 components/terminal/terminal-pane.css */
.term-container,
.term-pane {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 4px 8px 4px 4px;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  /* 凹陷感：内阴影模拟屏幕"陷入"面板（与 vignette/ambient 多重 shadow 叠加） */
  box-shadow:
    inset 0 0 0 1px var(--bg-border),
    inset 0 1px 3px rgba(0, 0, 0, 0.35);
  transition: opacity var(--motion-base) ease, box-shadow var(--motion-base) ease;
}

/* inactive pane 透明度 0.92（split 模式下焦点对比更明显） */
.term-pane:not(.is-active-pane) {
  opacity: 0.92;
}

/* 活跃 pane outline + 微弱蓝色 glow（叠加凹陷 shadow） */
/* 单 pane 模式：仅凹陷感，不加 outline/glow（避免明亮蓝色边框） */
.term-pane.is-active-pane {
  box-shadow:
    inset 0 0 0 1px var(--bg-border),
    inset 0 1px 3px rgba(0, 0, 0, 0.35);
}
/* split 模式下才显示 outline + glow 区分 active pane */
.term-pane-layout.split .term-pane.is-active-pane {
  outline: 1px solid var(--accent-blue);
  outline-offset: -1px;
  box-shadow:
    inset 0 0 0 1px var(--bg-border),
    inset 0 1px 3px rgba(0, 0, 0, 0.35),
    /* 辉光跟随主题焦点色（原写死 dark 主题蓝 rgba(88,166,255)，浅色主题下突兀） */
    0 0 12px color-mix(in srgb, var(--focus-ring) 18%, transparent);
}

/* Split divider（可拖拽调整 pane 比例） */
.term-split-divider {
  background: var(--border-default);
  flex-shrink: 0;
  transition: background var(--motion-base);
  position: relative;
}
.term-split-divider:hover {
  background: var(--brand-accent);
}
/* divider handle：中心常显拖拽点（可发现性），hover 加强 */
.term-split-divider::after {
  content: '';
  position: absolute;
  background: var(--text-dim);
  opacity: 0.45;
  transition: opacity var(--motion-base);
  border-radius: 1px;
}
.term-split-divider:hover::after {
  opacity: 0.95;
}
.term-split-divider-horizontal::after {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 16px;
}
.term-split-divider-vertical::after {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 16px;
  height: 2px;
}
.term-split-divider-horizontal {
  width: 6px;
  cursor: col-resize;
}
.term-split-divider-vertical {
  height: 6px;
  cursor: row-resize;
}
/* divider 键盘焦点反馈 */
.term-split-divider:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: -1px;
}

/* 拖动比例浮层：拖动 divider 时显示当前比例 */
.term-split-ratio {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-panel);
  color: var(--text-body);
  border: 1px solid var(--accent-blue);
  border-radius: 4px;
  padding: 3px 10px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  z-index: 10;
  pointer-events: none;
  box-shadow: var(--shadow-pop-sm);
}

/* 挂起占位卡：会话被终端会话管理页接管时替代 xterm（点击 = 取回） */
.term-pane-suspended {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  min-width: 0;
}
.term-pane-suspended:hover { background: var(--bg-hover); }
.term-pane-suspended-icon { font-size: 28px; color: var(--brand-accent); line-height: 1; }
.term-pane-suspended-name { font-size: 13px; font-weight: 600; color: var(--text-primary); max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.term-pane-suspended-hint { font-size: 12px; }
.term-pane-suspended-action {
  margin-top: 4px;
  padding: 3px 12px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-primary);
}
.term-pane-suspended:hover .term-pane-suspended-action { border-color: var(--accent-blue); color: var(--accent-blue); }
</style>
