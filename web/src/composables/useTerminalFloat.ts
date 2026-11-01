import { computed, reactive, watch, type ComputedRef, type Ref } from 'vue'
import type { TermTab } from './useTerminalTabs'
import { safeStorage } from '../utils/storage'
/**
 * 终端 tab 拖出浮动窗（CSS morph 方案）：
 * pane DOM 不迁移——浮动 = 给既有 .term-tab-content 加 is-floating class
 * （absolute 100% → fixed 几何），xterm 实例 / WS 连接零感知。
 *
 * 状态结构：
 * - floatMap: tabId → 浮动几何（left/top/width/height，唯一几何事实源）
 * - zMap: tabId → 层级序号（pointerdown 带到前台）
 * - HTML5 DnD 拖出：dragstart 记 tabId，dragend 时 dropEffect==='none'
 *   且落点在 tab 条外 → 浮动（落点即窗口锚点）；落回 tab 条 = 取消
 *
 * split tab 允许整体浮动（两 pane 同容器，morph 天然生效）；
 * 被管理页接管的占位卡浮动同样成立（取回后回归 docked 渲染）。
 */

export interface FloatGeometry {
  x: number
  y: number
  w: number
  h: number
}

// 浮动窗口尺寸约束（与 .is-floating 的 min-width/height 对应）
export const FLOAT_MIN_W = 380
export const FLOAT_MIN_H = 240
const FLOAT_DEFAULT_W = 760
const FLOAT_DEFAULT_H = 480
const VIEWPORT_PAD = 8

export interface TerminalFloatApi {
  /** tabId → 浮动几何（reactive，渲染层直接读） */
  floatMap: Map<string, FloatGeometry>
  /** 当前浮动 tab id 集合（computed，传 tab 栏渲染指示器） */
  floatingIds: ComputedRef<Set<string>>
  isFloating: (id: string) => boolean
  zOf: (id: string) => number
  bringToFront: (id: string) => void
  /** 浮动（anchor = 窗口左上角期望位置，缺省居中偏移） */
  floatTab: (tab: TermTab, anchor?: { x: number; y: number }) => void
  /** 收回面板 */
  dockBack: (id: string) => void
  /** 设置几何（夹紧到视口内） */
  setGeometry: (id: string, g: Partial<FloatGeometry>) => void
  /** 标题栏拖拽：pointerdown 起点，window move/up 跟随（AgentTerminalMini 同范式） */
  startBarDrag: (id: string, e: PointerEvent) => void
  /** tab 拖出手势：dragstart 登记 / dragend 判定（outsideStrip = 落点在 tab 条外） */
  onTabDragStart: (tab: TermTab, e: DragEvent) => void
  onTabDragEnd: (tab: TermTab, e: DragEvent, outsideStrip: boolean) => void
}

// （无本地别名：Ref 直接从 vue 类型导入）

export function useTerminalFloat(options: { tabs: Ref<TermTab[]> }): TerminalFloatApi {
  const { tabs } = options

  // ============== 几何持久化（localStorage，sc.* 键约定） ==============
  // 记录最近一次浮动窗口的几何：重开会话时尺寸沿用；位置仍由拖出锚点/居中决定
  const GEOMETRY_KEY = 'sc.terminalFloat.geometry'
  function loadSavedGeometry(): FloatGeometry | null {
    try {
      const raw = safeStorage.getItem(GEOMETRY_KEY)
      if (!raw) return null
      const g = JSON.parse(raw) as FloatGeometry
      if ([g.x, g.y, g.w, g.h].every(v => Number.isFinite(v))) return g
    } catch { /* 损坏即回默认 */ }
    return null
  }
  function persistGeometry(id: string): void {
    const g = floatMap.get(id)
    if (g) safeStorage.setItem(GEOMETRY_KEY, JSON.stringify({ x: g.x, y: g.y, w: g.w, h: g.h }))
  }
  const floatMap = reactive(new Map<string, FloatGeometry>()) as Map<string, FloatGeometry>
  const zMap = reactive(new Map<string, number>()) as Map<string, number>
  let zCounter = 0

  const floatingIds = computed(() => new Set(floatMap.keys()))
  const isFloating = (id: string) => floatMap.has(id)
  const zOf = (id: string) => zMap.get(id) ?? 0
  function bringToFront(id: string): void {
    if (!floatMap.has(id)) return
    zMap.set(id, ++zCounter)
  }

  function clampGeometry(g: FloatGeometry): FloatGeometry {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = Math.min(Math.max(g.w, FLOAT_MIN_W), vw - VIEWPORT_PAD * 2)
    const h = Math.min(Math.max(g.h, FLOAT_MIN_H), vh - VIEWPORT_PAD * 2)
    return {
      w,
      h,
      x: Math.min(Math.max(g.x, VIEWPORT_PAD), Math.max(VIEWPORT_PAD, vw - w - VIEWPORT_PAD)),
      y: Math.min(Math.max(g.y, VIEWPORT_PAD), Math.max(VIEWPORT_PAD, vh - h - VIEWPORT_PAD)),
    }
  }

  function defaultGeometry(anchor?: { x: number; y: number }): FloatGeometry {
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 持久化几何整体沿用（位置+尺寸，重开恢复上次窗口）；有锚点（拖出释放点）
    // 时位置由释放点决定，尺寸仍沿用
    const saved = loadSavedGeometry()
    if (!anchor && saved) return clampGeometry(saved)
    const w = Math.min(saved?.w ?? FLOAT_DEFAULT_W, vw - VIEWPORT_PAD * 2)
    const h = Math.min(saved?.h ?? FLOAT_DEFAULT_H, vh - VIEWPORT_PAD * 2)
    const x = anchor ? anchor.x - w * 0.3 : (vw - w) / 2 + 40
    const y = anchor ? anchor.y - 14 : (vh - h) / 2 - 30
    return clampGeometry({ x, y, w, h })
  }

  function floatTab(tab: TermTab, anchor?: { x: number; y: number }): void {
    if (floatMap.has(tab.id)) return
    floatMap.set(tab.id, defaultGeometry(anchor))
    zMap.set(tab.id, ++zCounter)
  }

  function dockBack(id: string): void {
    persistGeometry(id)
    floatMap.delete(id)
    zMap.delete(id)
  }

  function setGeometry(id: string, g: Partial<FloatGeometry>): void {
    const cur = floatMap.get(id)
    if (!cur) return
    Object.assign(cur, clampGeometry({ ...cur, ...g }))
  }

  // ============== 标题栏拖拽（pointer 事件，窗口自由移动 + 视口夹紧） ==============
  const DRAG_THRESHOLD = 4
  let barDrag: { id: string; mx: number; my: number; x: number; y: number } | null = null

  function onBarPointerMove(e: PointerEvent): void {
    if (!barDrag) return
    if (Math.abs(e.clientX - barDrag.mx) + Math.abs(e.clientY - barDrag.my) < DRAG_THRESHOLD) return
    setGeometry(barDrag.id, { x: barDrag.x + e.clientX - barDrag.mx, y: barDrag.y + e.clientY - barDrag.my })
  }
  function onBarPointerUp(): void {
    if (barDrag) persistGeometry(barDrag.id)
    barDrag = null
    window.removeEventListener('pointermove', onBarPointerMove)
    window.removeEventListener('pointerup', onBarPointerUp)
  }
  function startBarDrag(id: string, e: PointerEvent): void {
    if (e.button !== 0) return
    const g = floatMap.get(id)
    if (!g) return
    bringToFront(id)
    barDrag = { id, mx: e.clientX, my: e.clientY, x: g.x, y: g.y }
    e.preventDefault()
    window.addEventListener('pointermove', onBarPointerMove)
    window.addEventListener('pointerup', onBarPointerUp)
  }

  // ============== tab 拖出手势（HTML5 DnD） ==============
  let dragTabId = ''
  function onTabDragStart(tab: TermTab, e: DragEvent): void {
    dragTabId = tab.id
    // Firefox 需要 setData 才会真正进入拖拽态
    e.dataTransfer?.setData('application/x-sc-terminal-tab', tab.id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }
  function onTabDragEnd(tab: TermTab, e: DragEvent, outsideStrip: boolean): void {
    const id = dragTabId
    dragTabId = ''
    if (!id || id !== tab.id) return
    // dropEffect 'none' = 未落在任何合法目标；再要求落点在 tab 条外——
    // 拖回条上松手 / Esc 取消（悬在条上）都视为放弃，不弹窗
    if (e.dataTransfer && e.dataTransfer.dropEffect !== 'none') return
    if (!outsideStrip) return
    floatTab(tab, { x: e.clientX, y: e.clientY })
  }

  // tab 关闭后清理浮动状态（terminals.changed 对账关闭的 tab 同样覆盖）
  watch(() => tabs.value.map(t => t.id).join(','), () => {
    const alive = new Set(tabs.value.map(t => t.id))
    for (const id of [...floatMap.keys()]) {
      if (!alive.has(id)) dockBack(id)
    }
  })

  return {
    floatMap,
    floatingIds,
    isFloating,
    zOf,
    bringToFront,
    floatTab,
    dockBack,
    setGeometry,
    startBarDrag,
    onTabDragStart,
    onTabDragEnd,
  }
}
