import { ref } from 'vue'
import type { AgentTermSession } from './useAgentTerminal'
import { useLayoutLockStore } from '../stores/layoutLock'

/** 项目分组树节点（AgentTerminalSidebar 与其子组件共享） */
export interface ProjectGroupItem {
  projectId: string
  name: string
  sessions: { id: string; name: string; running: boolean; attached: boolean }[]
}

/**
 * 侧栏拖拽排序/移动（P-20261001-20 从 AgentTerminalSidebar 拆出）：
 * HTML5 DnD；顺序由宿主写入 uiState 持久化。
 * 可拖源：系统会话条目（任意区）+ 自定义分组头 + 项目分组头 + 项目会话条目；
 * 落点：分组头（排序或收会话）、未分组头（会话归根）、组内会话条目（插到其前）、
 * 项目分组头（组序）、项目会话条目（同项目内插到其前）。
 */
export type DragSource =
  | { kind: 'session'; sessionId: string; fromGroupId: string | '__root__' }
  | { kind: 'group'; groupId: string }
  | { kind: 'project-group'; projectId: string }
  | { kind: 'project-session'; sessionId: string; projectId: string }

export interface AgentSidebarDndEmit {
  (e: 'reorder-groups', orderedIds: string[]): void
  (e: 'reorder-group-sessions', payload: { groupId: string; orderedIds: string[] }): void
  (e: 'move-session', payload: { sessionId: string; toGroupId: string | '__root__' }): void
  (e: 'reorder-project-groups', orderedIds: string[]): void
  (e: 'reorder-project-sessions', payload: { projectId: string; orderedIds: string[] }): void
}

export function useAgentSidebarDnd(
  props: {
    groups: { id: string; name: string; sessionIds: string[] }[]
    projectGroups: ProjectGroupItem[]
  },
  emit: AgentSidebarDndEmit,
) {
  const dragSource = ref<DragSource | null>(null)
  const dragOverKey = ref('')

  function startDrag(source: DragSource, e: DragEvent) {
    // 布局锁定（P-20261003-180）：会话/分组重排拖拽统一短路（拖拽不启动），
    // 点击选择不受影响——误拖会静默改写 uiState 持久的分组结构，属锁定保护面
    if (useLayoutLockStore().interceptDrag(e)) return
    dragSource.value = source
    // dataTransfer 必填项：无 setData 的 dragstart 在部分浏览器不启动 DnD
    e.dataTransfer?.setData('text/plain', JSON.stringify(source))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }
  function onDragOverGroupHead(groupId: string, e: DragEvent) {
    if (!dragSource.value) return
    e.preventDefault()
    dragOverKey.value = `group:${groupId}`
  }
  function onDragOverRootHead(e: DragEvent) {
    if (dragSource.value?.kind !== 'session') return
    e.preventDefault()
    dragOverKey.value = '__root__'
  }
  function onDragOverSessionItem(target: AgentTermSession, e: DragEvent) {
    const src = dragSource.value
    // 仅组内会话可作插入落点（未分组序随排序模式，不持久化）
    if (src?.kind !== 'session' || src.sessionId === target.id) return
    if (!props.groups.some(g => g.sessionIds.includes(target.id))) return
    e.preventDefault()
    dragOverKey.value = `session:${target.id}`
  }
  function onDragOverProjectGroupHead(projectId: string, e: DragEvent) {
    if (dragSource.value?.kind !== 'project-group' && dragSource.value?.kind !== 'project-session') return
    e.preventDefault()
    dragOverKey.value = `pgroup:${projectId}`
  }
  function onDragOverProjectSessionItem(target: { id: string; projectId?: string }, projectId: string, e: DragEvent) {
    const src = dragSource.value
    if (src?.kind !== 'project-session' || src.sessionId === target.id) return
    // 会话归属项目固定：仅同项目内提供插入落点
    if (src.projectId !== projectId) return
    e.preventDefault()
    dragOverKey.value = `psession:${target.id}`
  }
  function endDrop() {
    dragSource.value = null
    dragOverKey.value = ''
  }
  function onDropGroupHead(groupId: string) {
    const src = dragSource.value
    endDrop()
    if (!src) return
    if (src.kind === 'group') {
      // 拖组到组上 = 移到目标组之前
      if (src.groupId === groupId) return
      const ids = props.groups.map(g => g.id)
      const from = ids.indexOf(src.groupId)
      if (from < 0) return
      ids.splice(from, 1)
      const to = ids.indexOf(groupId)
      if (to < 0) return
      ids.splice(to, 0, src.groupId)
      emit('reorder-groups', ids)
    } else if (src.kind === 'session') {
      emit('move-session', { sessionId: src.sessionId, toGroupId: groupId })
    }
  }
  function onDropRootHead() {
    const src = dragSource.value
    endDrop()
    if (src?.kind === 'session') emit('move-session', { sessionId: src.sessionId, toGroupId: '__root__' })
  }
  function onDropSessionItem(target: AgentTermSession) {
    const src = dragSource.value
    endDrop()
    if (src?.kind !== 'session' || src.sessionId === target.id) return
    const toGroup = props.groups.find(g => g.sessionIds.includes(target.id))
    if (!toGroup) return
    const ordered = toGroup.sessionIds.filter(id => id !== src.sessionId)
    const at = ordered.indexOf(target.id)
    ordered.splice(at < 0 ? ordered.length : at, 0, src.sessionId)
    emit('reorder-group-sessions', { groupId: toGroup.id, orderedIds: ordered })
  }
  /** 项目分组头落点：组头拖组 = 组序；会话落到组头 = 该组会话移到组内末尾 */
  function onDropProjectGroupHead(projectId: string) {
    const src = dragSource.value
    endDrop()
    if (!src) return
    if (src.kind === 'project-group') {
      if (src.projectId === projectId) return
      const groups = props.projectGroups
      const ids = groups.map(g => g.projectId)
      const from = ids.indexOf(src.projectId)
      if (from < 0) return
      ids.splice(from, 1)
      const to = ids.indexOf(projectId)
      if (to < 0) return
      ids.splice(to, 0, src.projectId)
      emit('reorder-project-groups', ids)
      return
    }
    if (src.kind === 'project-session') {
      if (src.projectId !== projectId) return
      const groups = props.projectGroups
      const g = groups.find(gg => gg.projectId === projectId)
      if (!g) return
      const ordered = g.sessions.map(s => s.id).filter(id => id !== src.sessionId)
      ordered.push(src.sessionId)
      emit('reorder-project-sessions', { projectId, orderedIds: ordered })
    }
  }
  /** 项目会话条目落点：同项目内插到目标会话之前 */
  function onDropProjectSessionItem(target: { id: string }, projectId: string) {
    const src = dragSource.value
    endDrop()
    if (src?.kind !== 'project-session' || src.sessionId === target.id || src.projectId !== projectId) return
    const groups = props.projectGroups
    const g = groups.find(gg => gg.projectId === projectId)
    if (!g) return
    const ordered = g.sessions.map(s => s.id).filter(id => id !== src.sessionId)
    const at = ordered.indexOf(target.id)
    ordered.splice(at < 0 ? ordered.length : at, 0, src.sessionId)
    emit('reorder-project-sessions', { projectId, orderedIds: ordered })
  }
  function onDragEnd() {
    endDrop()
  }

  return {
    dragSource, dragOverKey,
    startDrag,
    onDragOverGroupHead, onDragOverRootHead, onDragOverSessionItem,
    onDragOverProjectGroupHead, onDragOverProjectSessionItem,
    onDropGroupHead, onDropRootHead, onDropSessionItem,
    onDropProjectGroupHead, onDropProjectSessionItem,
    onDragEnd,
  }
}
