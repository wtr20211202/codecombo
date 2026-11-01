import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import type { TermInstance } from './useTerminalInstances'

// ============== 文件拖拽 ==============
// 两类拖入：
// 1. 浏览器外部文件（types 含 Files）——拿不到绝对路径，把 file.name 列表
//    写入终端作为占位符，提示用户检查路径
// 2. 本系统文件树的内部路径拖拽（types 含 application/x-sc-file-path）——
//    drop = 把路径原样粘贴到「该 pane」的终端（跨 pane/跨 tab 互传）
const SC_PATH_TYPE = 'application/x-sc-file-path'

export interface UseTerminalDndParams {
  termInstances: Map<string, TermInstance>
  getActiveTabId: () => string
}

export function useTerminalDnd(params: UseTerminalDndParams) {
  const { termInstances, getActiveTabId } = params
  const message = useMessage()
  const { t } = useI18n()

  const dragOverActive = ref(false)
  const dragOverFileCount = ref(0)
  const dragOverIsPath = ref(false)
  let dragOverTimer: ReturnType<typeof setTimeout> | null = null

  function onTerminalDragOver(e: DragEvent): void {
    if (!e.dataTransfer) return
    const types = Array.from(e.dataTransfer.types || [])
    // 仅当外部文件或内部路径拖入才显示提示（避免内部元素拖拽误触）
    const hasFiles = types.includes('Files')
    const hasPath = types.includes(SC_PATH_TYPE)
    if (!hasFiles && !hasPath) return
    e.preventDefault()
    dragOverActive.value = true
    dragOverIsPath.value = hasPath
    dragOverFileCount.value = hasPath ? 1 : e.dataTransfer.items?.length || 0
    // dragleave 在子元素之间频繁触发，用 timer 兜底
    if (dragOverTimer) clearTimeout(dragOverTimer)
  }

  function onTerminalDragLeave(e: DragEvent): void {
    // 仅当离开整个终端区域（relatedTarget 为 null 或不在该 div 内）时才隐藏
    const related = e.relatedTarget as Node | null
    if (related) {
      const container = e.currentTarget as HTMLElement
      if (container.contains(related)) return
    }
    if (dragOverTimer) clearTimeout(dragOverTimer)
    dragOverTimer = setTimeout(() => {
      dragOverActive.value = false
    }, 50)
  }

  function onTerminalDrop(e: DragEvent): void {
    e.preventDefault()
    dragOverActive.value = false
    if (dragOverTimer) clearTimeout(dragOverTimer)
    if (!e.dataTransfer) return

    const inst = termInstances.get(getActiveTabId())
    if (!inst) return

    // 内部路径拖拽：把路径粘贴到本 pane（不执行，等同粘贴文本）
    const path = e.dataTransfer.getData(SC_PATH_TYPE)
    if (path) {
      inst.term.paste(path)
      inst.term.focus()
      return
    }

    // 外部文件：把文件名列表写入当前活动终端（多个用空格分隔）
    // 浏览器拿不到绝对路径——用 file.name 作为占位符，提示用户手动补完路径
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length === 0) return

    const names = files.map((f) => f.name)
    const text = names.join(' ')
    inst.term.paste(text)
    inst.term.focus()
    message.info(t('terminal.dropFilesHint', { n: files.length }))
  }

  return {
    dragOverActive,
    dragOverFileCount,
    dragOverIsPath,
    onTerminalDragOver,
    onTerminalDragLeave,
    onTerminalDrop,
  }
}
