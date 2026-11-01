/**
 * useOpenFiles 域拆分（P-20261003-98）：标签条 UI 交互域——右键菜单定位、
 * 组内拖拽排序、固定/取消固定、溢出检测。纯「tab 条呈现层」状态与动作，
 * 不碰打开集模型（组内增删走 core）。从 useOpenFiles.ts 原地迁出，行为零变化。
 */
import { computed, ref } from 'vue'
import type { OpenFilesCtx, TabOverflowOption } from './context'

export function createTabs(ctx: OpenFilesCtx): void {
  // --- 标签页右键菜单 ---
  const tabContextMenuIndex = ctx.tabContextMenuIndex = ref(-1)
  ctx.tabContextMenuX = ref(0)
  ctx.tabContextMenuY = ref(0)
  const showTabContextMenu = ctx.showTabContextMenu = ref(false)

  ctx.handleTabContextMenu = function handleTabContextMenu(e, idx) {
    e.preventDefault()
    tabContextMenuIndex.value = idx
    ctx.tabContextMenuX.value = e.clientX
    ctx.tabContextMenuY.value = e.clientY
    showTabContextMenu.value = true
  }

  ctx.closeTabContextMenu = function closeTabContextMenu() {
    showTabContextMenu.value = false
  }

  // --- 标签拖拽排序 ---
  const draggedTabIndex = ctx.draggedTabIndex = ref<number | null>(null)

  /** 组内拖拽重排（EditorArea 分组 emit → 宿主转调；兼容入口 onTabDragOver 复用） */
  ctx.reorderGroupTabs = function reorderGroupTabs(gi, from, to) {
    const g = ctx.groupAt(gi)
    const moved = g.files.splice(from, 1)[0]
    if (!moved) return
    g.files.splice(to, 0, moved)
    if (g.activeIndex === from) {
      g.activeIndex = to
    } else {
      let newActive = g.activeIndex
      if (from < g.activeIndex && to >= g.activeIndex) newActive--
      else if (from > g.activeIndex && to <= g.activeIndex) newActive++
      g.activeIndex = newActive
    }
  }

  ctx.onTabDragStart = function onTabDragStart(idx) {
    draggedTabIndex.value = idx
  }
  ctx.onTabDragOver = function onTabDragOver(e, idx) {
    if (draggedTabIndex.value === null || draggedTabIndex.value === idx) return
    e.preventDefault()
    ctx.reorderGroupTabs(ctx.activeGroup.value, draggedTabIndex.value, idx)
    draggedTabIndex.value = idx
  }
  ctx.onTabDragEnd = function onTabDragEnd() {
    draggedTabIndex.value = null
  }

  /** 键盘移动活跃标签（P-20261005-201，Alt+Shift+←/→ 键位）：delta -1 前 /
   *  1 后移一位。组内移动、到头静默停（不环绕、不跨组——跨组是拖拽/
   *  moveTabToGroup 的显式动作），与拖拽重排共用 reorderGroupTabs 一条链
   *  （activeIndex 归位语义一致：被移动的活跃签保持激活） */
  ctx.moveActiveTab = function moveActiveTab(delta) {
    const gi = ctx.activeGroup.value
    const g = ctx.groupAt(gi)
    const to = g.activeIndex + delta
    if (to < 0 || to >= g.files.length) return
    ctx.reorderGroupTabs(gi, g.activeIndex, to)
  }

  // --- 固定/取消固定标签 ---
  ctx.togglePinTabInGroup = function togglePinTabInGroup(gi, idx) {
    const g = ctx.groupAt(gi)
    const file = g.files[idx]
    if (!file) return
    file.pinned = !file.pinned
    if (file.pinned) {
      // 预览 tab 手动固定（右键菜单 pin / 双击）即转正：不再被同类来源替换
      file.isPreview = false
      g.files.splice(idx, 1)
      let insertAt = 0
      while (insertAt < g.files.length && g.files[insertAt]?.pinned) insertAt++
      g.files.splice(insertAt, 0, file)
      if (g.activeIndex === idx) g.activeIndex = insertAt
      else if (idx < g.activeIndex) g.activeIndex--
    }
    ctx.closeTabContextMenu()
  }

  /** 固定/取消固定（兼容入口：作用于活跃组） */
  ctx.togglePinTab = function togglePinTab(idx) {
    ctx.togglePinTabInGroup(ctx.activeGroup.value, idx)
  }

  // --- 标签溢出检测 ---
  ctx.isTabOverflow = ref(false)
  ctx.checkTabOverflow = function checkTabOverflow(el) {
    if (!el) return
    ctx.isTabOverflow.value = el.scrollWidth - el.clientWidth > 4
  }

  ctx.tabOverflowOptions = computed<TabOverflowOption[]>(() =>
    ctx.openFiles.value.map((f, idx) => ({
      label: f.name,
      key: String(idx),
      props: { style: f.pinned ? { fontWeight: 600 } : undefined },
    })),
  )
}
