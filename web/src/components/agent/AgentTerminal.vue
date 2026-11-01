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
// 路由谁挂载谁消费；open 内部处理形态切换与主区互斥）
onMounted(() => {
  const pendingMode = consumePendingOpenState()
  if (pendingMode) void open(pendingMode)
})

// home overlay：打开过才挂载（保活），Esc 关闭（弹窗打开时让位）
const everDocked = ref(false)
watch([dockedVisible, floatHere], ([d, f]) => { if (d || f) everDocked.value = true })

// 主区互斥反向兜底（usePanelLayout 无法反向引用 useAgentTerminal）：
// 远程控制台/分享管理/项目仪表盘经命令面板、URL ?view= 等非 rail 入口打开时也关闭 docked 管理页。
// useAgentTerminal.open()/setMode 关闭二视图在先，不会与这里形成回环
if (props.context !== 'home') {
  const layout = usePanelLayout()
  watch([layout.showRemoteConsole, layout.showShareManager, layout.showDshConsole, layout.showDashboard], ([remote, share, dsh, dashboard]) => {
    if (remote || share || dsh || dashboard) hideDocked()
  })
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
