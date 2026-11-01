import { ref } from 'vue'
import { useLayoutLockStore } from '../stores/layoutLock'
import { safeStorage } from '../utils/storage'

/**
 * 智能体终端 docked 侧栏宽度拖拽（P-20261001-20 从 AgentTerminalView 拆出）：
 * 160-480px，localStorage 持久化；拖拽期间抑制原生 HTML5 拖拽与文本选择。
 */
const SIDEBAR_W_KEY = 'sc.agentTerminal.sidebarWidth'
const SIDEBAR_W_MIN = 160
const SIDEBAR_W_MAX = 480

export function useAgentTerminalSidebarWidth(options: { onResizeEnd?: () => void } = {}) {
  const sidebarWidth = ref(260)
  function clampSidebarWidth(w: number): number {
    return Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, w))
  }
  function loadSidebarWidth() {
    try {
      const raw = localStorage.getItem(SIDEBAR_W_KEY)
      const w = raw == null ? NaN : Number(raw)
      if (Number.isFinite(w)) sidebarWidth.value = clampSidebarWidth(w)
    } catch { /* ignore */ }
  }
  let sideResizeStart: { mx: number; w: number } | null = null
  const sideResizing = ref(false)
  /** 拖拽期间抑制原生 HTML5 拖拽：侧栏变宽后指针会落到可拖拽的会话条目上，
   *  浏览器据此发起 dragstart 劫持指针（pointercancel），宽度调整随即卡死 */
  function suppressDragDuringResize(e: Event) {
    e.preventDefault()
  }
  function onSidebarResizeDown(e: PointerEvent) {
    if (e.button !== 0) return
    // 布局锁定（P-20261003-180）：拖拽类交互统一短路，点击/键盘不受影响
    if (useLayoutLockStore().interceptDrag(e)) return
    sideResizeStart = { mx: e.clientX, w: sidebarWidth.value }
    sideResizing.value = true
    document.addEventListener('dragstart', suppressDragDuringResize, true)
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onSidebarResizeMove)
    window.addEventListener('pointerup', onSidebarResizeUp)
  }
  function onSidebarResizeMove(e: PointerEvent) {
    if (!sideResizeStart) return
    sidebarWidth.value = clampSidebarWidth(sideResizeStart.w + e.clientX - sideResizeStart.mx)
  }
  function onSidebarResizeUp() {
    window.removeEventListener('pointermove', onSidebarResizeMove)
    window.removeEventListener('pointerup', onSidebarResizeUp)
    document.removeEventListener('dragstart', suppressDragDuringResize, true)
    document.body.style.userSelect = ''
    sideResizeStart = null
    sideResizing.value = false
    safeStorage.setItem(SIDEBAR_W_KEY, String(sidebarWidth.value))
    options.onResizeEnd?.()
  }

  /** 宿主卸载时兜底摘除 window/document 级监听与选择抑制 */
  function dispose() {
    window.removeEventListener('pointermove', onSidebarResizeMove)
    window.removeEventListener('pointerup', onSidebarResizeUp)
    document.removeEventListener('dragstart', suppressDragDuringResize, true)
    if (sideResizeStart) {
      document.body.style.userSelect = ''
      sideResizeStart = null
      sideResizing.value = false
    }
  }

  return { sidebarWidth, sideResizing, loadSidebarWidth, onSidebarResizeDown, dispose }
}
