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
 * P-20261111-1-S2：组头窄行落点外扩到整段组区（onDragOver*Section 系列挂组段
 * 容器）——组内行/空白也认，消灭「拖拽掠过无反馈无落点」的体感死区；drop 与
 * 组头落点共用同一出口函数，语义不新增。
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
    const src = dragSource.value
    // 只认本区两种源（S2 对齐组段整区条件；此前放行 project-* 源 hover 出
    // 一个 drop 无动作的死落点）
    if (src?.kind !== 'group' && src?.kind !== 'session') return
    e.preventDefault()
    dragOverKey.value = `group:${groupId}`
  }
  function onDragOverRootHead(e: DragEvent) {
    if (dragSource.value?.kind !== 'session') return
    e.preventDefault()
    dragOverKey.value = '__root__'
  }
  // ============== 组段整区落点（P-20261111-1-S2） ==============
  // 挂在组段容器（.ats-section）上的 dragover 兜底：事件从内层行/组头冒泡上来，
  // 内层落点已在目标层 preventDefault 认领时让位（e.defaultPrevented 判据，
  // 细粒度语义优先）；内层拒绝（组源掠过会话行、会话源自掠等）由组段承接，
  // 拖拽掠过组区不再出现「无反馈无落点」死区。drop 复用组头落点出口函数，
  // 模板直接挂 onDropGroupHead/onDropRootHead/onDropProjectGroupHead。
  /** 自定义组段整区 dragover：组源=移到目标组之前、会话源=移入该组（与组头
   *  落点同语义同键，仅承接面扩到整段） */
  function onDragOverGroupSection(groupId: string, e: DragEvent) {
    if (e.defaultPrevented) return
    const src = dragSource.value
    if (src?.kind !== 'group' && src?.kind !== 'session') return
    e.preventDefault()
    dragOverKey.value = `group:${groupId}`
  }
  /** 未分组段整区 dragover：会话源=归根（未分组行不是合法插入落点——序随
   *  排序模式不持久化——故行层恒拒绝，整区承接即全部落点） */
  function onDragOverRootSection(e: DragEvent) {
    if (e.defaultPrevented) return
    if (dragSource.value?.kind !== 'session') return
    e.preventDefault()
    dragOverKey.value = '__root__'
  }
  /** 项目组段整区 dragover：组源=组序、项目会话源=移入该组（与项目组头落点
   *  同条件同键；跨项目会话的归属拒绝留给 drop 判定——组头落点既有口径） */
  function onDragOverProjectGroupSection(projectId: string, e: DragEvent) {
    if (e.defaultPrevented) return
    const src = dragSource.value
    if (src?.kind !== 'project-group' && src?.kind !== 'project-session') return
    e.preventDefault()
    dragOverKey.value = `pgroup:${projectId}`
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
  // drop 契约（S2）：认领即先 endDrop 再 emit（冒泡到外层组段落点时源已空，
  // 幂等无害）；不认领（非本区语义源/无解落点）则不吞拖拽态直接 return——
  // 事件继续冒泡给组段落点兜底（组源落在会话行上须经此到达组段出口重排序，
  // 旧实现在行层无条件 endDrop 会把这类 drop 吞成无动作），拖拽态最终由
  // dragend（onDragEnd）兜底清理
  function onDropGroupHead(groupId: string) {
    const src = dragSource.value
    if (!src) return
    if (src.kind !== 'group' && src.kind !== 'session') return
    endDrop()
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
    } else {
      emit('move-session', { sessionId: src.sessionId, toGroupId: groupId })
    }
  }
  function onDropRootHead() {
    const src = dragSource.value
    if (src?.kind !== 'session') return
    endDrop()
    emit('move-session', { sessionId: src.sessionId, toGroupId: '__root__' })
  }
  function onDropSessionItem(target: AgentTermSession) {
    const src = dragSource.value
    if (src?.kind !== 'session') return
    // 自拖自落：吞掉但无动作（旧行为）——放行冒泡会变成「移到自己组尾」伪移动
    if (src.sessionId === target.id) {
      endDrop()
      return
    }
    const toGroup = props.groups.find(g => g.sessionIds.includes(target.id))
    // 目标行不在组内（未分组行）：组内插入语义不成立，不吞源——冒泡给未分组
    // 段落点承接为「归根移动」
    if (!toGroup) return
    endDrop()
    const ordered = toGroup.sessionIds.filter(id => id !== src.sessionId)
    const at = ordered.indexOf(target.id)
    ordered.splice(at < 0 ? ordered.length : at, 0, src.sessionId)
    emit('reorder-group-sessions', { groupId: toGroup.id, orderedIds: ordered })
  }
  /** 项目分组头落点：组头拖组 = 组序；会话落到组头 = 该组会话移到组内末尾 */
  function onDropProjectGroupHead(projectId: string) {
    const src = dragSource.value
    if (!src) return
    if (src.kind !== 'project-group' && src.kind !== 'project-session') return
    endDrop()
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
    // project-session
    if (src.projectId !== projectId) return
    const groups = props.projectGroups
    const g = groups.find(gg => gg.projectId === projectId)
    if (!g) return
    const ordered = g.sessions.map(s => s.id).filter(id => id !== src.sessionId)
    ordered.push(src.sessionId)
    emit('reorder-project-sessions', { projectId, orderedIds: ordered })
  }
  /** 项目会话条目落点：同项目内插到目标会话之前 */
  function onDropProjectSessionItem(target: { id: string }, projectId: string) {
    const src = dragSource.value
    if (src?.kind !== 'project-session' || src.sessionId === target.id || src.projectId !== projectId) return
    const groups = props.projectGroups
    const g = groups.find(gg => gg.projectId === projectId)
    if (!g) return
    endDrop()
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
    onDragOverGroupSection, onDragOverRootSection, onDragOverProjectGroupSection,
    onDragOverProjectGroupHead, onDragOverProjectSessionItem,
    onDropGroupHead, onDropRootHead, onDropSessionItem,
    onDropProjectGroupHead, onDropProjectSessionItem,
    onDragEnd,
  }
}
