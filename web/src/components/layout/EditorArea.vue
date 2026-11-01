<script setup lang="ts">
// 编辑器主区（分屏 MVP 双组）：两容器各渲染一个编辑器组（EditorGroupPane），
// 排列轴随 splitDirection（P-20261005-230：横向并排=缺省 / 纵向堆叠），
// 中间分隔条可拖拽调主组占比（localStorage 记忆）；分屏关闭时组 1 不渲染
//（收起态），关闭时组 1 文件由 useOpenFiles.closeSplit 并回组 0 尾部。点击
// 任一编辑器区切换活跃组（pane-active 顶边高亮），Monaco/Diff 实例引用跟随
// 活跃组暴露。
import { ref, computed, watch } from 'vue'
import EditorGroupPane from './EditorGroupPane.vue'
import DraftRecoveryBar from '../editor/DraftRecoveryBar.vue'
import { useI18n } from '@/composables/useI18n'
import { useNarrowLayout } from '@/composables/useNarrowLayout'
import { useLayoutLockStore } from '@/stores/layoutLock'
import { usePanelLayout } from '@/composables/usePanelLayout'
import { safeStorage } from '@/utils/storage'
import type { EditorGroup, DraftOffer } from '@/composables/useOpenFiles'

const { t } = useI18n()

// 组临时最大化（P-20261004-64）：布局态在 usePanelLayout 模块单例（Esc 退栈
// 链 exitMaximizedByEsc / 命令面板共用同源），本组件直调 toggle——面板/主区
// 域组件直用布局组合式是既有惯例（BottomPanel/TerminalView 同款）
const layout = usePanelLayout()

// 窄屏（P-20261019-7）：主区单栏——分屏组改为上下等分堆叠（横向并排
// 在 390px 下每组仅 ~190px，Monaco 不可用），分隔条隐藏，避免触摸拖拽
// 误触；分屏数据零改动，回到桌面仍按原方向/比例还原
const { narrow } = useNarrowLayout()

const props = defineProps<{
  /** 编辑器组（双组 MVP：groups[0] 主组 / groups[1] 分屏组） */
  groups: EditorGroup[]
  activeGroup: number
  /** 分屏开合（uiState 记忆；组 1 文件清单/活跃位一并记忆，P-20261002-94） */
  splitOpen: boolean
  /** 分屏方向（P-20261005-230 正交拆分）：horizontal=左右（缺省，既有形态）/
   *  vertical=上下。只切本容器排列轴，两组内容零重建 */
  splitDirection?: 'horizontal' | 'vertical'
  showCommitPanel: boolean
  canReopenClosed: boolean
  /** 待决草稿恢复提示（队首；null = 无草稿，提示条不渲染） */
  draftOffer?: DraftOffer | null
}>()

// ── 所有状态修改通过 emit 通知父组件（组事件带组号） ──────────
const emit = defineEmits<{
  activateGroup: [gi: number]
  switchFile: [gi: number, index: number]
  closeFile: [gi: number, index: number]
  /** 脏点「保存并关闭」（P-20261003-138）：分组上抛转调 useOpenFiles */
  saveCloseFile: [gi: number, index: number]
  /** tab/编辑器右键「放弃未保存修改」（P-20261005-156）：分组上抛转调
   *  useOpenFiles.revertFileInGroup */
  revertFile: [gi: number, index: number]
  updateContent: [path: string, content: string]
  togglePin: [gi: number, index: number]
  saveCurrentFile: []
  /** 编码徽标菜单（P-20261002-146）：以指定编码重载 / 转为指定编码保存
   *  （宿主转调 useOpenFiles；作用对象 = 活跃组当前文件，与 saveCurrentFile
   *  同口径——点击徽标所在组的任意区域已先触发 activateGroup） */
  reloadWithEncoding: [encoding: string]
  saveWithEncoding: [encoding: string]
  openFile: [path: string]
  /** 树拖文件到 tab 条按落点插入打开（P-20261004-74）：分组上抛转
   *  openFileByPath opts.insertAt（宿主 Layout 绑定） */
  openFileAt: [path: string, index: number]
  newFile: []
  openCommandPalette: []
  openProject: []
  openSettings: []
  revealInFileTree: []
  compareClipboard: [payload: { path: string; text: string }]
  openOutline: []
  closeOtherTabs: [gi: number, index: number]
  closeAllTabs: [gi: number]
  closeTabsToRight: [gi: number, index: number]
  closeSavedTabs: [gi: number]
  reopenClosedTab: []
  dragReorder: [gi: number, from: number, to: number]
  /** 跨组拖签移动（P-20261003-38）：组内 tabMoveIn 带本组号上抛 */
  tabMove: [fromGi: number, path: string, toGi: number]
  openInSplit: [path: string, direction?: 'horizontal' | 'vertical']
  closeSplit: []
  draftRestore: [projectId: string, path: string]
  /** 草稿对比预览（P-20261004-71）：提示条第三键上抛，转调 useOpenFiles */
  draftPreview: [projectId: string, path: string]
  draftDiscard: [projectId: string, path: string]
  /** 远程文件离线横幅「重试」（P-20261003-15）：分组上抛转调 useOpenFiles */
  remoteRetry: [path: string]
}>()

function groupAt(gi: number): EditorGroup {
  return props.groups[gi] ?? { files: [], activeIndex: -1 }
}

// ── 暴露子组件 ref 给父组件（跟随活跃组） ───────────────────
const pane0Ref = ref<InstanceType<typeof EditorGroupPane> | null>(null)
const pane1Ref = ref<InstanceType<typeof EditorGroupPane> | null>(null)

// Monaco/Diff 实例引用跟随活跃组（与 useOpenFiles.currentFile 同语义）：
// 行定位/差异导航操作用户正在看的编辑器；model 释放钩子按路径幂等，
// 走活跃组引用即可
const monacoEditorRef = computed(() =>
  (props.activeGroup === 1 ? pane1Ref.value : pane0Ref.value)?.monacoEditorRef ?? null)
const diffEditorRef = computed(() =>
  (props.activeGroup === 1 ? pane1Ref.value : pane0Ref.value)?.diffEditorRef ?? null)

defineExpose({
  monacoEditorRef,
  diffEditorRef,
})

// ── 分屏宽度（localStorage 记忆；拖动分隔条调节，双击复位对半） ──
// 两方向共用一份比例记忆（键名沿用历史）：一次只有一个方向在场，比例语义是
// 「主组占比」，横向=宽度%、纵向=高度%，切方向不迁移记忆
const SPLIT_WIDTH_KEY = 'sc.editor.splitWidth'
const SPLIT_WIDTH_MIN = 20
const SPLIT_WIDTH_MAX = 80
const SPLIT_WIDTH_DEFAULT = 50

function readSplitWidth(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_WIDTH_KEY))
    if (Number.isFinite(v) && v >= SPLIT_WIDTH_MIN && v <= SPLIT_WIDTH_MAX) return v
  } catch { /* 环境无 localStorage 走默认 */ }
  return SPLIT_WIDTH_DEFAULT
}

const splitPercent = ref(readSplitWidth())
const splitLayoutRef = ref<HTMLElement | null>(null)

/** 当前分屏是否纵向（上下堆叠）：排列轴/分隔条朝向/拖拽取数轴的唯一判据 */
const isVerticalSplit = computed(() => props.splitDirection === 'vertical')

/** 窄屏强制纵向堆叠（主区单栏）：只在呈现层生效，不改 splitDirection 持久值 */
const stackedSplit = computed(() => isVerticalSplit.value || narrow.value)

// ── 组临时最大化（P-20261004-64）────────────────────────────
// 分屏开合改变组的存在性：分屏关闭（含组 1 搬空自动收）即退出最大化——
// 组号失效的残留态会让下次开分屏意外单组全宽。组 0 最大化时关分屏同理归零
// （单组本就独占全宽，最大化态失义）
watch(() => props.splitOpen, (open) => {
  if (!open && layout.editorGroupMaximized.value !== null) layout.editorGroupMaximized.value = null
})

/** 主组/分屏组是否被对侧最大化隐藏（v-show 保活：Monaco 实例/视图快照零重建） */
const primaryHidden = computed(() => layout.editorGroupMaximized.value === 1)
const splitHidden = computed(() => layout.editorGroupMaximized.value === 0)

function startSplitResize(e: MouseEvent) {
  // 布局锁定（P-20261003-180）：拖拽类交互统一短路，双击复位/键盘不受影响
  if (useLayoutLockStore().interceptDrag(e)) return
  e.preventDefault()
  const container = splitLayoutRef.value
  if (!container) return
  const vertical = isVerticalSplit.value
  document.body.classList.add('editor-split-resizing')
  if (vertical) document.body.classList.add('editor-split-resizing-v')
  const onMove = (ev: MouseEvent) => {
    const rect = container.getBoundingClientRect()
    // 纵向取 Y 轴/高度，横向取 X 轴/宽度（比例语义同为主组占比）
    if (vertical ? rect.height <= 0 : rect.width <= 0) return
    const pct = vertical
      ? ((ev.clientY - rect.top) / rect.height) * 100
      : ((ev.clientX - rect.left) / rect.width) * 100
    splitPercent.value = Math.min(SPLIT_WIDTH_MAX, Math.max(SPLIT_WIDTH_MIN, pct))
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.classList.remove('editor-split-resizing')
    document.body.classList.remove('editor-split-resizing-v')
    safeStorage.setItem(SPLIT_WIDTH_KEY, splitPercent.value.toFixed(1))
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
</script>

<template>
  <div
    class="ide-editor-area"
    role="main"
  >
    <!-- 草稿恢复提示条（P-20261002-6）：探测到比磁盘新的未保存草稿时置顶展示 -->
    <DraftRecoveryBar
      :offer="props.draftOffer ?? null"
      @restore="emit('draftRestore', props.draftOffer?.projectId || '', props.draftOffer?.path || '')"
      @preview="emit('draftPreview', props.draftOffer?.projectId || '', props.draftOffer?.path || '')"
      @discard="emit('draftDiscard', props.draftOffer?.projectId || '', props.draftOffer?.path || '')"
    />
    <div
      ref="splitLayoutRef"
      class="editor-split"
      :class="{ 'editor-split-vertical': stackedSplit }"
    >
      <!-- 主组（组 0）：uiState 持久化的文件列表承载组。
           v-show 隐藏 = 对侧组临时最大化（P-20261004-64）——组保活不重建，
           Monaco 滚动位/光标/脏内容原样保留 -->
      <EditorGroupPane
        v-show="!primaryHidden"
        ref="pane0Ref"
        class="editor-pane pane-primary"
        :class="{
          'pane-active': activeGroup === 0,
          'is-group-maximized': layout.editorGroupMaximized.value === 0,
        }"
        :style="splitOpen
          ? (layout.editorGroupMaximized.value === 0
            ? { flex: '1 1 100%' }
            : (narrow ? { flex: '1 1 50%' } : { flex: '0 0 ' + splitPercent + '%' }))
          : undefined"
        :group-index="0"
        :files="groupAt(0).files"
        :active-index="groupAt(0).activeIndex"
        :can-reopen-closed="canReopenClosed"
        :show-commit-panel="showCommitPanel"
        :allow-split-open="true"
        @toggle-maximize="layout.toggleEditorGroupMaximized(0)"
        @activate="emit('activateGroup', 0)"
        @switch-file="(i) => emit('switchFile', 0, i)"
        @close-file="(i) => emit('closeFile', 0, i)"
        @save-close-file="(i) => emit('saveCloseFile', 0, i)"
        @revert-file="(i) => emit('revertFile', 0, i)"
        @toggle-pin="(i) => emit('togglePin', 0, i)"
        @update-content="(p, c) => emit('updateContent', p, c)"
        @save-current-file="emit('saveCurrentFile')"
        @reload-with-encoding="emit('reloadWithEncoding', $event)"
        @save-with-encoding="emit('saveWithEncoding', $event)"
        @open-file="emit('openFile', $event)"
        @open-file-at="(p, i) => emit('openFileAt', p, i)"
        @new-file="emit('newFile')"
        @open-command-palette="emit('openCommandPalette')"
        @open-project="emit('openProject')"
        @open-settings="emit('openSettings')"
        @reveal-in-file-tree="emit('revealInFileTree')"
        @compare-clipboard="emit('compareClipboard', $event)"
        @open-outline="emit('openOutline')"
        @close-other-tabs="(i) => emit('closeOtherTabs', 0, i)"
        @close-all-tabs="emit('closeAllTabs', 0)"
        @close-tabs-to-right="(i) => emit('closeTabsToRight', 0, i)"
        @close-saved-tabs="emit('closeSavedTabs', 0)"
        @reopen-closed-tab="emit('reopenClosedTab')"
        @drag-reorder="(f, to) => emit('dragReorder', 0, f, to)"
        @tab-move-in="(fg, p) => emit('tabMove', fg, p, 0)"
        @open-in-split="(p, d) => emit('openInSplit', p, d)"
        @remote-retry="(p) => emit('remoteRetry', p)"
      />

      <!-- 分隔条：拖拽调宽/调高（20%~80% 钳制），双击复位对半。方向随
           splitDirection（P-20261005-230）：纵向=水平分隔条 row-resize。
           组最大化期间隐藏（v-show：还原后拖拽态立即可用，无需重建） -->
      <div
        v-if="splitOpen"
        v-show="layout.editorGroupMaximized.value === null && !narrow"
        class="split-divider"
        :class="{ 'split-divider-v': stackedSplit }"
        role="separator"
        :aria-orientation="stackedSplit ? 'horizontal' : 'vertical'"
        :aria-label="stackedSplit ? t('layout.splitDown') : t('layout.splitRight')"
        @mousedown="startSplitResize"
        @dblclick="splitPercent = 50"
      />

      <!-- 分屏组（组 1）：splitOpen 时渲染；组内无签（清单未恢复/已关完）
           显示收起占位 + 关闭分屏入口。
           v-show 隐藏 = 主组临时最大化（P-20261004-64）：组保活，tab 清单与
           Monaco 视图状态原样保留，还原即回位 -->
      <EditorGroupPane
        v-if="splitOpen"
        v-show="!splitHidden"
        ref="pane1Ref"
        class="editor-pane pane-split"
        :class="{
          'pane-active': activeGroup === 1,
          'is-group-maximized': layout.editorGroupMaximized.value === 1,
        }"
        :style="layout.editorGroupMaximized.value === 1
          ? { flex: '1 1 100%' }
          : (narrow ? { flex: '1 1 50%' } : undefined)"
        :group-index="1"
        :files="groupAt(1).files"
        :active-index="groupAt(1).activeIndex"
        :can-reopen-closed="canReopenClosed"
        :allow-split-open="false"
        @toggle-maximize="layout.toggleEditorGroupMaximized(1)"
        @activate="emit('activateGroup', 1)"
        @switch-file="(i) => emit('switchFile', 1, i)"
        @close-file="(i) => emit('closeFile', 1, i)"
        @save-close-file="(i) => emit('saveCloseFile', 1, i)"
        @revert-file="(i) => emit('revertFile', 1, i)"
        @toggle-pin="(i) => emit('togglePin', 1, i)"
        @update-content="(p, c) => emit('updateContent', p, c)"
        @save-current-file="emit('saveCurrentFile')"
        @reload-with-encoding="emit('reloadWithEncoding', $event)"
        @save-with-encoding="emit('saveWithEncoding', $event)"
        @open-file="emit('openFile', $event)"
        @open-file-at="(p, i) => emit('openFileAt', p, i)"
        @new-file="emit('newFile')"
        @open-command-palette="emit('openCommandPalette')"
        @open-project="emit('openProject')"
        @open-settings="emit('openSettings')"
        @reveal-in-file-tree="emit('revealInFileTree')"
        @compare-clipboard="emit('compareClipboard', $event)"
        @open-outline="emit('openOutline')"
        @close-other-tabs="(i) => emit('closeOtherTabs', 1, i)"
        @close-all-tabs="emit('closeAllTabs', 1)"
        @close-tabs-to-right="(i) => emit('closeTabsToRight', 1, i)"
        @close-saved-tabs="emit('closeSavedTabs', 1)"
        @reopen-closed-tab="emit('reopenClosedTab')"
        @drag-reorder="(f, to) => emit('dragReorder', 1, f, to)"
        @tab-move-in="(fg, p) => emit('tabMove', fg, p, 1)"
        @close-split="emit('closeSplit')"
        @remote-retry="(p) => emit('remoteRetry', p)"
      >
        <template #empty>
          <div class="split-empty">
            <div class="split-empty-hint">
              {{ t('layout.splitEmptyHint') }}
            </div>
            <button
              class="split-empty-close"
              @click="emit('closeSplit')"
            >
              {{ t('layout.closeSplit') }}
            </button>
          </div>
        </template>
      </EditorGroupPane>
    </div>
  </div>
</template>

<style scoped>
.ide-editor-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 分屏布局：单组时组 0 独占（与历史单容器渲染等价）；分屏时主组按
 * splitPercent 定宽（横向）/定高（纵向，P-20261005-230）、分屏组吃剩余空间 */
.editor-split {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}

/* 纵向分屏（P-20261005-230）：排列轴翻转为主轴纵列，组内结构（tab 条等）不变 */
.editor-split.editor-split-vertical {
  flex-direction: column;
}

.editor-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* 活跃组高亮：顶边品牌色描边（box-shadow 不挤占布局） */
.editor-pane.pane-active {
  box-shadow: inset 0 2px 0 var(--accent-blue);
}

/* 组临时最大化边缘弱提示（P-20261004-64）：inset 1px 焦点色低饱和描边——
 * 与 pane-active 顶边高亮可叠加，一眼可辨「当前单组占全宽是临时态、可还原
 * （再双击 tab 条 / Esc）」；outline 不挤占布局，Monaco 行列不受影响 */
.editor-pane.is-group-maximized {
  outline: 1px solid color-mix(in srgb, var(--accent-blue) 45%, transparent);
  outline-offset: -1px;
}

/* 分隔条 */
.split-divider {
  flex: 0 0 4px;
  cursor: col-resize;
  background: var(--border-default);
  transition: background var(--motion-base);
}

/* 纵向分屏分隔条（P-20261005-230）：水平条、上下拖拽光标 */
.split-divider.split-divider-v {
  cursor: row-resize;
}

.split-divider:hover,
.split-divider:active {
  background: var(--accent-blue);
}

/* 分屏组空态（收起占位） */
.split-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  color: var(--text-secondary);
  text-align: center;
}

.split-empty-hint {
  font-size: 0.9em;
  max-width: 300px;
  line-height: 1.6;
}

.split-empty-close {
  padding: 5px 14px;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: var(--bg-panel);
  color: var(--text-body);
  font-size: 0.88em;
  cursor: pointer;
  transition: all var(--motion-base);
}

.split-empty-close:hover {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}
</style>

<style>
/* 拖拽分隔条期间全局握紧光标并禁选中（scoped 够不到 body）；纵向拖拽以
 * 修饰类覆盖为 row-resize */
body.editor-split-resizing,
body.editor-split-resizing * {
  cursor: col-resize !important;
  user-select: none;
}

body.editor-split-resizing.editor-split-resizing-v,
body.editor-split-resizing.editor-split-resizing-v * {
  cursor: row-resize !important;
}
</style>
