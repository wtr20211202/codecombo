<script setup lang="ts">
// 笔记独立视图宿主（P-20261108-2）：笔记脱离侧栏窄条成 notepad 式大区域，首页与
// 项目页均可打开（同一份 NotesPanel 主体，按路由各挂一份宿主——路由互斥挂载，
// 全应用同时至多一个面板实例，useNotesMulti 单例引擎的事件监听不会双开）。
// - project：主区第六占用者——占满 ide-body 编辑器位（agt-embedded flex:1 同款
//   语义），与远程/分享/dsh/仪表盘/agent docked 互斥（usePanelLayout 互斥族 +
//   AgentTerminal 反向 watch + EditorArea v-show 守卫）；关闭走头部关闭钮，不接
//   Esc（与 useLayoutKeyboard 的 Esc 逐层退栈链抢序）
// - home：近全屏 overlay（z 900，与远程控制台/agent docked overlay 同层级交叉
//   关闭）——四周留白居中卡片，「美观合理即可不机械铺满」（访客终端页同类反馈
//   既有口径）；Esc 关闭（Naive 模态/抽屉在场时让位，promptDialog 命名框先关）
// 开态 = usePanelLayout.showNotesView 模块级单例，不落 uiState（showDashboard
// 先例：纯查看面，刷新回工作形态——首页刷新不自动展开天然成立）。
// 懒挂载保活：首开才挂载面板（挂载即取数），之后 v-show 切换——编辑现场与防抖
// 挂起写不因开合丢失（宿主卸载时面板 onBeforeUnmount 统一 flushAll）
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { safeAsync } from '../../utils/async-component'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { useI18n } from '../../composables/useI18n'
import { hasBlockingOverlay } from '../../utils/overlayGuard'

const NotesPanel = safeAsync(() => import('./NotesPanel.vue'))

const props = defineProps<{
  /** home：近全屏 overlay；project：内嵌主区（默认） */
  context?: 'home' | 'project'
}>()

const { t } = useI18n()
const { showNotesView, closeNotesView } = usePanelLayout()

// safeAsync 组件手动重试：递增后作为 :key 触发重新挂载（SidePanel 同款）
const asyncRetryTick = ref(0)

// immediate（P-20261106-4 同族范式）：开态是模块级状态，宿主重挂时可能已为真——
// 无「变化」可触发 watch 会留下空壳，挂载即按当前开态同步一次
const everOpened = ref(false)
watch(showNotesView, (v) => { if (v) everOpened.value = true }, { immediate: true })

function onKeyDown(e: KeyboardEvent): void {
  if (props.context !== 'home' || e.key !== 'Escape' || !showNotesView.value) return
  if (hasBlockingOverlay()) return
  closeNotesView()
}
onMounted(() => document.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <!-- project：内嵌主区，占满 ide-body 中编辑器的位置（编辑器 v-show 隐藏时） -->
  <div
    v-if="context !== 'home'"
    v-show="showNotesView"
    class="notes-embedded"
    data-testid="notes-view"
  >
    <NotesPanel
      v-if="everOpened"
      :key="'nv-' + asyncRetryTick"
      closable
      @close="closeNotesView"
      @retry="asyncRetryTick++"
    />
  </div>

  <!-- home：近全屏 overlay（Teleport），与远程控制台/agent docked overlay 同层级 -->
  <Teleport to="body">
    <div
      v-if="context === 'home' && everOpened"
      v-show="showNotesView"
      class="notes-home-overlay"
      role="dialog"
      :aria-label="t('notes.panel.title')"
      data-testid="notes-home-overlay"
    >
      <div class="notes-home-card">
        <NotesPanel
          :key="'nvh-' + asyncRetryTick"
          closable
          @close="closeNotesView"
          @retry="asyncRetryTick++"
        />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 内嵌主区：占满编辑器位（与 agt-embedded / dashboard-embedded 同款弹性语义；
   面板根自带 flex:1 + min-height:0 填充，见 NotesPanel .notes-panel） */
.notes-embedded {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

/* 首页近全屏 overlay：遮罩 + 居中大卡片（四周留白，宽度封顶防超宽屏一行过长） */
.notes-home-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: 28px 32px;
  background: var(--overlay-mask);
}
.notes-home-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1280px;
  min-height: 0;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  box-shadow: var(--shadow-strong);
  overflow: hidden;
}
/* 窄屏（≤700px，useNarrowLayout 同断点）：留白让给内容，卡片铺满 */
@media (max-width: 700px) {
  .notes-home-overlay {
    padding: 0;
  }
  .notes-home-card {
    max-width: none;
    border: none;
    border-radius: 0;
  }
}
</style>
