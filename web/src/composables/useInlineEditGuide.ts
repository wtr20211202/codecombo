import { ref } from 'vue'
import { useAgentTerminal } from './useAgentTerminal'

/**
 * 选区内联 AI 编辑的「无活跃会话」引导信号（P-20261005-206）：编辑器浮层发送
 * 指令时若无活跃 agent 会话，不静默新建（任务书定案——用户保持对会话生命周期的
 * 掌控，且免静默会话的可见性/清理负担）——改为拉起 docked 管理页并打开既有
 * 新建会话对话框、预填结构化指令（「指令暂存」= NewSessionDialog 的
 * prefillPrompt + P-89 草稿链自然承接，用户确认后走对话框既有创建链）。
 *
 * 模块级信号同 useAgentTemplateLaunch 的 templateDialogRequest 范式：对话框
 * 宿主 AgentTerminalView 惰性挂载（宿主 v-if），请求可能先于挂载到达——
 * immediate 消费积压请求 + 模块级消费进度跨 remount 幂等。独立小模块而非并入
 * useEditorInlineEdit：信号两端分属编辑器 chunk（发起端 import monaco）与
 * agent chunk（消费端），合并会让 AgentTerminalView 反向拖入 monaco。
 */

/** 待预填的结构化指令（消费即清，防残留意图污染后续手动打开） */
const pendingPrompt = ref('')
/** 对话框打开请求代数（宿主 watch 源） */
const dialogRequest = ref(0)
/** 已消费代数（模块级，跨 remount 幂等） */
let consumedRequest = 0

/** 打开请求代数（AgentTerminalView 的 watch 源） */
export const inlineEditDialogRequest = dialogRequest

/** 无活跃会话引导出口：拉起 docked 管理页并打开新建对话框、预填指令 */
export function requestSessionDialogWithPrompt(prompt: string): void {
  pendingPrompt.value = prompt
  dialogRequest.value++
  void useAgentTerminal().open('docked')
}

/** 消费一次引导请求：无未消费请求返回 null；有则返回待预填指令 */
export function consumeInlineEditDialogRequest(): string | null {
  if (dialogRequest.value <= consumedRequest) return null
  consumedRequest = dialogRequest.value
  const p = pendingPrompt.value
  pendingPrompt.value = ''
  return p
}
