import { ref } from 'vue'
import { useUIStateStore } from '../stores/uiState'
import {
  mergeMonitorCardOrder,
  moveMonitorCard,
  normalizeMonitorCardOrder,
  normalizeMonitorHiddenCards,
} from '../utils/monitorBoardLayout'

/**
 * 值班大屏卡片类目布局状态（P-20261004-18）：顺序 + 显隐 + 编辑模式开关的
 * 薄胶水层（裁决逻辑在 utils/monitorBoardLayout 纯函数，持久化在 uiState
 * monitorBoard 命名空间）。宿主唯一（MonitorView），随组件 setup 创建、
 * 挂载时 restore——不做成模块级单例：/monitor 独立路由每次进入都值得从
 * 服务端取最新布局（其他浏览器标签页可能改过），一次 GET 换取新鲜值。
 *
 * - 编辑模式是会话态不落盘：值守大屏刷新后应回到查看态，不能停留在编辑态
 * - 持久化失败静默（pinia 未激活等环境问题）——会话内仍生效，下次动作重试
 *   （layoutLock.persist / registry.persistRailOrder 同款容错）
 */
export function useMonitorBoardLayout() {
  /** 手动类目全序；null = 未定制（按内置序渲染） */
  const cardOrder = ref<string[] | null>(null)
  /** 隐藏类目 id 集（有序性无意义，落盘为数组） */
  const hiddenCards = ref<string[]>([])
  /** 编辑模式（拖拽重排/显隐管理）——纯会话态，刷新回落查看态 */
  const editMode = ref(false)

  /** 从 uiState 恢复布局（MonitorView 挂载时调用，与 refreshAll 并行不打扰首屏）。
   *  已知类目收敛/去重/空表回落内置序都在 normalize* 纯函数里 */
  async function restore(): Promise<void> {
    try {
      const state = await useUIStateStore().getMonitorBoardLayout()
      cardOrder.value = normalizeMonitorCardOrder(state.cardOrder)
      hiddenCards.value = normalizeMonitorHiddenCards(state.hiddenCards)
    } catch { /* 恢复失败回落默认布局，不打扰大屏 */ }
  }

  /** 落盘当前布局（空手动序落 []，读取端 normalize 视为未定制） */
  function persist(): void {
    try {
      void useUIStateStore().saveMonitorBoardLayout(cardOrder.value ?? [], [...hiddenCards.value])
    } catch { /* silent */ }
  }

  /** 拖拽重排：drag 类目移到 target 之前；无变化 no-op（免空写），有变化即时落盘 */
  function moveCard(dragId: string, targetId: string): boolean {
    const next = moveMonitorCard(mergeMonitorCardOrder(cardOrder.value), dragId, targetId)
    if (!next) return false
    cardOrder.value = next
    persist()
    return true
  }

  /** 类目显隐 toggle：隐藏的类目出现待处理项时仍会临时置顶显示（防漏看护栏） */
  function toggleCardHidden(id: string): void {
    hiddenCards.value = hiddenCards.value.includes(id)
      ? hiddenCards.value.filter(x => x !== id)
      : [...hiddenCards.value, id]
    persist()
  }

  return { cardOrder, hiddenCards, editMode, restore, moveCard, toggleCardHidden }
}
