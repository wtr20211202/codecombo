/**
 * dsh 控制台子组件共享类型（P-20261001-20 从 DshConsoleView 拆出）。
 */

/** dsh 嵌入目标（本机默认目标 id 为空串；外部目标经目标管理弹窗维护） */
export interface DshTarget {
  id: string
  name: string
  base: string
  token?: string
}
