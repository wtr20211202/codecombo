import { ref } from 'vue'
import { useFontStore } from '../stores/font'
import { usePanelLayout } from './usePanelLayout'

/**
 * 投屏演示模式（P-20261002-45）：结对/投屏讲代码的「大字 + 干净 + 快进快出」。
 * - 大字：编辑器/终端字号临时 ×1.5（font store presentScale，纯内存不落盘，
 *   退出即还原；Monaco/xterm 消费生效字号出口随动）
 * - 干净：侧栏与底栏自动收起——直接写 usePanelLayout 既有开合 ref（与 Ctrl+B /
 *   Ctrl+` toggle 同一条链路，autosave/uiState 照常感知），进入前面板态快照，
 *   退出原样恢复（含进入时被压下的最大化态）
 * - 快进快出：命令面板进入；Esc 或再次执行命令退出（Esc 钩子由
 *   useLayoutKeyboard 接线，优先级在退出最大化态之前）
 *
 * 模块级单例状态（与 usePanelLayout 同范式）：路由切换/组件重挂载不丢，
 * 刷新即回到持久化布局（演示态本就不持久化）。
 */

/** 演示态字号缩放系数：14px → 21px，投屏可读的量级 */
const PRESENT_SCALE = 1.5

/** 进入前面板态快照：开合 + 三种互斥最大化态（进入收起底栏时会被
 *  usePanelLayout 的 showBottomPanel watch 一并清掉，退出时一并还原） */
interface PanelSnapshot {
  showSidePanel: boolean
  showBottomPanel: boolean
  bottomPanelMaximized: boolean
  bottomPanelEditorMaximized: boolean
  terminalMaximized: boolean
}

const active = ref(false)
let snapshot: PanelSnapshot | null = null

/** 进入演示态：已在演示态时 no-op（命令面板重复执行交给 toggle） */
function enter(): void {
  if (active.value) return
  const layout = usePanelLayout()
  snapshot = {
    showSidePanel: layout.showSidePanel.value,
    showBottomPanel: layout.showBottomPanel.value,
    bottomPanelMaximized: layout.bottomPanelMaximized.value,
    bottomPanelEditorMaximized: layout.bottomPanelEditorMaximized.value,
    terminalMaximized: layout.terminalMaximized.value,
  }
  useFontStore().setPresentScale(PRESENT_SCALE)
  // 收起走既有开合 ref（面板隐藏时其内部 watch 会同步清最大化态，快照已先行留底）
  layout.showSidePanel.value = false
  layout.showBottomPanel.value = false
  active.value = true
}

/** 退出演示态并还原进入前状态；未在演示态时 no-op */
function exit(): void {
  if (!active.value) return
  const layout = usePanelLayout()
  useFontStore().setPresentScale(1)
  if (snapshot) {
    layout.showSidePanel.value = snapshot.showSidePanel
    layout.showBottomPanel.value = snapshot.showBottomPanel
    // 最大化态在开合 ref 之后写：清最大化只挂在 showBottomPanel → false 的
    // 收起方向，恢复路径（false→true 或无变化）不会二次清掉
    layout.bottomPanelMaximized.value = snapshot.bottomPanelMaximized
    layout.bottomPanelEditorMaximized.value = snapshot.bottomPanelEditorMaximized
    layout.terminalMaximized.value = snapshot.terminalMaximized
    snapshot = null
  }
  active.value = false
}

/** 进入/退出切换（命令面板同一命令 id 复用执行/退出两个语义） */
function toggle(): void {
  if (active.value) exit()
  else enter()
}

/** Esc 退出钩子（useLayoutKeyboard Esc 链调用）：演示态中消费并返回 true，
 *  未在演示态返回 false 放行后续 Esc 行为（退出最大化态等） */
function exitByEsc(): boolean {
  if (!active.value) return false
  exit()
  return true
}

export function usePresentMode() {
  return { active, enter, exit, toggle, exitByEsc }
}

/** 仅供测试使用：重置模块级状态（与 resetPanelLayout 同范式） */
export function resetPresentMode() {
  active.value = false
  snapshot = null
}
