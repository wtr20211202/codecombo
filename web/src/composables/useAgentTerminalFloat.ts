import { ref, type Ref } from 'vue'
import { safeStorage } from '../utils/storage'

/**
 * 智能体终端悬浮窗几何（P-20261001-20 从 AgentTerminalView 拆出）：
 * 位置/尺寸 localStorage 持久化 + 头部拖拽 + 四边四角缩放。
 * mode==='float' 时容器变形为悬浮窗，DOM 零移动 → 零重放零闪；
 * 几何键与旧 AgentTerminalFloat 同（sc.agentTerminal.pos/size，无缝迁移）。
 */
const FLOAT_POS_KEY = 'sc.agentTerminal.pos'
const FLOAT_SIZE_KEY = 'sc.agentTerminal.size'
const FLOAT_MIN = { w: 480, h: 320 }
const FLOAT_DEFAULT = { w: 720, h: 480 }

export function useAgentTerminalFloat(options: { isFloat: Ref<boolean> }) {
  const floatPos = ref({ x: 0, y: 0 })
  const floatSize = ref({ w: FLOAT_DEFAULT.w, h: FLOAT_DEFAULT.h })

  function clampFloatPos(p: { x: number; y: number }) {
    const { w, h } = floatSize.value
    return {
      x: Math.min(Math.max(p.x, 8), Math.max(8, window.innerWidth - w - 8)),
      y: Math.min(Math.max(p.y, 8), Math.max(8, window.innerHeight - h - 8)),
    }
  }
  function loadFloatGeometry() {
    try {
      const pos = JSON.parse(localStorage.getItem(FLOAT_POS_KEY) || 'null')
      const size = JSON.parse(localStorage.getItem(FLOAT_SIZE_KEY) || 'null')
      if (size && Number.isFinite(size.w) && Number.isFinite(size.h)) {
        floatSize.value = {
          w: Math.min(Math.max(size.w, FLOAT_MIN.w), window.innerWidth - 16),
          h: Math.min(Math.max(size.h, FLOAT_MIN.h), window.innerHeight - 16),
        }
      }
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) floatPos.value = clampFloatPos(pos)
      else floatPos.value = clampFloatPos({ x: window.innerWidth - FLOAT_DEFAULT.w - 24, y: 80 })
    } catch { /* 损坏即回默认 */ }
  }

  // 拖拽（float 头部手柄）：pointer 事件移动 floatPos，松开持久化
  let dragStart = { mx: 0, my: 0, x: 0, y: 0 }
  function onHeaderPointerDown(e: PointerEvent) {
    // 仅悬浮窗形态可拖；头部按钮/输入交互不受影响（未按左键忽略）
    if (!options.isFloat.value || e.button !== 0) return
    const target = e.target as HTMLElement | null
    if (target?.closest('button, input, select, textarea, .n-button, .n-dropdown')) return
    onFloatDragDown(e)
  }
  function onFloatDragDown(e: PointerEvent) {
    if (e.button !== 0) return
    dragStart = { mx: e.clientX, my: e.clientY, x: floatPos.value.x, y: floatPos.value.y }
    window.addEventListener('pointermove', onFloatDragMove)
    window.addEventListener('pointerup', onFloatDragUp)
  }
  function onFloatDragMove(e: PointerEvent) {
    floatPos.value = clampFloatPos({ x: dragStart.x + e.clientX - dragStart.mx, y: dragStart.y + e.clientY - dragStart.my })
  }
  function onFloatDragUp() {
    window.removeEventListener('pointermove', onFloatDragMove)
    window.removeEventListener('pointerup', onFloatDragUp)
    // safeStorage 通道（P-20261003-245）：pointerup 事件链内裸写抛错会打断
    // 同事件上的其余处理器，超额/隐私模式静默降级即可
    safeStorage.setItem(FLOAT_POS_KEY, JSON.stringify(floatPos.value))
  }

  // 缩放（四边 + 四角手柄）：按方向调整 floatSize/floatPos，松开持久化。
  // se 手柄沿用 .agt-resize e2e 契约类名；拖拽中钳制最小尺寸并对向边锚定
  // （w/n 方向尺寸被最小值钳住时位置随之修正，窗口不「飞」）
  type FloatResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
  let resizeStart: { mx: number; my: number; w: number; h: number; x: number; y: number; dir: FloatResizeDir } | null = null
  function onFloatResizeDown(dir: FloatResizeDir, e: PointerEvent) {
    if (e.button !== 0) return
    resizeStart = { mx: e.clientX, my: e.clientY, w: floatSize.value.w, h: floatSize.value.h, x: floatPos.value.x, y: floatPos.value.y, dir }
    window.addEventListener('pointermove', onFloatResizeMove)
    window.addEventListener('pointerup', onFloatResizeUp)
  }
  function onFloatResizeMove(e: PointerEvent) {
    if (!resizeStart) return
    const { mx, my, w: sw, h: sh, x: sx, y: sy, dir } = resizeStart
    const dx = e.clientX - mx
    const dy = e.clientY - my
    let w = sw
    let h = sh
    if (dir.includes('e')) w = sw + dx
    if (dir.includes('s')) h = sh + dy
    if (dir.includes('w')) w = sw - dx
    if (dir.includes('n')) h = sh - dy
    w = Math.min(Math.max(w, FLOAT_MIN.w), window.innerWidth - 16)
    h = Math.min(Math.max(h, FLOAT_MIN.h), window.innerHeight - 16)
    let x = sx
    let y = sy
    if (dir.includes('w')) x = sx + (sw - w)
    if (dir.includes('n')) y = sy + (sh - h)
    floatSize.value = { w, h }
    floatPos.value = clampFloatPos({ x, y })
  }
  function onFloatResizeUp() {
    window.removeEventListener('pointermove', onFloatResizeMove)
    window.removeEventListener('pointerup', onFloatResizeUp)
    resizeStart = null
    safeStorage.setItem(FLOAT_SIZE_KEY, JSON.stringify(floatSize.value))
  }

  /** 宿主卸载时兜底摘除 window 级监听（拖拽/缩放进行中销毁的场景） */
  function dispose() {
    window.removeEventListener('pointermove', onFloatDragMove)
    window.removeEventListener('pointerup', onFloatDragUp)
    window.removeEventListener('pointermove', onFloatResizeMove)
    window.removeEventListener('pointerup', onFloatResizeUp)
  }

  return {
    floatPos, floatSize, loadFloatGeometry,
    onHeaderPointerDown, onFloatResizeDown, dispose,
  }
}
