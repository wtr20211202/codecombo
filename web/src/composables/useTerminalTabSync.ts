import { onBeforeUnmount, onMounted } from 'vue'
import type { Ref } from 'vue'
import type { TermTab } from './useTerminalTabs'
import { OPS_TERMINALS_CHANGED } from '../utils/opsEvents'

/** terminals.changed 广播快照项（与后端 sessionSnapshot 字段对齐） */
interface TerminalsChangedItem {
  id?: string
  name?: string
  projectId?: string
  kind?: string
  /** 服务端前台探测事实源（字段缺省 = 后端无法判定，保持本地状态不覆盖） */
  running?: boolean
}

/**
 * 底部终端 tab 与统一会话源的实时对账（P1）：
 * 订阅 ops 通道 terminals.changed 快照（后端在 create/close/rename 后广播），
 * 让终端会话管理页等「他处」的会话操作同步到本地 tab：
 * - 快照有、本地无 → 追加 tab（不激活：不打断当前工作；agent 会话宿主是管理页，不进底部 tab）
 * - 本地有、快照无 → 静默移除（远端已关，如管理页结束会话），必要时让渡激活 tab
 * - 两边都有 → tab 名跟随服务端（管理页重命名即跟）
 * 对自身操作同样到达（closeTerminal 已删 tab → 幂等跳过）。
 */
export function useTerminalTabSync(params: {
  tabs: Ref<TermTab[]>
  activeTabId: Ref<string>
}) {
  const { tabs, activeTabId } = params

  function reconcile(list: TerminalsChangedItem[]) {
    const snapshotIds = new Set(list.map(s => s.id).filter((id): id is string => !!id))

    // 本地有、快照无 → 远端已关：静默移除并让渡激活 tab
    for (let i = tabs.value.length - 1; i >= 0; i--) {
      const tab = tabs.value[i]!
      if (snapshotIds.has(tab.id)) continue
      tabs.value.splice(i, 1)
      if (activeTabId.value === tab.id) {
        const sibling = tabs.value.filter(t => t.projectId === tab.projectId)
        activeTabId.value = sibling.length > 0 ? sibling[sibling.length - 1]!.id : ''
      }
    }

    // 快照有：新会话追加 tab / 已有会话名字与运行状态跟随。
    // pane 会话（split 的 secondary）不是 tab：跳过追加，否则产生幽灵 tab，
    // 同一会话双 TerminalPane 抢占同一 xterm 实例
    const paneIds = new Set(tabs.value.flatMap(t => t.panes ?? []))
    for (const s of list) {
      if (!s.id || s.kind !== 'shell') continue
      const tab = tabs.value.find(t => t.id === s.id)
      if (tab) {
        if (s.name && tab.name !== s.name) tab.name = s.name
        // 服务端前台探测为事实源：字段缺省（后端无法判定）时保持本地状态
        if (typeof s.running === 'boolean') tab.running = s.running
      } else if (!paneIds.has(s.id)) {
        const tab: TermTab = { id: s.id, name: s.name || 'Terminal', projectId: s.projectId || '' }
        if (typeof s.running === 'boolean') tab.running = s.running
        tabs.value.push(tab)
      }
    }
  }

  function onTerminalsChanged(e: Event) {
    const payload = (e as CustomEvent<{ sessions?: TerminalsChangedItem[] }>).detail
    if (Array.isArray(payload?.sessions)) reconcile(payload.sessions)
  }

  onMounted(() => window.addEventListener(OPS_TERMINALS_CHANGED, onTerminalsChanged))
  onBeforeUnmount(() => window.removeEventListener(OPS_TERMINALS_CHANGED, onTerminalsChanged))
}
