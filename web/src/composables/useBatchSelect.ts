import { ref, watch, type Ref } from 'vue'

/**
 * 列表多选批量操作的选择状态机（P-20261003-281 通知中心抽件；
 * P-20261005-175 起泛型化共享——回收站 TrashModal 同款复选框行选+全选）。
 *
 * 设计要点：
 * - 选中集按「条目 id」记账，与分组/过滤正交——分组是视图聚合（组行的勾选态 =
 *   全体成员聚合），过滤页签切换不清空选择（checkbox 模式惯例：跨视图续选）；
 * - 条目被移除（单条清除/批量删除/清空/实例切换）时按 items 整表对账剪除失联
 *   id——批量条计数与列表所见一致，删除动作不引用已消失的条目；
 * - active 置 false（手动退出多选/面板关闭）即清空选择：多选是临时态，
 *   不跨面板开合残留。
 *
 * 纯状态机不涉 API/文案：批量动作的执行留在组件层（store 调用 +
 * 确认弹窗 + toast），本 composable 只管「谁被选中」。
 */
export function useBatchSelect<T extends { id: string }>(
  items: Ref<T[]>,
  active: Ref<boolean>,
) {
  const selectedIds = ref(new Set<string>())

  /** 单条切换（展开的组员行 / 单条组行） */
  function toggle(id: string): void {
    const next = new Set(selectedIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selectedIds.value = next
  }

  /**
   * 批量切换（组行勾选 = 全体成员 / 批量条「全选当前列表」）：ids 全在选中集
   * → 全部移除（取消），否则全部加入（补选）。行级三态由此单向收敛——
   * 部分选中再点一次即全选，与文件管理器/邮件客户端的 checkbox 惯例一致
   */
  function toggleMany(ids: string[]): void {
    if (ids.length === 0) return
    const next = new Set(selectedIds.value)
    const allSelected = ids.every(id => next.has(id))
    if (allSelected) {
      for (const id of ids) next.delete(id)
    } else {
      for (const id of ids) next.add(id)
    }
    selectedIds.value = next
  }

  /** 一组 id 的聚合勾选态：组行/全选框的三态渲染（all=全中 / some=部分 / none=无） */
  function stateOf(ids: string[]): 'all' | 'some' | 'none' {
    if (ids.length === 0) return 'none'
    let hit = 0
    for (const id of ids) if (selectedIds.value.has(id)) hit++
    if (hit === 0) return 'none'
    return hit === ids.length ? 'all' : 'some'
  }

  function isSelected(id: string): boolean {
    return selectedIds.value.has(id)
  }

  // 条目移除即对账剪除（items 整表替换为触发时机：dismiss/dismissMany/clear/
  // loadHistory/实例切换/回收站 restore+purge 后重拉；≤500 条上限 O(n) 扫描，
  // 非热路径）
  watch(items, (list) => {
    if (selectedIds.value.size === 0) return
    const live = new Set(list.map(n => n.id))
    const kept = [...selectedIds.value].filter(id => live.has(id))
    if (kept.length !== selectedIds.value.size) selectedIds.value = new Set(kept)
  })

  // 退出多选模式（手动/面板关闭）即清空——选中集不跨模式残留
  watch(active, (on) => {
    if (!on) selectedIds.value = new Set()
  })

  return { selectedIds, toggle, toggleMany, stateOf, isSelected }
}
