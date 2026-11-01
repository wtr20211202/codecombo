import type { useI18n } from '../composables/useI18n'

/**
 * 编辑器选区 → agent 侧栏拖拽（P-20261003-162）的共享模型：
 * 拖拽源（MonacoEditor，views/editor/selectionDrag）与落点消费方
 * （AgentTerminalView / ActivityBar）只在此约定载荷形状、事件名与文本拼装，
 * 不互相 import 组件/组合式，跨窗格解耦。
 *
 * 手势 = Alt+拖（Monaco 内部拖拽在 altKey 下不启动、原生拖选也由源侧
 * preventDefault 让位——见 selectionDrag 头注）。落空 = 不发事件，天然取消。
 */

/** 拖拽载荷：path 为项目相对路径（反斜杠在拼装时归一为 /），行为 1-based */
export interface EditorSelectionDragPayload {
  path: string
  text: string
  startLine: number
  endLine: number
}

/** 落点释放（AgentTerminalView 监听）：detail.target 是 data-sc-selection-drop 的值 */
export const SELECTION_DRAG_DROP_EVENT = 'sc-selection-drop'
/** 拖拽悬停 spring-open（ActivityBar 监听）：detail.id 是 data-sc-selection-spring 的值 */
export const SELECTION_DRAG_SPRING_EVENT = 'sc-selection-spring'

/**
 * 选区注入文本：定位头（path+行号）+ 选区原文。
 * 头部与 P-122 询问族同形但语义中性（「来自 … 的选区」）——落点是会话输入框，
 * 不是固定的「请分析」问句，用户可在发送前自行补指令。
 * 路径归一为正斜杠（P-28 跨平台惯例），尾部空白剥除（选区末行残空格不进输入）。
 */
export function buildSelectionDragText(
  payload: EditorSelectionDragPayload,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const path = payload.path.replace(/\\/g, '/')
  const header = payload.startLine === payload.endLine
    ? t('editor.selectionDrag.headerLine', { path, line: payload.startLine })
    : t('editor.selectionDrag.headerRange', { path, start: payload.startLine, end: payload.endLine })
  return `${header}\n${payload.text.replace(/\s+$/, '')}`
}

/**
 * 会话未启用括号粘贴（DEC 2004）时的降级：PTY 会把文本中的换行当 Enter 立即
 * 执行，违反「只追加不自动发送」。压成单行（换行/连续空白折叠为空格）后
 * 写入输入行，等用户自己按 Enter。括号粘贴可用时保留原文多行。
 */
export function flattenSelectionForPaste(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}
