import type { InjectionKey, Ref } from 'vue'
import type { DragSource } from '../../composables/useAgentSidebarDnd'

/**
 * 侧栏会话树内部共享上下文（P-20261001-20）：
 * 项目分组树子组件（AgentSidebarProjectTree）与宿主（AgentSidebarSessionTree）
 * 共享同一次拖拽会话与内联重命名状态——DnD 的 dragSource 跨列表区全局唯一，
 * 经 provide/inject 下发，避免多事件中继层。
 */
export interface AgentSidebarTreeShared {
  /** 当前拖拽悬停落点高亮键（跨列表区共享同一份） */
  dragOverKey: Ref<string>
  startDrag: (source: DragSource, e: DragEvent) => void
  onDragOverProjectGroupHead: (projectId: string, e: DragEvent) => void
  /** 项目组段整区落点（P-20261111-1-S2）：组头窄行外扩到整段组区的 dragover 兜底 */
  onDragOverProjectGroupSection: (projectId: string, e: DragEvent) => void
  onDragOverProjectSessionItem: (target: { id: string; projectId?: string }, projectId: string, e: DragEvent) => void
  onDropProjectGroupHead: (projectId: string) => void
  onDropProjectSessionItem: (target: { id: string }, projectId: string) => void
  onDragEnd: () => void
  /** 会话双击内联重命名（项目会话与系统会话共用同一编辑态） */
  renamingSessionId: Ref<string>
  renamingSessionName: Ref<string>
  startRenameSession: (id: string, current: string) => void
  confirmRenameSession: () => void
  /** 行 tooltip：基础提示 + 运行时版本（P-20261003-134，有值才显）+ 最近活动
   *  相对时间 + 静默 hover 提示 */
  itemTitle: (id: string, base: string, runtimeVersion?: string) => string
  /** 会话静默弱标文案（P-20261003-53；空串 = 不显示，项目树行同款展示） */
  idleBadge: (id: string) => string
  /** 会话静默 hover 提示文案（P-20261003-198：pending 特化档同 badge 键选择） */
  idleTip: (id: string) => string
  /** 停滞强标在否（P-20261004-37：行内标升级警示档 + 可点开分诊卡的判定位） */
  isStallBadge: (id: string) => boolean
  /** 停滞标点击（开分诊卡；弱标不拦截——冒泡回行的既有选中语义） */
  onIdleBadgeClick: (id: string, e: MouseEvent) => void
}

export const sidebarTreeSharedKey: InjectionKey<AgentSidebarTreeShared> = Symbol('agent-sidebar-tree-shared')
