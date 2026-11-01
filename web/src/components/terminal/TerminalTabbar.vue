<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NDropdown, NIcon } from 'naive-ui'
import { AddOutline, ChevronDownOutline, GridOutline, TimeOutline, BookmarkOutline, LocateOutline, ListOutline, RadioOutline, PinOutline, LockClosedOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useLayoutLockStore } from '../../stores/layoutLock'
import BrandIcon from '../common/BrandIcon.vue'
import type { TermTab } from '../../composables/useTerminalTabs'
import SessionOverview from './SessionOverview.vue'

/**
 * 终端标签栏 + 工具栏（从 TerminalView.vue 抽出的纯 UI 块，债项拆分）：
 * - tab 卡片（序号徽章/状态点/重命名/关闭/右键菜单入口/拖出浮动窗手势）
 * - 工具栏（新建/字号/分屏/历史/片段/会话总览/更多下拉/backend chip）
 * - 会话总览浮层（锚定本栏，position: relative）
 * 业务动作全部上抛，本组件无终端编排逻辑。
 */
const props = defineProps<{
  tabs: TermTab[]
  activeTabId: string
  renamingTabId: string
  renameValue: string
  fontSize: number
  fontRolling: boolean
  hasProject: boolean
  showHistoryPanel: boolean
  showClaudePanel?: boolean
  showSnippetPanel: boolean
  showRunbookPanel?: boolean
  showSessionOverview: boolean
  sessionGroups: import('../../utils/sessionOverview').SessionGroup[]
  sessionSummary: { total: number; failed: number; running: number }
  effectiveBackend: 'tmux' | 'native'
  /** 「更多」下拉选项（标签含动态态：最大化/还原），动作上抛宿主 */
  moreOptions: Array<Record<string, unknown>>
  /** 被终端会话管理页接管的会话 id：tab 呈挂起态（视觉降级 + 取回提示） */
  suspendedIds?: Set<string>
  /** 浮动窗中的 tab id 集合：tab 卡片显示浮动指示 */
  floatingIds?: Set<string>
  /** tabId → 会话 dir 的项目相对路径（正斜杠；'' = 项目根本身）：
   *  tab tooltip 展示 + 「在文件树中定位」按钮数据源（P-20261001-32） */
  dirByTabId?: Record<string, string>
  /** 活动 tab 的会话 dir（undefined = 会话未知或 dir 在项目外：按钮置灰） */
  activeDir?: string
  /** 广播选择模式（P-20261003-288）：开 = tab 点击语义由宿主切换为选中/取消 */
  broadcastMode?: boolean
  /** 广播模式下的已选中 tab id 集（tab 卡片视觉高亮） */
  broadcastSelectedIds?: Set<string>
  /** 有未读新输出的 tab id 集（P-20261003-310，store.unreadMap 投影）：
   *  tab 名字前小圆点，激活即清（清账语义在宿主可见登记） */
  unreadIds?: Set<string>
  /** 已置顶 tab id 集（P-20261004-53，store.pinnedIds 直传）：tab 置顶分组
   *  已由宿主的显示序投影保证（pinned 在前），这里只承载置顶视觉（粗体+图钉） */
  pinnedIds?: Set<string>
  /** 所属项目已落锁的 tab id 集（P-20261004-143，宿主投影）：tab 名字前小锁
   *  徽标（首页锁徽标同款 accent-orange 中性色）——API 写族已 403，但本终端
   *  shell 命令不经 API 守卫照常可执行，诚实边界提示（不阻断不杀会话） */
  lockedIds?: Set<string>
  /** 直播中 tab 的会话 id → 徽标 title（P-20261005-161，宿主投影自
   *  useTerminalLiveShares + 30s now tick）：tab 名字前红点呼吸徽标（访客页
   *  「直播中」同视觉语），title 携剩余时长与累计观看数 */
  liveTitles?: Record<string, string>
}>()

/** tab tooltip：挂起态提示优先；否则展示会话 dir（项目根显示「项目根」，
 *  相对路径统一正斜杠）——终端 cwd 只在服务端，tooltip 是它的可见出口 */
function tabTitle(tab: TermTab): string | undefined {
  if (props.suspendedIds?.has(tab.id)) return t('agentTerminal.suspendedTip')
  const dir = props.dirByTabId?.[tab.id]
  if (dir === undefined) return undefined
  return t('terminal.locate.tabTip', { dir: dir === '' ? t('terminal.locate.dirProjectRoot') : dir })
}

/** 目录级会话徽标短标（P-20261005-192）：非根目录会话取目录尾段（root/sub/dir
 *  → dir）与根会话一眼区分；''（项目根本身）不出徽标。dirByTabId 已归一为项目
 *  相对正斜杠路径——取尾段天然避开 Windows 盘符形态，三平台一致；悬停全路径
 *  见 tabTitle（整 tab）与徽标自身 title */
function dirBadge(tab: TermTab): string {
  const dir = props.dirByTabId?.[tab.id]
  if (!dir) return ''
  return dir.split('/').filter(Boolean).pop() || ''
}

/** 定位按钮 tooltip：可定位时带目标 dir；置灰时说明原因 */
const locateTitle = computed(() => {
  const dir = props.activeDir
  if (dir === undefined) return t('terminal.locate.outsideProject')
  return dir === '' ? t('terminal.locate.inTree') : t('terminal.locate.inTreeDir', { dir })
})

// tab 条空白区双击 → 快捷新建会话（P-20261004-65）：对标浏览器/VS Code
// 「双击 tab 栏空白开新 tab」肌肉记忆，复用工具栏 + 按钮同一条 create 动作链。
// 双击落在 tab 本体时让位既有语义（名字区 dblclick = 重命名，且未 .stop 会
// 冒泡到本容器，必须 closest 排除防一石二鸟）；dblclick 与 tab 拖拽/滚轮横滚
// 是独立指针事件通道互不扰；窄屏 tab 条无空白区时双击无处落点 = 天然降级
function onTablistDblclick(e: MouseEvent) {
  const tgt = e.target as HTMLElement | null
  if (tgt?.closest('.term-tab')) return
  // 名字区双击 = 重命名的冒泡场景有个孤儿 target 陷阱：span 的 @dblclick
  // （startRename→renamingTabId 翻转 v-if）在 listener 执行后的 microtask
  // checkpoint 里被同步 patch 卸载，事件沿派发时固化的 composedPath 继续冒泡
  // 到本容器时 e.target 已是 detached 节点——closest('.term-tab') 返回 null，
  // 重命名双击被误判成空白区双击而多建一个会话（terminal-tabbar-blank-dblclick
  // :131 回归，实测 detached span inDoc=false）。落点几何兜底：双击点仍落在
  // 任一 tab 卡面内则让位既有语义，绝不新建
  const { clientX, clientY } = e
  for (const el of tablistRef.value?.querySelectorAll('.term-tab') ?? []) {
    const r = el.getBoundingClientRect()
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return
  }
  emit('create')
}

/** 中键关闭终端标签（浏览器/VS Code 标签惯例） */
function onTabAux(e: MouseEvent, id: string) {
  if (e.button !== 1) return
  e.preventDefault()
  emit('requestClose', id)
}

const emit = defineEmits<{
  (e: 'update:renameValue', v: string): void
  (e: 'clearRename'): void
  (e: 'selectTab', id: string): void
  (e: 'requestClose', id: string): void
  (e: 'startRename', tab: TermTab): void
  (e: 'finishRename', tab: TermTab): void
  (e: 'tabContext', ev: MouseEvent, tab: TermTab): void
  (e: 'tabDragStart', tab: TermTab, ev: DragEvent): void
  (e: 'tabDragEnd', tab: TermTab, ev: DragEvent, outsideStrip: boolean): void
  (e: 'tabDrop', dragId: string, targetId: string): void
  (e: 'tabFilePathDrop', tabId: string, path: string): void
  (e: 'locateInTree'): void
  (e: 'create'): void
  (e: 'changeFont', delta: number): void
  (e: 'split', direction: 'horizontal' | 'vertical'): void
  (e: 'toggleHistory'): void
  (e: 'toggleClaude'): void
  (e: 'toggleSnippet'): void
  (e: 'toggleRunbook'): void
  (e: 'toggleOverview'): void
  (e: 'more', action: string): void
  (e: 'jump', tabId: string, projectId: string): void
  (e: 'closeOverview'): void
  (e: 'toggleBroadcast'): void
}>()

const { t } = useI18n()

const fontSizeOptions = [
  { label: t('terminal.increaseFont'), key: 'up' },
  { label: t('terminal.decreaseFont'), key: 'down' },
]
// split 菜单：splitTab 自带 toggle 语义（同方向再点 = 取消拆分）——选项标签
// 按活动 tab 的当前拆分方向动态变化，让「可取消」可被发现
const splitOptions = computed(() => {
  const active = props.tabs.find(tb => tb.id === props.activeTabId)
  return [
    {
      label: active?.paneDirection === 'horizontal' ? t('terminal.cancelSplit') : t('terminal.splitHorizontal'),
      key: 'horizontal',
    },
    {
      label: active?.paneDirection === 'vertical' ? t('terminal.cancelSplit') : t('terminal.splitVertical'),
      key: 'vertical',
    },
  ]
})

// ============== tab 拖拽双语义：条内松手 = 重排序 / 条外松手 = 拖出浮动 ==============
const tablistRef = ref<HTMLElement | null>(null)
// 本组件发起的 tab 拖拽进行中（仅 tab→tab 重排指示用；外部文件拖拽不触发）
const tabDragActive = ref(false)
const tabDragId = ref('')
const reorderOverId = ref('')
// drop 是否已被重排序消费：不能依赖 dataTransfer.dropEffect（headless/合成
// 事件里该赋值不生效），dragend 据此跳过浮动判定
let dropConsumed = false

function isOutsideStrip(e: DragEvent): boolean {
  const el = tablistRef.value
  if (!el) return true
  const r = el.getBoundingClientRect()
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
}
function onTabDragStart(tab: TermTab, e: DragEvent): void {
  // 布局锁定（P-20261003-180）：tab 重排/拖出浮动窗手势统一短路（拖拽不启动），
  // 点击/键盘切签不受影响
  if (useLayoutLockStore().interceptDrag(e)) return
  tabDragActive.value = true
  tabDragId.value = tab.id
  dropConsumed = false
  emit('tabDragStart', tab, e)
}
function onTabDragOver(tab: TermTab, e: DragEvent): void {
  // 文件树路径拖入 tab = 路由粘贴目标（非 tab 重排，不要求 tabDragActive）
  if (Array.from(e.dataTransfer?.types || []).includes('application/x-sc-file-path')) {
    reorderOverId.value = tab.id
    return
  }
  if (!tabDragActive.value || tab.id === tabDragId.value) return
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  reorderOverId.value = tab.id
}
function onTabDragLeave(tab: TermTab): void {
  if (reorderOverId.value === tab.id) reorderOverId.value = ''
}
function onTabDrop(tab: TermTab, e: DragEvent): void {
  // 文件树路径拖入：交给宿主粘贴到该 tab 的终端
  const path = e.dataTransfer?.getData('application/x-sc-file-path') || ''
  if (path) {
    emit('tabFilePathDrop', tab.id, path)
    reorderOverId.value = ''
    return
  }
  if (tabDragActive.value && tab.id !== tabDragId.value) {
    emit('tabDrop', tabDragId.value, tab.id)
    dropConsumed = true
  }
  reorderOverId.value = ''
}
function onTabDragEnd(tab: TermTab, e: DragEvent): void {
  tabDragActive.value = false
  tabDragId.value = ''
  reorderOverId.value = ''
  // 被 drop 消费的拖拽视同「落在条内」——跳过拖出浮动
  emit('tabDragEnd', tab, e, isOutsideStrip(e) && !dropConsumed)
  dropConsumed = false
}

// ============== tab 溢出快速选择下拉（P-20261002-112，复刻 EditorGroupPane 模式）==============
// 多会话 tab 挤压溢出（scrollWidth 差 >4）时尾部显示 chevron，下拉列出全部
// 会话 tab（当前项高亮）点击直达激活——横向滚动找 tab 变下拉直达
const isTabOverflow = ref(false)

function checkTabOverflow() {
  const el = tablistRef.value
  if (!el) return
  isTabOverflow.value = el.scrollWidth - el.clientWidth > 4
}

const tabOverflowOptions = computed(() =>
  props.tabs.map(tab => ({
    label: tab.name,
    key: tab.id,
    props: {
      style: tab.id === props.activeTabId
        ? { color: 'var(--accent-blue)', fontWeight: 600 }
        : undefined,
    },
  })),
)

function onTabOverflowSelect(id: string) {
  emit('selectTab', id)
  nextTick(() => {
    const el = tablistRef.value
    if (!el) return
    const idx = props.tabs.findIndex(tb => tb.id === id)
    const target = (idx >= 0 ? el.children[idx] : undefined) as HTMLElement | undefined
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

let tabOverflowObserver: ResizeObserver | null = null
onMounted(() => {
  nextTick(() => {
    if (!tablistRef.value) return
    tabOverflowObserver = new ResizeObserver(() => checkTabOverflow())
    tabOverflowObserver.observe(tablistRef.value)
    checkTabOverflow()
  })
})
onBeforeUnmount(() => {
  tabOverflowObserver?.disconnect()
  tabOverflowObserver = null
})
// tab 增删/重命名改内容宽度但容器盒尺寸不变（ResizeObserver 盲区）：签名 watch 兜底重测
watch(() => props.tabs.map(tb => `${tb.id}:${tb.name}|`).join(''), () => {
  nextTick(checkTabOverflow)
})

</script>

<template>
  <div class="term-tabbar">
    <div
      ref="tablistRef"
      class="term-tablist"
      @dblclick="onTablistDblclick"
    >
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="term-tab"
        tabindex="0"
        role="tab"
        :aria-selected="activeTabId === tab.id"
        :draggable="renamingTabId !== tab.id"
        :class="{
          'is-active': activeTabId === tab.id,
          'is-running': !!tab.running,
          'is-failed': !tab.running && typeof tab.lastExitCode === 'number' && tab.lastExitCode !== 0,
          'is-suspended': !!props.suspendedIds?.has(tab.id),
          'is-floating': !!props.floatingIds?.has(tab.id),
          'is-pinned': !!props.pinnedIds?.has(tab.id),
          'is-reorder-target': reorderOverId === tab.id,
          'is-broadcast-selected': !!props.broadcastSelectedIds?.has(tab.id),
        }"
        :title="tabTitle(tab)"
        @click="emit('selectTab', tab.id)"
        @auxclick="onTabAux($event, tab.id)"
        @keydown.enter="emit('selectTab', tab.id)"
        @contextmenu="emit('tabContext', $event, tab)"
        @dragstart="onTabDragStart(tab, $event)"
        @dragover.prevent="onTabDragOver(tab, $event)"
        @dragleave="onTabDragLeave(tab)"
        @drop.prevent="onTabDrop(tab, $event)"
        @dragend="onTabDragEnd(tab, $event)"
      >
        <!-- 重命名模式 -->
        <template v-if="renamingTabId === tab.id">
          <input
            :value="renameValue"
            class="term-rename-input"
            autofocus
            @input="emit('update:renameValue', ($event.target as HTMLInputElement).value)"
            @blur="emit('finishRename', tab)"
            @keyup.enter="emit('finishRename', tab)"
            @keyup.escape="emit('clearRename')"
          >
        </template>
        <template v-else>
          <!-- 序号徽章：tab 索引（01/02/03，等宽 + leading zero） -->
          <span class="term-tab-index">{{ String(tabs.indexOf(tab) + 1).padStart(2, '0') }}</span>
          <!-- 状态点：running 进行中蓝 pulse（P-20261003-285 语义色统一，原黄）/ 失败红色 / 否则不显示 -->
          <span
            v-if="tab.running || (typeof tab.lastExitCode === 'number' && tab.lastExitCode !== 0)"
            class="term-tab-status"
            :title="tab.running ? t('terminal.statusRunning') : t('terminal.statusFailed', { code: tab.lastExitCode })"
          />
          <!-- 浮动指示：tab 已拖出为浮动窗 -->
          <span
            v-if="props.floatingIds?.has(tab.id)"
            class="term-tab-float-ico"
            :title="t('terminal.floatOut')"
          >⧉</span>
          <!-- 未读活动点（P-20261003-310）：后台 tab 有新输出。语义色两档——
               最后命令失败=警示红、其余=进行中蓝；激活即清，名字保持常规
               字重（点即信号，不做粗体名的聊天红点语义） -->
          <span
            v-if="props.unreadIds?.has(tab.id)"
            class="term-tab-unread"
            :class="{ 'is-warning': !tab.running && typeof tab.lastExitCode === 'number' && tab.lastExitCode !== 0 }"
            :title="t('terminal.tabUnread')"
            data-testid="term-tab-unread"
          />
          <!-- 置顶指示（P-20261004-53）：图钉标在名字前（编辑器 pinned tab 同位），
               粗体态由 .is-pinned 承载 -->
          <span
            v-if="props.pinnedIds?.has(tab.id)"
            class="term-tab-pin"
            :title="t('terminal.unpinTab')"
            data-testid="term-tab-pin"
          >
            <n-icon size="10"><PinOutline /></n-icon>
          </span>
          <!-- 项目硬锁徽标（P-20261004-143）：所属项目落锁的存量终端——API 写族
               已 403，但本终端 shell 命令不经 API 守卫照常可执行（诚实边界提示，
               不阻断不杀会话；解锁广播即摘，双向） -->
          <span
            v-if="props.lockedIds?.has(tab.id)"
            class="term-tab-lock"
            :title="t('project.locked.terminalBadgeTitle')"
            data-testid="term-tab-lock"
          >
            <n-icon size="10"><LockClosedOutline /></n-icon>
          </span>
          <!-- 直播中徽标（P-20261005-161）：会话有活跃 kind=terminal 分享锚定
               即亮红点（呼吸态同访客页「直播中」视觉语）；隐私边界可见性——
               「忘了直播在跑」在 tab 常驻位可见，title 携剩余时长/观看数 -->
          <span
            v-if="props.liveTitles?.[tab.id]"
            class="term-tab-live"
            :title="props.liveTitles[tab.id]"
            data-testid="term-tab-live"
          />
          <span
            class="term-tab-name"
            @dblclick="emit('startRename', tab)"
          >{{ tab.name }}</span>
          <!-- 目录徽标（P-20261005-192）：非根目录会话的尾部目录短标，与根会话
               一眼区分；title = 完整相对目录（悬停全路径），data-testid 供 e2e -->
          <span
            v-if="dirBadge(tab)"
            class="term-tab-dir"
            :title="props.dirByTabId?.[tab.id]"
            data-testid="term-tab-dir"
          >{{ dirBadge(tab) }}</span>
          <button
            class="term-close-btn"
            :title="t('terminal.closeTab')"
            @click.stop="emit('requestClose', tab.id)"
          >
            &times;
          </button>
        </template>
      </div>
    </div>

    <!-- tab 溢出快速选择（P-20261002-112）：下拉列出全部会话 tab，点击直达激活 -->
    <n-dropdown
      v-if="isTabOverflow"
      trigger="click"
      :options="tabOverflowOptions"
      placement="bottom-end"
      @select="onTabOverflowSelect"
    >
      <button
        class="term-tabs-overflow-btn"
        :title="t('terminal.showAllTabs')"
        :aria-label="t('terminal.showAllTabs')"
      >
        <n-icon size="13">
          <ChevronDownOutline />
        </n-icon>
      </button>
    </n-dropdown>

    <!-- 工具按钮：按价值密度排序，新建 > 字体 > split > 操作 > 后端 -->
    <div class="term-toolbar">
      <!-- 新建（高频，前置） -->
      <n-button
        size="tiny"
        type="primary"
        :title="t('terminal.newTerminal')"
        :aria-label="t('terminal.newTerminal')"
        @click="emit('create')"
      >
        <template #icon>
          <n-icon><AddOutline /></n-icon>
        </template>
      </n-button>

      <div class="term-toolbar-sep" />

      <!-- 字号（合一）：单击展开 A-/A+，当前值在按钮上直接可见 -->
      <n-dropdown
        trigger="click"
        :options="fontSizeOptions"
        @select="(v: string) => emit('changeFont', v === 'up' ? 1 : -1)"
      >
        <button
          class="term-font-btn"
          :title="t('terminal.fontSize')"
          :aria-label="t('terminal.fontSize')"
        >
          A<span
            class="term-font-value"
            :class="{ 'is-rolling': fontRolling }"
          >{{ fontSize }}</span>
        </button>
      </n-dropdown>

      <div class="term-toolbar-sep" />

      <!-- split（合一）：横向 / 纵向二选一 -->
      <n-dropdown
        trigger="click"
        :options="splitOptions"
        @select="(v: string) => emit('split', v as 'horizontal' | 'vertical')"
      >
        <button
          class="term-tool-btn"
          :title="t('terminal.splitHorizontal')"
          :aria-label="t('terminal.splitHorizontal')"
          :disabled="!activeTabId"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          >
            <rect
              x="1.5"
              y="1.5"
              width="5.5"
              height="13"
            />
            <rect
              x="9"
              y="1.5"
              width="5.5"
              height="13"
            />
          </svg>
        </button>
      </n-dropdown>

      <div class="term-toolbar-sep" />

      <!-- 在文件树中定位：活动会话当前 dir（OSC 7 实时追踪，无帧回落创建
           目录）一键在文件树展开定位，文件面板未开时由接收方先开面板（P-20261001-32） -->
      <button
        class="term-tool-btn"
        data-testid="terminal-locate-in-tree"
        :title="locateTitle"
        :aria-label="locateTitle"
        :disabled="activeDir === undefined"
        @click="emit('locateInTree')"
      >
        <n-icon size="13">
          <LocateOutline />
        </n-icon>
      </button>

      <div class="term-toolbar-sep" />

      <!-- 效率区：命令历史 / 命令片段 / Claude 会话 -->
      <div class="term-toolbar-group">
        <button
          class="term-tool-btn"
          :class="{ 'is-active': showHistoryPanel }"
          :title="`${t('terminal.history.title')} (Ctrl+Shift+H)`"
          :aria-label="t('terminal.history.title')"
          :disabled="!hasProject"
          @click="emit('toggleHistory')"
        >
          <n-icon size="13">
            <TimeOutline />
          </n-icon>
        </button>
        <button
          class="term-tool-btn"
          :class="{ 'is-active': showClaudePanel }"
          :title="t('claudeSessions.title')"
          :aria-label="t('claudeSessions.title')"
          :disabled="!hasProject"
          @click="emit('toggleClaude')"
        >
          <BrandIcon
            name="claude"
            :size="13"
          />
        </button>
        <button
          class="term-tool-btn"
          :class="{ 'is-active': showSnippetPanel }"
          :title="t('terminal.snippet.title')"
          :aria-label="t('terminal.snippet.title')"
          @click="emit('toggleSnippet')"
        >
          <n-icon size="13">
            <BookmarkOutline />
          </n-icon>
        </button>
        <!-- 运行书（P-20261003-24）：多步序列逐步发送，全局域不绑项目（同片段不置灰） -->
        <button
          class="term-tool-btn"
          :class="{ 'is-active': showRunbookPanel }"
          :title="t('runbook.title')"
          :aria-label="t('runbook.title')"
          @click="emit('toggleRunbook')"
        >
          <n-icon size="13">
            <ListOutline />
          </n-icon>
        </button>
        <!-- 广播模式（P-20261003-288 舰队式批量输入）：多选 tab 一次发全部 -->
        <button
          class="term-tool-btn"
          :class="{ 'is-active': broadcastMode }"
          :title="t('terminal.broadcast.mode')"
          :aria-label="t('terminal.broadcast.mode')"
          :aria-pressed="broadcastMode"
          data-testid="terminal-broadcast-toggle"
          @click="emit('toggleBroadcast')"
        >
          <n-icon size="13">
            <RadioOutline />
          </n-icon>
        </button>
      </div>

      <!-- 会话总览：跨项目会话进度一览 + 快捷切换（多项目并行开发） -->
      <div class="term-toolbar-group">
        <button
          class="term-tool-btn"
          :class="{ 'is-accent': sessionSummary.failed > 0 }"
          :title="t('terminal.overview.buttonTitle')"
          :aria-label="t('terminal.overview.buttonTitle')"
          @click="emit('toggleOverview')"
        >
          <n-icon size="13">
            <GridOutline />
          </n-icon>
          <span
            v-if="sessionSummary.total"
            class="term-overview-badge"
            :class="{ 'has-failed': sessionSummary.failed > 0 }"
          >{{ sessionSummary.total }}</span>
        </button>
      </div>

      <!-- 「更多」下拉：清屏/刷新/重启/复制/导出/最大化（工具栏收敛至 8 按钮） -->
      <n-dropdown
        trigger="click"
        :options="moreOptions"
        @select="(v: string) => emit('more', v)"
      >
        <button
          class="term-tool-btn"
          :title="t('terminal.more')"
          :aria-label="t('terminal.more')"
          :disabled="!activeTabId"
        >
          <n-icon size="13">
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="currentColor"
            ><circle
              cx="3"
              cy="8"
              r="1.4"
            /><circle
              cx="8"
              cy="8"
              r="1.4"
            /><circle
              cx="13"
              cy="8"
              r="1.4"
            /></svg>
          </n-icon>
        </button>
      </n-dropdown>

      <!-- backend chip：显示当前生效的终端后端 -->
      <span
        class="term-backend-chip"
        :title="effectiveBackend === 'tmux' ? t('terminal.tmuxScrollTip') : t('terminal.backendNative')"
      >{{ effectiveBackend === 'tmux' ? 'tmux' : t('terminal.backendNativeShort') }}</span>

      <!-- 会话总览浮层：锚定 term-tabbar（position: relative），点击外部关闭 -->
      <SessionOverview
        v-if="showSessionOverview"
        :groups="sessionGroups"
        :summary="sessionSummary"
        @jump="(tabId: string, projectId: string) => emit('jump', tabId, projectId)"
        @close="emit('closeOverview')"
      />
    </div>
  </div>
</template>

<style scoped src="./terminal-tabbar.css"></style>
