<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import AgentTerminalView from './AgentTerminalView.vue'
import AgentTerminalMini from './AgentTerminalMini.vue'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { hasBlockingOverlay } from '../../utils/overlayGuard'

/**
 * 智能体组件（全局唯一挂载点，路由间互斥：Home 与项目页各挂一份）。
 * - docked 管理页：project 内嵌主区（占满 ide-body 编辑器位）/ home 全屏 overlay
 * - float / mini：Teleport 到 body 的悬浮窗与悬浮球条（位置/尺寸/样式自持久化）
 * - home overlay 打开后保活（关闭仅隐藏）；project 内嵌随 visible 卸载，
 *   重开经 scrollback 重放恢复现场；会话本体始终由服务端 tmux/PTY 常驻
 */
const props = defineProps<{
  /** home：docked 以全屏 overlay 呈现；project：内嵌主区（默认） */
  context?: 'home' | 'project'
}>()

const { mode, visible, hide, hideDocked, open, consumePendingOpenState } = useAgentTerminal()

const dockedVisible = computed(() => visible.value && mode.value === 'docked')
// float 态：View 即悬浮窗，宿主容器保持可见（否则悬浮窗随分支 v-show 消失）
const floatHere = computed(() => visible.value && mode.value === 'float')

// 启动恢复：刷新前管理页/悬浮窗若处于打开状态，挂载后原样恢复（home/project
// 路由谁挂载谁消费；open 内部处理形态切换与主区互斥）。
// home 宿主例外（P-20261107-3「首页=纯首页」boot 定案）：刷新落在首页时不自动
// 展开 docked overlay（持久化的 docked 开态只消费不生效，防止残留到后续项目
// 挂载）；float/mini 全局悬浮层照旧恢复（跟随导航既有行为）
onMounted(() => {
  const pendingMode = consumePendingOpenState()
  if (!pendingMode) return
  if (props.context === 'home' && pendingMode === 'docked') return
  void open(pendingMode)
})

// home overlay：打开过才挂载（保活），Esc 关闭（弹窗打开时让位）
// immediate（P-20261106-4）：visible/mode 是 useAgentTerminal 模块级状态（跨路由
// 存活），首页往返卸载重挂后本实例 everDocked=false 且 dockedVisible/floatHere
// 已为 true——无「变化」可触发 watch，面板 v-if 空壳而活动栏图标（registry 读
// 模块态）照常选中，须取消再点一次才恢复；挂载即按当前形态同步一次
const everDocked = ref(false)
watch([dockedVisible, floatHere], ([d, f]) => { if (d || f) everDocked.value = true }, { immediate: true })

// 主区互斥反向兜底（usePanelLayout 无法反向引用 useAgentTerminal）：
// 远程控制台/分享管理/项目仪表盘/笔记视图经命令面板、URL ?view= 等非 rail 入口打开时也关闭 docked 管理页。
// useAgentTerminal.open()/setMode 关闭这些视图在先，不会与这里形成回环
const layout = usePanelLayout()
if (props.context !== 'home') {
  watch([layout.showRemoteConsole, layout.showShareManager, layout.showDshConsole, layout.showDashboard, layout.showNotesView], ([remote, share, dsh, dashboard, notes]) => {
    if (remote || share || dsh || dashboard || notes) hideDocked()
  })
} else {
  // 首页 overlay 交叉关闭（P-20261108-2）：笔记 overlay 经任意入口打开（首页工具条 /
  // docked 管理页头部「沉淀到笔记」助力等）即收起 docked overlay——两者同为 z 900
  // 全屏层，不收则按 DOM 序叠压。反向（docked 打开收笔记）走 closeMainViews
  watch(layout.showNotesView, (v) => { if (v) hideDocked() })
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && dockedVisible.value && props.context === 'home') {
    if (hasBlockingOverlay()) return
    hide()
  }
}
onMounted(() => document.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <!-- project：内嵌主区，占满 ide-body 中编辑器的位置（编辑器隐藏时） -->
  <div
    v-if="context !== 'home'"
    v-show="dockedVisible || floatHere"
    class="agt-embedded"
  >
    <!-- keep-alive：float 态由 floatHere 支撑可见，docked 隐藏仅 v-show（pane 现场保留） -->
    <AgentTerminalView
      v-if="everDocked || floatHere"
      v-show="dockedVisible || floatHere"
      standalone
      class="agt-fill"
      @close="hide"
    />
  </div>

  <!-- home：全屏 overlay（Teleport），与远程控制台 overlay 同款形态 -->
  <Teleport to="body">
    <div
      v-if="context === 'home' && everDocked"
      v-show="dockedVisible || floatHere"
      class="agt-home-overlay"
    >
      <AgentTerminalView
        standalone
        class="agt-fill"
        @close="hide"
      />
    </div>
  </Teleport>

  <!-- float / mini：悬浮本体（自持久化位置/尺寸/样式） -->
  <Teleport to="body">
    <AgentTerminalMini v-if="visible && mode === 'mini'" />
  </Teleport>
</template>

<style scoped>
/* 内嵌主区：占满编辑器位 */
.agt-embedded {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
}
.agt-fill { flex: 1; min-width: 0; height: 100%; }

/* home 全屏 overlay */
.agt-home-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: var(--bg-primary);
}
</style>
