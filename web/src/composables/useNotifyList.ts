import { computed, nextTick, ref, watch, type Ref, type WatchSource } from 'vue'
import type { NotificationItem } from '../api/client'
import { useNotifyScrollReadStore } from '../stores/notifyScrollRead'
import { useNotifyAutoRead } from './useNotifyAutoRead'

/**
 * 通知中心列表域（自 NotificationCenter.vue P-20261007-23 分域拆解迁入）：
 * 同类聚合分组（组行/组员扁平行序）+ 键盘导航激活 + 触屏滑动手势（P-98）+
 * 滚动自动已读（P-260）四块共居一个 composable——四者全部以「扁平行序列
 * （NavRow）」为共同词汇：组聚合产出行序，键盘导航在行序上环绕移动，滑动与
 * 滚动已读按行分发动作。下游 NotificationRow 只做行内呈现。
 *
 * 本域零 Pinia 依赖（store 动作经结构化接口注入；scrollRead 偏好 store 除外
 * ——仅布尔开关位，测试挂空 Pinia 即可），jsdom 直测成本低。
 */
export interface NotifyListStore {
  handleClick(n: NotificationItem): Promise<void> | void
  markRead(id: string): Promise<void> | void
  dismiss(id: string): Promise<void> | void
  showPanel: Ref<boolean>
}

// 同类聚合：type/category/title/body/projectName/action 全同的通知折叠为
// 一组（e2e 反复克隆、重复任务等场景会积累上百条完全相同的「克隆成功」，
// 逐条展示把有效通知淹没）。列表按时间倒序、组代表取最新一条；组可展开
// 逐条操作，也可整组一键清除。非相邻也会合并（中间插一条其它通知不打断）
export interface NotifGroup {
  key: string
  item: NotificationItem
  members: NotificationItem[]
  count: number
  anyUnread: boolean
}
export type NavRow = { kind: 'group'; g: NotifGroup } | { kind: 'member'; m: NotificationItem }

export function useNotifyList(options: {
  store: NotifyListStore
  /** 过滤后的条目流水（useNotifyFilters 产物）——分组的输入底集 */
  filteredItems: Ref<NotificationItem[]>
  /** 面板根元素：键盘导航滚动定位（scrollIntoView）的查询根 */
  rootRef: Ref<HTMLElement | undefined>
  /** 滚动容器：滚动自动已读的 IntersectionObserver root */
  listRef: Ref<HTMLElement | undefined>
  /** 多选模式开关（P-281，组件层持有）：激活语义让位勾选切换 */
  selectMode: Ref<boolean>
  /** 行勾选切换（批量域动作，组件层注入）：多选模式下激活/点击的分发终点 */
  toggleRowSelection: (row: NavRow) => void
  /** 重置键盘焦点到首行的响应源（过滤维/免打扰视图变更） */
  resetOn: WatchSource[]
}) {
  const { store } = options

  const expandedGroups = ref(new Set<string>())
  function groupKey(n: NotificationItem): string {
    // runtime 入键（P-20261003-187）：不同运行时的同文案通知不并组——runtime
    // 是一等过滤维，混合组会让 chip 过滤后组行归属含混；无 runtime 条目空段
    // 聚合行为与既有完全一致
    return [n.type, n.category, n.title, n.body ?? '', n.projectName ?? '', n.runtime ?? '', n.action ? '1' : '0'].join('')
  }
  const groupedItems = computed<NotifGroup[]>(() => {
    const byKey = new Map<string, NotifGroup>()
    for (const n of options.filteredItems.value) {
      const k = groupKey(n)
      const g = byKey.get(k)
      if (g) {
        g.count++
        g.members.push(n)
        if (!n.read) g.anyUnread = true
      } else {
        byKey.set(k, { key: k, item: n, members: [n], count: 1, anyUnread: !n.read })
      }
    }
    return [...byKey.values()]
  })
  function toggleGroup(key: string): void {
    const next = new Set(expandedGroups.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    expandedGroups.value = next
  }

  // 键盘导航：↑↓ 在扁平行序列（组行 + 已展开的组员行）环绕移动，Enter/Space
  // 激活（组展开/动作跳转/无动作标记已读）。监听挂面板根节点并在打开时聚焦，
  // 与大纲浮层/会话选择器的组件级惯例一致；焦点落在面板内按钮上时让位原生 click。
  const activeIdx = ref(0)
  const flatRows = computed<NavRow[]>(() => {
    const rows: NavRow[] = []
    for (const g of groupedItems.value) {
      rows.push({ kind: 'group', g })
      if (g.count > 1 && expandedGroups.value.has(g.key)) {
        for (const m of g.members) rows.push({ kind: 'member', m })
      }
    }
    return rows
  })
  watch(flatRows, (rows) => {
    if (activeIdx.value >= rows.length) activeIdx.value = Math.max(0, rows.length - 1)
  })
  watch([activeIdx, flatRows], () => nextTick(scrollActiveIntoView))
  watch(options.resetOn, () => { activeIdx.value = 0 })
  function scrollActiveIntoView(): void {
    options.rootRef.value
      ?.querySelector(`[data-nav-idx="${activeIdx.value}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }
  /** 面板关闭/批量退出等场景的焦点复位（组件层 watch 调用） */
  function resetActive(): void {
    activeIdx.value = 0
  }
  function activateItem(n: NotificationItem): void {
    if (n.action) { store.handleClick(n); return }
    // 无动作项此前点击毫无反馈、永远无法单条已读（只能整批「全部已读」）：
    // 点击统一收敛为「标记已读」，有动作项保持原跳转 + 已读语义
    if (!n.read) store.markRead(n.id)
  }
  function activateRow(row: NavRow): void {
    // 多选模式下 Enter/Space = 勾选切换（激活语义让位批量选择，同行点击口径）
    if (options.selectMode.value) { options.toggleRowSelection(row); return }
    if (row.kind === 'member') { activateItem(row.m); return }
    if (row.g.count > 1) { toggleGroup(row.g.key); return }
    activateItem(row.g.item)
  }

  // 触屏滑动快捷操作（P-20261002-98）：条目行水平滑动 ≥60px 分发动作——
  // 右滑 = 标已读（未读时）、左滑 = 清除该条（已读才可清，防止横扫误删未读）。
  // 起手 8px 死区内先判主轴：纵向为主让位原生滚动（不触发动作），横向为主才建立
  // 手势；行体跟手位移（clamp ±80px），松手回弹。横向手势在 touchend 上
  // preventDefault——按规范阻断其后合成的 mouse 事件流（含 click），滑动不二次
  // 触发跳转/已读，且不波及之后任何来源的点击；tap（无位移/纵向）不进入该分支，
  // 既有点击语义不变。多条折叠的组行不做手势：点击展开 + 行内按钮（标组已读/
  // 整组清除）已覆盖，整组横扫属批量破坏性动作不宜无确认触发
  const SWIPE_THRESHOLD = 60
  const SWIPE_CLAMP = 80
  const SWIPE_AXIS_DEAD_ZONE = 8
  const swipeRow = ref<{ key: string; touchId: number; startX: number; startY: number; dx: number; axis: 'x' | 'y' | null } | null>(null)

  function rowKey(row: NavRow): string {
    return row.kind === 'group' ? `g:${row.g.key}` : `m:${row.m.id}`
  }

  function swipeDisabled(row: NavRow): boolean {
    return row.kind === 'group' && row.g.count > 1
  }

  function onTouchStart(e: TouchEvent, row: NavRow): void {
    if (swipeDisabled(row) || swipeRow.value) return
    const t = e.changedTouches[0]
    if (!t) return
    swipeRow.value = { key: rowKey(row), touchId: t.identifier, startX: t.clientX, startY: t.clientY, dx: 0, axis: null }
  }

  function onTouchMove(e: TouchEvent, row: NavRow): void {
    const s = swipeRow.value
    if (!s || s.key !== rowKey(row)) return
    const t = findTouch(e, s.touchId)
    if (!t) return
    const dx = t.clientX - s.startX
    const dy = t.clientY - s.startY
    if (s.axis === null) {
      if (Math.abs(dx) < SWIPE_AXIS_DEAD_ZONE && Math.abs(dy) < SWIPE_AXIS_DEAD_ZONE) return
      s.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
    }
    if (s.axis === 'x') s.dx = clampSwipe(dx)
  }

  function onTouchEnd(e: TouchEvent, row: NavRow): void {
    const s = swipeRow.value
    swipeRow.value = null
    if (!s || s.key !== rowKey(row)) return
    const t = findTouch(e, s.touchId)
    if (t) {
      // 少量设备 move 事件缺发：松手时以终点点位补判一次主轴与位移
      const dx = t.clientX - s.startX
      const dy = t.clientY - s.startY
      if (s.axis === null && Math.abs(dx) >= SWIPE_AXIS_DEAD_ZONE && Math.abs(dx) >= Math.abs(dy)) s.axis = 'x'
      if (s.axis === 'x') s.dx = clampSwipe(dx)
    }
    if (s.axis !== 'x') return
    // 阻断 touchend 后的合成 mouse 事件流（含 click）：横向滑动的默认动作即此事件流
    e.preventDefault()
    if (Math.abs(s.dx) >= SWIPE_THRESHOLD) dispatchSwipe(row, s.dx)
  }

  // 触摸被系统接管（列表惯性滚动等）：丢弃进行中的手势，不分发动作
  function onTouchCancel(row: NavRow): void {
    const s = swipeRow.value
    if (s && s.key === rowKey(row)) swipeRow.value = null
  }

  function findTouch(e: TouchEvent, touchId: number): Touch | null {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches.item(i)
      if (t && t.identifier === touchId) return t
    }
    return null
  }

  function clampSwipe(dx: number): number {
    return Math.max(-SWIPE_CLAMP, Math.min(SWIPE_CLAMP, dx))
  }

  function dispatchSwipe(row: NavRow, dx: number): void {
    const item = row.kind === 'member' ? row.m : row.g.count === 1 ? row.g.item : null
    if (!item) return
    if (dx > 0) {
      if (!item.read) store.markRead(item.id)
      return
    }
    if (item.read) store.dismiss(item.id)
  }

  // 手势视觉：行体跟手位移（is-swiping 关过渡跟手，松手靠 .nc-item 过渡回弹）
  function swipeStyle(row: NavRow): string | undefined {
    const s = swipeRow.value
    if (!s || s.key !== rowKey(row) || s.axis !== 'x' || s.dx === 0) return undefined
    return `transform: translateX(${s.dx}px)`
  }
  function isSwiping(row: NavRow): boolean {
    const s = swipeRow.value
    return !!s && s.key === rowKey(row) && s.axis === 'x'
  }

  // 滚动自动已读（P-20261003-260）：开关（默认关，localStorage 偏好）开启时，
  // 滚入列表视口的未读条目自动标已读（Slack「滚过即读」惯例，滚到底即全部）；
  // 关闭时零行为变化。与 Shift+A 批量已读/分界线正交——只产生 markRead 调用，
  // 不动既有清理动作。行→id 的映射复用行上既有的 data-nav-idx 锚（键盘导航
  // 同款）回查 flatRows；组行与整组标记已读同语义展开到未读成员（组行
  // 展示的是全体成员相同的内容，滚过组行视同读过整组）。idsForElement 在
  // observer 回调时点现场评估 read 位：已标过的行再次触发交集自然产出空集。
  // 已读连锁说明：「未读」页签下标读的行会从筛选结果消失、后续行滑入视口继续
  // 被标——开关开启即「浏览清零」语义的预期形态（Slack 打开频道即全读同源）
  const scrollReadStore = useNotifyScrollReadStore()
  function autoReadIdsFor(el: Element): string[] {
    const row = flatRows.value[Number((el as HTMLElement).dataset.navIdx)]
    if (!row) return []
    if (row.kind === 'member') return row.m.read ? [] : [row.m.id]
    const g = row.g
    if (g.count === 1) return g.item.read ? [] : [g.item.id]
    return g.anyUnread ? g.members.filter(m => !m.read).map(m => m.id) : []
  }
  useNotifyAutoRead({
    listRef: options.listRef,
    isActive: () => scrollReadStore.enabled && store.showPanel.value,
    idsForElement: autoReadIdsFor,
    markRead: (id) => { void store.markRead(id) },
    rescanOn: [
      () => flatRows.value,
      () => scrollReadStore.enabled,
      () => store.showPanel.value,
    ],
  })

  return {
    groupedItems, expandedGroups, toggleGroup,
    flatRows, activeIdx, activateItem, activateRow, resetActive, scrollActiveIntoView,
    onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, swipeStyle, isSwiping,
  }
}
