import { computed, ref } from 'vue'

/**
 * 终端会话的后台 tab 未读活动点域（P-20261003-310，自 terminal-sessions store
 * 拆出，纯搬运零逻辑改动）：输出钩子判「后台」点亮未读，宿主可见登记即清。
 * 由 store setup 调用一次，返回的 refs 并入 store state。
 */
export function useTerminalUnread() {
  /** 各渲染宿主当前可见的会话登记（宿主槽位 → 可见会话 id 列表）：底部项目
   *  终端（活跃 tab + 浮动 tab）/ agent 管理页（docked+float 同 View）各自
   *  上报。输出钩子据此判「后台」——可见会话的输出不点亮未读 */
  const visibleSlots = ref<Record<string, string[]>>({})
  /** 会话 → 是否有未读新输出。一次性布尔（首字节即亮，无计数/频闪——提案
   *  红线），激活/变为可见即清除。渲染面读它：项目 tab / agent 侧栏行 /
   *  悬浮窗 tab 条 */
  const unreadMap = ref<Record<string, boolean>>({})
  /** 当前任意宿主可见的会话集合（computed 缓存：只在登记变化时重算，输出
   *  热路径读 Set 查找零分配） */
  const visibleSessionIds = computed(() => {
    const out = new Set<string>()
    for (const ids of Object.values(visibleSlots.value)) {
      for (const id of ids) out.add(id)
    }
    return out
  })
  /** 宿主上报可见会话（整槽替换；上报即清除这些会话的未读——「激活/变为
   *  可见即清除」的单一收口，激活路径全覆盖：点击/快捷键/跳转/面板重现） */
  function setHostVisible(slot: string, sessionIds: string[]): void {
    visibleSlots.value = { ...visibleSlots.value, [slot]: sessionIds }
    if (sessionIds.some(id => unreadMap.value[id])) {
      const next = { ...unreadMap.value }
      for (const id of sessionIds) delete next[id]
      unreadMap.value = next
    }
  }
  /** 输出钩子入口（useTerminalSession 写入路径调用）：后台会话有新输出即点亮。
   *  已亮早退——高频输出稳态成本一次 Record 查找，零响应式写入 */
  function markUnread(sessionId: string): void {
    if (unreadMap.value[sessionId]) return
    if (visibleSessionIds.value.has(sessionId)) return
    unreadMap.value = { ...unreadMap.value, [sessionId]: true }
  }
  /** 按会话熄灭未读点（P-20261004-68 定向消息）：收件箱被拉取（拉取即读）后
   *  由 terminal.message.read 广播驱动——输出未读点（P-310）只随「宿主可见」
   *  清除，消息未读是服务端已读事实，两条清除路径并存互不覆盖 */
  function clearUnread(sessionId: string): void {
    if (!unreadMap.value[sessionId]) return
    const next = { ...unreadMap.value }
    delete next[sessionId]
    unreadMap.value = next
  }
  /** 会话消亡的本地清理（removeLocal 调用）：未读点摘除 + 可见登记里的死 id
   *  摘除（宿主下次上报会重建） */
  function forgetSessionUnread(id: string): void {
    delete unreadMap.value[id]
    for (const [slot, ids] of Object.entries(visibleSlots.value)) {
      if (ids.includes(id)) visibleSlots.value = { ...visibleSlots.value, [slot]: ids.filter(x => x !== id) }
    }
  }
  /** 对账剪枝（applySnapshot 调用）：存活集之外的未读点与可见登记 id 摘除 */
  function pruneUnreadFor(alive: Set<string>): void {
    for (const id of Object.keys(unreadMap.value)) {
      if (!alive.has(id)) delete unreadMap.value[id]
    }
    for (const [slot, ids] of Object.entries(visibleSlots.value)) {
      const next = ids.filter(x => alive.has(x))
      if (next.length !== ids.length) visibleSlots.value = { ...visibleSlots.value, [slot]: next }
    }
  }
  /** 仅供测试使用：清空未读点与可见登记（用例隔离） */
  function resetUnreadForTest(): void {
    visibleSlots.value = {}
    unreadMap.value = {}
  }

  return {
    visibleSlots,
    unreadMap,
    setHostVisible,
    markUnread,
    clearUnread,
    forgetSessionUnread,
    pruneUnreadFor,
    resetUnreadForTest,
  }
}
