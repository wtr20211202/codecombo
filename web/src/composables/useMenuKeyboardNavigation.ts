import { onMounted } from 'vue'
import type { Ref } from 'vue'

/**
 * 自绘右键菜单的键盘导航（P-20261004-69）。term-context 家族（TerminalTabContextMenu /
 * TerminalPaneContextMenu）共用，防两处实现复制漂移：
 *   - ↑↓ 环绕移焦（真 DOM focus，焦点环沿 base.css 全局 :focus-visible token）
 *   - Home/End 首尾直达；Esc 关闭（截断冒泡，不外泄给 document 级 Esc 链）
 *   - Enter/Space 激活走原生 button 语义，本 composable 不拦截
 *   - 禁用项跳过导航（ disabled 项不进环形序列，视觉置灰与键盘可达一致）
 *
 * 菜单本身不持有高亮态：焦点即选项——屏幕阅读器 / 焦点环 / 激活目标三者天然同源。
 */
export function useMenuKeyboardNavigation(options: {
  /** 菜单根元素（.term-context-menu）；导航条目=其后代 .term-context-item */
  menuRef: Ref<HTMLElement | null>
  /** Esc 关闭回调（菜单开合状态归属宿主，组件只 emit） */
  close: () => void
}) {
  const { menuRef, close } = options

  /** 可导航条目（非 disabled 的 .term-context-item，按 DOM 序） */
  function navItems(): HTMLButtonElement[] {
    const menu = menuRef.value
    if (!menu) return []
    return Array.from(menu.querySelectorAll<HTMLButtonElement>('.term-context-item')).filter(
      el => !el.disabled,
    )
  }

  // 打开即聚焦首项：Menu 键/Shift+F10/右键打开后 ↑↓ 立即可用（菜单即入键盘语境）。
  // 两宿主均 v-if 每次打开重新挂载，onMounted 恰好每次打开各跑一次。
  // 右键（指针）打开也聚焦：焦点环走 :focus-visible 键盘启发式——指针语境不显环、
  // 用户按下方向键后显环，指针/键盘两语境互不打扰。
  onMounted(() => {
    navItems()[0]?.focus()
  })

  /** 环绕移焦：↑↓ 越过首尾回绕；焦点不在任何条目上时按方向落首/尾（防御式兜底） */
  function move(delta: 1 | -1): void {
    const items = navItems()
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = current === -1 ? (delta === 1 ? 0 : items.length - 1) : (current + delta + items.length) % items.length
    items[next]?.focus()
  }

  /**
   * 绑定在菜单根上的 @keydown。已处理键一律 preventDefault + stopPropagation：
   * 菜单 teleport 在 body 下，不截断会漏到 document 级处理器（useLayoutKeyboard 的
   * Esc 逐层退出链会「边关菜单边退最大化/浮层」，全局语义被菜单误消费）。
   * 带 ctrl/meta/alt 的组合键放行给浏览器/OS（菜单内不劫持系统快捷键）。
   */
  function onMenuKeydown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      move(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      e.stopPropagation()
      const items = navItems()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      const items = navItems()
      items[items.length - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  return { onMenuKeydown }
}
