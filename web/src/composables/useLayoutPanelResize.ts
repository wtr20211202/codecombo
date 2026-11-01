import type { Ref } from 'vue'
import { useLayoutLockStore } from '../stores/layoutLock'

/**
 * 底部面板高度拖拽（自 Layout.vue 抽出）。
 * 「在终端中打开」的目录直达动作在 useLayoutViews.openInTerminal（P-20261005-192
 * 起为目录级真实创建链）——本组合式曾有的 cd 注入副本无调用方，已随语义升级移除。
 */
export function useLayoutPanelResize(options: {
  bottomPanelHeight: Ref<number>
}) {
  const { bottomPanelHeight } = options

  // 拖拽调整底部面板高度
  let resizingBottom = false
  function startBottomResize(e: MouseEvent) {
    // 布局锁定（P-20261003-180）：拖拽类交互统一短路，点击/键盘不受影响
    if (useLayoutLockStore().interceptDrag(e)) return
    e.preventDefault()
    resizingBottom = true
    const root = document.querySelector('.ide-root')
    if (root) root.classList.add('resizing-vertical')
    const startY = e.clientY
    const startHeight = bottomPanelHeight.value
    function onMove(ev: MouseEvent) {
      if (!resizingBottom) return
      const delta = startY - ev.clientY
      bottomPanelHeight.value = Math.max(120, Math.min(600, startHeight + delta))
    }
    function onUp() {
      resizingBottom = false
      if (root) root.classList.remove('resizing-vertical')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return { startBottomResize }
}
