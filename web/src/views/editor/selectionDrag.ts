import type * as monaco from 'monaco-editor'
import type { useI18n } from '../../composables/useI18n'
import {
  SELECTION_DRAG_DROP_EVENT,
  SELECTION_DRAG_SPRING_EVENT,
  type EditorSelectionDragPayload,
} from '../../utils/selectionDrag'

/**
 * 编辑器选区 Alt+拖拽源（P-20261003-162）。
 *
 * 为什么不用 HTML5 DnD：Monaco 的选区拖拽是自绘 pointer 流，不产生浏览器
 * dragstart；且 Monaco 自身在 altKey 下不启动内部拖放（mouseHandler.start
 * 的 `!this._mouseState.altKey` 分支）——Alt 恰好让出这条手势。源侧在
 * mousedown 捕获阶段（容器 DOM，Monaco 监听之前）接管并全程 preventDefault/
 * stopPropagation，之后用 window 级 mousemove/mouseup 自绘拖影——编辑器随
 * spring-open 变为 display:none 后 pointer 流仍继续（不依赖被拖元素存活）。
 *
 * 落点协议（跨窗格零组件耦合）：
 * - `[data-sc-selection-drop="<target>"]`：mouseup 命中 → 派发
 *   SELECTION_DRAG_DROP_EVENT（target + 载荷）；未命中 = 落空取消，零副作用
 * - `[data-sc-selection-spring="<panelId>"]`：悬停 400ms → 派发
 *   SELECTION_DRAG_SPRING_EVENT（ActivityBar 据此展开对应主区视图，编辑器与
 *   agent docked 管理页互斥时唯一可达侧栏的路径）
 *
 * 菜单/键盘路径（P-122 右键询问）不受影响：只拦截「Alt + 左键 + 按在已有
 * 选区内部」这一组合。代价是 Alt+点选区内部不再增光标（吞掉该次点击），
 * 这是 Alt+拖手势的既定取舍（真机手感留人工验收）。
 */

const MOVE_THRESHOLD = 4
const SPRING_OPEN_MS = 400
/** 拖影宽高上限（仅用于把浮层夹回视口；实际尺寸由 CSS max-width 约束） */
const GHOST_EST_W = 320
const GHOST_EST_H = 52

const HOVER_CLASS = 'sc-selection-drop-hover'
const BODY_CLASS = 'sc-selection-dragging'

export interface EditorSelectionDragDeps {
  /** 编辑器容器（mousedown 捕获面；Monaco DOM 的子集） */
  container: HTMLElement
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null
  getPath: () => string
  /** 远程伪路径/未命名草稿/无项目不提供（菜单域同口径守卫） */
  canDrag: () => boolean
  t: ReturnType<typeof useI18n>['t']
}

interface PendingDrag {
  x: number
  y: number
  payload: EditorSelectionDragPayload
}

export interface EditorSelectionDragHandle {
  dispose: () => void
}

export function attachEditorSelectionDrag(deps: EditorSelectionDragDeps): EditorSelectionDragHandle {
  const { container, getEditor, getPath, canDrag, t } = deps
  let pending: PendingDrag | null = null
  let ghost: HTMLDivElement | null = null
  let active = false
  let hoverEl: HTMLElement | null = null
  let springEl: HTMLElement | null = null
  let springTimer: ReturnType<typeof setTimeout> | null = null
  let sprungId = ''

  function clearSpringTimer(): void {
    if (springTimer) {
      clearTimeout(springTimer)
      springTimer = null
    }
  }

  function setHover(el: HTMLElement | null): void {
    if (hoverEl === el) return
    hoverEl?.classList.remove(HOVER_CLASS)
    hoverEl = el
    hoverEl?.classList.add(HOVER_CLASS)
  }

  /** spring 悬停计时：同一 id 只触发一次（展开后指针仍停在按钮上不重复派发） */
  function updateSpring(el: HTMLElement | null): void {
    const id = el?.getAttribute('data-sc-selection-spring') || ''
    if (id === sprungId) return
    if (el === springEl) return
    clearSpringTimer()
    springEl = el
    if (!id) {
      sprungId = ''
      return
    }
    springTimer = setTimeout(() => {
      springTimer = null
      sprungId = id
      window.dispatchEvent(new CustomEvent(SELECTION_DRAG_SPRING_EVENT, { detail: { id } }))
    }, SPRING_OPEN_MS)
  }

  function createGhost(payload: EditorSelectionDragPayload): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'sc-selection-drag-ghost'
    el.setAttribute('aria-hidden', 'true')
    const title = document.createElement('div')
    title.className = 'sc-selection-drag-ghost-title'
    const path = payload.path.replace(/\\/g, '/')
    title.textContent = payload.startLine === payload.endLine
      ? t('editor.selectionDrag.ghostLine', { path, line: payload.startLine })
      : t('editor.selectionDrag.ghostRange', { path, start: payload.startLine, end: payload.endLine })
    const hint = document.createElement('div')
    hint.className = 'sc-selection-drag-ghost-hint'
    hint.textContent = t('editor.selectionDrag.ghostHint')
    el.appendChild(title)
    el.appendChild(hint)
    document.body.appendChild(el)
    return el
  }

  function moveGhost(x: number, y: number): void {
    if (!ghost) return
    const left = Math.max(4, Math.min(x + 14, window.innerWidth - GHOST_EST_W - 8))
    const top = Math.max(4, Math.min(y + 12, window.innerHeight - GHOST_EST_H - 8))
    ghost.style.transform = `translate3d(${left}px, ${top}px, 0)`
  }

  /** 命中当前指针下的落点/spring 元素（ghost 已 pointer-events:none，不挡命中） */
  function hitTest(x: number, y: number): { drop: HTMLElement | null; spring: HTMLElement | null } {
    const under = document.elementFromPoint(x, y) as HTMLElement | null
    return {
      drop: (under?.closest('[data-sc-selection-drop]') as HTMLElement | null) ?? null,
      spring: (under?.closest('[data-sc-selection-spring]') as HTMLElement | null) ?? null,
    }
  }

  function cleanup(): void {
    window.removeEventListener('mousemove', onWindowMouseMove, true)
    window.removeEventListener('mouseup', onWindowMouseUp, true)
    window.removeEventListener('keydown', onWindowKeyDown, true)
    window.removeEventListener('blur', onWindowBlur)
    clearSpringTimer()
    springEl = null
    sprungId = ''
    setHover(null)
    ghost?.remove()
    ghost = null
    document.body.classList.remove(BODY_CLASS)
    document.body.style.cursor = ''
    pending = null
    active = false
  }

  function onWindowMouseMove(e: MouseEvent): void {
    if (e.buttons === 0) {
      // 在窗口外松开（没收到 mouseup）或按键态丢失：取消，防幽灵拖影滞留
      cleanup()
      return
    }
    if (!pending) return
    if (!active) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < MOVE_THRESHOLD) return
      active = true
      ghost = createGhost(pending.payload)
      document.body.classList.add(BODY_CLASS)
      document.body.style.cursor = 'copy'
    }
    moveGhost(e.clientX, e.clientY)
    const { drop, spring } = hitTest(e.clientX, e.clientY)
    setHover(drop ?? spring)
    updateSpring(spring)
  }

  function onWindowMouseUp(e: MouseEvent): void {
    if (!pending) return
    const payload = pending.payload
    const wasActive = active
    let target = ''
    if (wasActive) {
      const { drop } = hitTest(e.clientX, e.clientY)
      target = drop?.getAttribute('data-sc-selection-drop') || ''
    }
    cleanup()
    // 落空（无 data-sc-selection-drop 命中）= 取消：不派发任何事件
    if (wasActive && target) {
      window.dispatchEvent(new CustomEvent(SELECTION_DRAG_DROP_EVENT, {
        detail: { target, selection: payload },
      }))
    }
  }

  function onWindowKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') cleanup()
  }

  function onWindowBlur(): void {
    cleanup()
  }

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || !e.altKey || pending) return
    if (!canDrag()) return
    const editor = getEditor()
    const model = editor?.getModel()
    const selection = editor?.getSelection()
    if (!editor || !model || !selection || selection.isEmpty()) return
    // 仅当按点落在选区内部（与 Monaco 内部拖放的起手判定同语义）才接管
    const target = editor.getTargetAtClientPoint(e.clientX, e.clientY)
    if (!target?.position || !selection.containsPosition(target.position)) return
    const path = getPath()
    if (!path) return
    const text = model.getValueInRange(selection)
    if (!text.trim()) return
    // 吞掉 Monaco 的 mousedown（否则 altKey 会走多光标加光标/选区重算），
    // 后续 pointer 流由 window 级监听自绘——编辑器中途被 v-show 隐藏也不中断
    e.preventDefault()
    e.stopPropagation()
    pending = {
      x: e.clientX,
      y: e.clientY,
      payload: { path, text, startLine: selection.startLineNumber, endLine: selection.endLineNumber },
    }
    window.addEventListener('mousemove', onWindowMouseMove, true)
    window.addEventListener('mouseup', onWindowMouseUp, true)
    window.addEventListener('keydown', onWindowKeyDown, true)
    window.addEventListener('blur', onWindowBlur)
  }

  container.addEventListener('mousedown', onMouseDown, true)

  return {
    dispose() {
      container.removeEventListener('mousedown', onMouseDown, true)
      cleanup()
    },
  }
}
