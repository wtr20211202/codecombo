<script setup lang="ts">
import { ref } from 'vue'
import FileTreeView from '../../views/files/FileTreeView.vue'
import { safeAsync } from '../../utils/async-component'
const CommitPanel = safeAsync(() => import('../../views/git/CommitPanel.vue'))
const TodoPanel = safeAsync(() => import('../../views/todos/TodoPanel.vue'))
// 笔记面板已迁出侧栏（P-20261108-2）：成主区/首页独立视图 NotesView，勿在此回挂
//（单例引擎下双宿主 = 同屏两份面板互抢事件）
const ChangeStreamPanel = safeAsync(() => import('../../views/stream/ChangeStreamPanel.vue'))
const EnvProfilePanel = safeAsync(() => import('../../views/env/EnvProfilePanel.vue'))
const SyncCenterPanel = safeAsync(() => import('../../views/sync/SyncCenterPanel.vue'))
import { useI18n } from '../../composables/useI18n'
import { useNarrowLayout } from '../../composables/useNarrowLayout'
import { useLayoutLockStore } from '../../stores/layoutLock'
import type { SideView } from '../../composables/usePanelLayout'

const props = defineProps<{
  sideView: SideView
  showSidePanel: boolean
  sidePanelWidth: number
  fontSize: number
  commitLocation: 'sidebar' | 'bottom'
}>()

// safeAsync 组件手动重试：递增后作为 :key 触发重新挂载（重新执行 loader）
const asyncRetryTick = ref(0)

const emit = defineEmits<{
  'update:sidePanelWidth': [width: number]
  fileClick: [file: { path: string; name: string }]
  openInTerminal: [dirPath: string]
  openDiff: [params: { path: string; name: string; oldRef: string; newRef?: string }]
  compareBaseline: [file: { path: string; name: string }]
  /** 目录右键「在此目录搜索」（P-20261003-118）：宿主开搜索面板并预填目录 glob */
  searchInDir: [relDir: string]
  /** 文件树右键「在分屏打开」（P-20261003-321）：宿主走 openInSplitByPath 既有链路
   *  （载荷与 tab 右键同形：路径字符串） */
  openInSplit: [path: string]
  /** 窄屏抽屉遮罩点击关闭（P-20261019-7）：桌面形态不触发 */
  close: []
}>()

const { t } = useI18n()
const { narrow } = useNarrowLayout()
const fileTreeRef = ref<InstanceType<typeof FileTreeView> | null>(null)

defineExpose({ fileTreeRef })

// 拖拽调整左侧面板宽度（内置在组件内部）
const resizingSide = ref(false)
function startSideResize(e: MouseEvent) {
  // 布局锁定（P-20261003-180）：拖拽类交互统一短路，点击/键盘不受影响
  if (useLayoutLockStore().interceptDrag(e)) return
  e.preventDefault()
  resizingSide.value = true
  const root = document.querySelector('.ide-root')
  if (root) root.classList.add('resizing')
  // 拖宽侧栏后指针会落到文件树条目（draggable）上，浏览器会发起原生 HTML5
  // 拖拽劫持鼠标（mousemove/up 停发）导致拖宽卡死——拖拽期间统一抑制
  const suppressDrag = (ev: Event) => ev.preventDefault()
  document.addEventListener('dragstart', suppressDrag, true)
  document.body.style.userSelect = 'none'
  const startX = e.clientX
  const startWidth = props.sidePanelWidth
  function onMove(ev: MouseEvent) {
    if (!resizingSide.value) return
    const delta = ev.clientX - startX
    emit('update:sidePanelWidth', Math.max(180, Math.min(500, startWidth + delta)))
  }
  function onUp() {
    resizingSide.value = false
    if (root) root.classList.remove('resizing')
    document.removeEventListener('dragstart', suppressDrag, true)
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}
</script>

<template>
  <!-- 窄屏抽屉遮罩（P-20261019-7）：侧栏在 ≤700px 是覆盖主区的 drawer，
       点遮罩即收起；桌面形态不渲染 -->
  <Transition name="side-mask">
    <div
      v-if="narrow && showSidePanel"
      class="ide-side-mask"
      data-testid="side-drawer-mask"
      @click="emit('close')"
    />
  </Transition>
  <div
    v-show="showSidePanel"
    id="side-panel"
    :class="['ide-side-panel', { 'is-drawer': narrow }]"
    data-testid="side-panel"
    role="region"
    :aria-label="t('layout.sidebar')"
    :style="{ width: sidePanelWidth + 'px', fontSize: fontSize + 'px' }"
  >
    <!-- TODO 面板（P-20261002-25）：代码注释标记聚合；自管刷新，无对外事件。
         置于 files 分支前：历史 commitLocation!=='sidebar' 兜底不得遮蔽本视图 -->
    <TodoPanel
      v-if="sideView === 'todos'"
      :key="'sp-todo-' + asyncRetryTick"
      @retry="asyncRetryTick++"
    />
    <!-- 跨项目变更流面板（P-20261003-232）：file.changed 跨项目聚合时间线，
         自管轮询（挂载启动/卸载停表），无对外事件 -->
    <ChangeStreamPanel
      v-else-if="sideView === 'stream'"
      :key="'sp-stream-' + asyncRetryTick"
      @retry="asyncRetryTick++"
    />
    <!-- 项目环境画像面板（P-20261007-14）：dev 端口观测 × 哨兵规则 × 部署目标
         摘要一页简历，跟随当前项目自管加载，无对外事件 -->
    <EnvProfilePanel
      v-else-if="sideView === 'env'"
      :key="'sp-env-' + asyncRetryTick"
      @retry="asyncRetryTick++"
    />
    <!-- 多实例同步中心（P-20261023-1）：项目+上下文跨实例拉取/推送，自管
         取数与进度（WS 广播 + 轮询兜底），无对外事件 -->
    <SyncCenterPanel
      v-else-if="sideView === 'sync'"
      :key="'sp-sync-' + asyncRetryTick"
      @retry="asyncRetryTick++"
    />
    <FileTreeView
      v-else-if="sideView === 'files' || commitLocation !== 'sidebar'"
      ref="fileTreeRef"
      @file-click="emit('fileClick', $event)"
      @open-in-terminal="emit('openInTerminal', $event)"
      @compare-baseline="emit('compareBaseline', $event)"
      @search-in-dir="emit('searchInDir', $event)"
      @open-in-split="emit('openInSplit', $event)"
    />
    <CommitPanel
      v-else
      :key="'sp-commit-' + asyncRetryTick"
      @retry="asyncRetryTick++"
      @open-diff="emit('openDiff', $event)"
    />
  </div>
  <div
    v-show="showSidePanel"
    class="ide-side-resizer"
    :class="{ 'is-resizing': resizingSide }"
    @mousedown="startSideResize"
  />
</template>

<style scoped>
.ide-side-panel {
  background: var(--bg-primary);
  border-right: 1px solid var(--border-default);
  overflow: hidden;
  flex-shrink: 0;
  /* 拖拽时禁止内容选择 */
  user-select: none;
}

/* 窄屏抽屉遮罩：位于侧栏之下（侧栏 z-index 900）、内容区之上；上下让出
   顶栏与 52px 底部切换器——drawer 打开时仍可直接点底栏切到终端/再点文件
   收起（全屏遮罩会把切换器一起挡住，实测等于逼用户先找遮罩边缘） */
.ide-side-mask {
  position: fixed;
  left: 0;
  right: 0;
  top: var(--topbar-height, 40px);
  bottom: var(--narrow-rail-height, 52px);
  z-index: 890;
  background: var(--overlay-mask);
}
.side-mask-enter-active,
.side-mask-leave-active { transition: opacity var(--motion-base) var(--ease-standard); }
.side-mask-enter-from,
.side-mask-leave-to { opacity: 0; }

/* 侧栏宽度拖拽把手：命中区 8px + 常显竖向握把纹（纯透明把手等于不存在），
   悬停/拖拽中握把与底色高亮 */
.ide-side-resizer {
  width: 8px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
  position: relative;
  transition: background var(--motion-base);
}
.ide-side-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  border-radius: 1px;
  background: var(--border-default);
  opacity: 0.6;
  transition: background var(--motion-base), opacity var(--motion-base);
}
.ide-side-resizer:hover,
.ide-side-resizer.is-resizing {
  background: color-mix(in srgb, var(--accent-blue) 14%, transparent);
}
.ide-side-resizer:hover::after,
.ide-side-resizer.is-resizing::after {
  background: var(--accent-blue);
  opacity: 1;
}
</style>
