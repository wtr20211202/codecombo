import { ref, type Ref } from 'vue'
import { useLayoutLockStore } from '../stores/layoutLock'
import { safeStorage } from '../utils/storage'

/**
 * 通用侧栏宽度 resizer（P-20261106-5 自 useAgentTerminalSidebarWidth 泛化）：
 * 拖拽分隔条调宽 + safeStorage 宽度记忆 + 最小/最大钳制参数化 + 双击恢复默认
 * + 键盘微调（nudge，ARIA slider 语义用）。同一交互只此一套实现——新增可调
 * 侧栏优先复用（配 components/common/SidebarResizer.vue 把手），勿另起炉灶。
 *
 * - 记忆键约定 `sc.<panel>.sidebarWidth`（localStorage 客户端 UI 偏好，与
 *   sc.agentTerminal.sidebarWidth 同车道；存量键原样兼容不迁移）
 * - 拖拽期间抑制原生 HTML5 拖拽与文本选择（侧栏变宽后指针落到可拖拽条目上，
 *   浏览器会发起 dragstart 劫持指针致调整卡死——agent 侧栏同款防御）
 * - 布局锁定（P-20261003-180）：拖拽入口统一短路，键盘/双击不受影响
 */
export interface SidebarWidthOptions {
  /** 宽度记忆键（约定 sc.<panel>.sidebarWidth） */
  storageKey: string
  /** 最小宽度 px */
  min: number
  /** 最大宽度 px */
  max: number
  /** 默认宽度 px：双击复位目标，也是无持久化值时的初始值 */
  defaultWidth: number
  /** 外部 width ref（SidebarResizer 组件经 defineModel 桥接宿主）；缺省内部自建 */
  width?: Ref<number>
  /** 拖拽结束回调（如 xterm fit 补齐列数） */
  onResizeEnd?: () => void
}

export function useSidebarWidth(options: SidebarWidthOptions) {
  const { storageKey, min, max, defaultWidth, onResizeEnd } = options
  const width = options.width ?? ref(defaultWidth)
  const resizing = ref(false)

  function clamp(w: number): number {
    return Math.min(max, Math.max(min, w))
  }

  /** 读回持久化宽度（宿主挂载时调用）；缺省/非法值不覆盖默认宽度 */
  function load() {
    try {
      const raw = safeStorage.getItem(storageKey)
      const w = raw == null ? NaN : Number(raw)
      if (Number.isFinite(w)) width.value = clamp(w)
    } catch { /* ignore */ }
  }

  function persist(w: number) {
    safeStorage.setItem(storageKey, String(w))
  }

  /** 写值 + 落盘统一入口。落盘用计算值而非回读 width.value：经 v-model 桥接的
   *  defineModel ref 其 setter 只上抛 update 事件，getter 要等宿主重渲染后才
   *  回新值——同步回读必拿到旧值（键盘/双击/拖拽松开三条链同坑） */
  function commit(next: number) {
    width.value = next
    persist(next)
  }

  let drag: { mx: number; w: number; cur: number } | null = null
  /** 拖拽期间抑制原生 HTML5 拖拽：侧栏变宽后指针会落到可拖拽的条目上，
   *  浏览器据此发起 dragstart 劫持指针（pointercancel），宽度调整随即卡死 */
  function suppressDragDuringResize(e: Event) {
    e.preventDefault()
  }

  function onResizeDown(e: PointerEvent) {
    if (e.button !== 0) return
    // 布局锁定（P-20261003-180）：拖拽类交互统一短路，点击/键盘不受影响
    if (useLayoutLockStore().interceptDrag(e)) return
    drag = { mx: e.clientX, w: width.value, cur: width.value }
    resizing.value = true
    document.addEventListener('dragstart', suppressDragDuringResize, true)
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onResizeMove)
    window.addEventListener('pointerup', onResizeUp)
  }

  function onResizeMove(e: PointerEvent) {
    if (!drag) return
    drag.cur = clamp(drag.w + e.clientX - drag.mx)
    width.value = drag.cur
  }

  function onResizeUp() {
    window.removeEventListener('pointermove', onResizeMove)
    window.removeEventListener('pointerup', onResizeUp)
    document.removeEventListener('dragstart', suppressDragDuringResize, true)
    document.body.style.userSelect = ''
    const finalWidth = drag ? drag.cur : width.value
    drag = null
    resizing.value = false
    persist(finalWidth)
    onResizeEnd?.()
  }

  /** 键盘微调（方向键步进）：无 pointerup 事件链，步进即落盘；
   *  已在钳制边界时静默不动（写盘值不变不重复写） */
  function nudge(delta: number) {
    const next = clamp(width.value + delta)
    if (next === width.value) return
    commit(next)
  }

  /** 双击恢复默认宽度并落盘 */
  function resetToDefault() {
    commit(clamp(defaultWidth))
  }

  /** 宿主卸载时兜底摘除 window/document 级监听与选择抑制 */
  function dispose() {
    window.removeEventListener('pointermove', onResizeMove)
    window.removeEventListener('pointerup', onResizeUp)
    document.removeEventListener('dragstart', suppressDragDuringResize, true)
    if (drag) {
      document.body.style.userSelect = ''
      drag = null
      resizing.value = false
    }
  }

  return { width, resizing, load, onResizeDown, nudge, resetToDefault, dispose }
}
