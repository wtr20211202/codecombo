import { ref } from 'vue'
import type { TermInstance } from './useTerminalInstances'

// 右键菜单动作分发：复制 / 粘贴 / 复制全部 / 导出
// 实际方法实现由 useTerminalClipboard 提供，本 composable 只负责菜单状态 + 调用
export interface UseTerminalContextMenuParams {
  termInstances: Map<string, TermInstance>
  getActiveTabId: () => string
  // 来自 useTerminalClipboard
  copySelection: (tabId: string) => Promise<void>
  // 复制选区为代码块（P-20261003-270；```bash 围栏 + 命令行头。TerminalPane 注入）
  copyAsCodeBlock?: (tabId: string) => void
  paste: (tabId: string) => Promise<void>
  copyAll: (tabId: string) => Promise<void>
  // 复制上一条命令输出（OSC 133 C/D 行号记账区间提取；TerminalPane 注入）
  copyLastOutput?: (tabId: string) => void
  exportText: (tabId: string) => void
  // 清空屏幕 + 重启 shell（TerminalView 注入）
  clearAndRestart?: (tabId: string) => void
  // 刷新：fit 重算行列 + xterm 滚动区 refresh + tmux 权威重绘（治无法上翻/渲染错乱）
  redraw?: (tabId: string) => void
  // 失败命令 AI 分析（TerminalView 注入；菜单项显隐由宿主按「有无失败历史」v-if 控制）
  aiAnalyze?: (tabId: string) => void
  // 分享选中文本为片段短链（P-20261002-71；宿主注入，取选区后开片段弹窗）
  shareSelection?: (tabId: string) => void
  // 发送剪贴板到其他设备（P-20261008-3，P-32 缩范围二阶段兑现；宿主注入
  // useClipRelay.sendLocalClipboard 现成链——动作与终端状态零耦合（发的是整机
  // 剪贴板非选区，不落 pane），签名沿家族 (tabId) 形态宿主忽略实参）
  sendClip?: (tabId: string) => void
  // 询问智能体此输出（P-20261003-7；宿主注入，取选区组装 prompt 经
  // createAgentTerminal 发起。菜单项显隐由宿主经 TerminalPaneContextMenu
  // askable prop 控制——无项目归属的宿主不注入也不展示）
  askAgent?: (tabId: string) => void
  // 失败命令「交给 agent 修」（P-20261003-150；宿主注入，取最近失败命令 + 输出
  // 尾部组装 prompt 经同一发起链路。显隐同 askable 口径，置灰由有无失败记录控制）
  fixWithAgent?: (tabId: string) => void
  // 书签「标记/取消标记此行」（P-20261004-16；宿主注入，行号取右键时刻解析的
  // 缓冲行。宿主未注入时菜单不渲染行级动作项）
  toggleBookmarkLine?: (tabId: string, bufferLine: number) => void
}

export interface ContextMenuAction {
  kind: 'copy' | 'copyAsCodeBlock' | 'paste' | 'copyAll' | 'copyLastOutput' | 'shareSelection' | 'sendClip' | 'askAgent' | 'fixWithAgent' | 'bookmarkLine' | 'export' | 'clearAndRestart' | 'redraw' | 'aiAnalyze'
  tabId: string
}

export function useTerminalContextMenu(params: UseTerminalContextMenuParams) {
  const { getActiveTabId } = params
  const { copySelection, copyAsCodeBlock, paste, copyAll, copyLastOutput, exportText, clearAndRestart, redraw, aiAnalyze, shareSelection, sendClip, askAgent, fixWithAgent, toggleBookmarkLine } = params

  // 右键菜单状态：fixed 定位由 contextmenu 事件的 pageX/pageY 决定
  const showContextMenu = ref(false)
  const contextMenuX = ref(0)
  const contextMenuY = ref(0)
  const contextMenuTabId = ref('')
  // 右键命中的缓冲行（P-20261004-16「标记此行」目标行，右键时刻快照——菜单
  // 打开到点击之间输出可能推进视口，行语义不随后续滚动漂移）；null = 解析失败
  const contextMenuLine = ref<number | null>(null)

  function openContextMenu(tabId: string, event: MouseEvent, bufferLine?: number): void {
    contextMenuTabId.value = tabId
    contextMenuLine.value = bufferLine ?? null
    // 边界保护：菜单宽度约 180px，靠右边缘时左移避免溢出
    const menuWidth = 180
    const maxX = window.innerWidth - menuWidth - 8
    contextMenuX.value = Math.min(event.pageX, maxX)
    contextMenuY.value = event.pageY
    showContextMenu.value = true
  }

  function closeContextMenu(): void {
    showContextMenu.value = false
    contextMenuTabId.value = ''
    contextMenuLine.value = null
  }

  // 菜单动作分发：tabId 优先取右键时记下的，回退到当前 active
  function handleContextMenuAction(action: ContextMenuAction['kind']): void {
    const tabId = contextMenuTabId.value || getActiveTabId()
    const bufferLine = contextMenuLine.value
    closeContextMenu()
    if (!tabId) return
    if (action === 'copy') copySelection(tabId)
    else if (action === 'copyAsCodeBlock') copyAsCodeBlock?.(tabId)
    else if (action === 'paste') paste(tabId)
    else if (action === 'copyAll') copyAll(tabId)
    else if (action === 'copyLastOutput') copyLastOutput?.(tabId)
    else if (action === 'shareSelection') shareSelection?.(tabId)
    else if (action === 'sendClip') sendClip?.(tabId)
    else if (action === 'askAgent') askAgent?.(tabId)
    else if (action === 'fixWithAgent') fixWithAgent?.(tabId)
    else if (action === 'bookmarkLine') {
      // 行号缺席理论不可达（菜单项随 bookmarker 门控渲染），兜底静默
      if (bufferLine !== null) toggleBookmarkLine?.(tabId, bufferLine)
    }
    else if (action === 'export') exportText(tabId)
    else if (action === 'clearAndRestart') clearAndRestart?.(tabId)
    else if (action === 'redraw') redraw?.(tabId)
    else if (action === 'aiAnalyze') aiAnalyze?.(tabId)
  }

  // 全局点击 / 右键监听：点击非菜单区域时关闭右键菜单
  function onGlobalClickCloseMenu(e: MouseEvent): void {
    if (!showContextMenu.value) return
    const target = e.target as HTMLElement | null
    if (target && target.closest('.term-context-menu')) return
    closeContextMenu()
  }

  return {
    showContextMenu,
    contextMenuX,
    contextMenuY,
    contextMenuTabId,
    contextMenuLine,
    openContextMenu,
    closeContextMenu,
    handleContextMenuAction,
    onGlobalClickCloseMenu,
  }
}
