import { useSidebarWidth } from './useSidebarWidth'

/**
 * 智能体终端 docked 侧栏宽度拖拽（P-20261001-20 拆出；P-20261106-5 起为
 * useSidebarWidth 泛化实现的薄包装）：160-480px，localStorage 持久化。
 * 记忆键 sc.agentTerminal.sidebarWidth 为存量键，原样沿用不迁移；对外 API
 * （sidebarWidth/sideResizing/loadSidebarWidth/onSidebarResizeDown/dispose）
 * 与旧实现逐字兼容，宿主 AgentTerminalView 无感。
 */
const SIDEBAR_W_KEY = 'sc.agentTerminal.sidebarWidth'
const SIDEBAR_W_MIN = 160
const SIDEBAR_W_MAX = 480
const SIDEBAR_W_DEFAULT = 260

export function useAgentTerminalSidebarWidth(options: { onResizeEnd?: () => void } = {}) {
  const rz = useSidebarWidth({
    storageKey: SIDEBAR_W_KEY,
    min: SIDEBAR_W_MIN,
    max: SIDEBAR_W_MAX,
    defaultWidth: SIDEBAR_W_DEFAULT,
    onResizeEnd: options.onResizeEnd,
  })
  return {
    sidebarWidth: rz.width,
    sideResizing: rz.resizing,
    loadSidebarWidth: rz.load,
    onSidebarResizeDown: rz.onResizeDown,
    dispose: rz.dispose,
  }
}
