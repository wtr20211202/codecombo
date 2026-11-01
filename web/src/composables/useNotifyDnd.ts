import { computed, ref, watch } from 'vue'
import { lastEndedDndWindow, type DndInterval, type DndWindow } from '../utils/dndSchedule'
import type { NotificationItem } from '../api/client'

/**
 * 通知中心免打扰域（P-20261003-64；自 NotificationCenter.vue P-20261007-23
 * 分域拆解迁入）：免打扰期间通知静默入站（站内照记），解除后顶部摘要
 * 「免打扰期间新增 N 条」让错过的条目一眼可辨；点击摘要切换「仅显窗口内
 * 条目」的过滤视图。
 *
 * 与过滤域（useNotifyFilters）互为输入：本域的摘要计数按「项目+runtime
 * 过滤后的子集」口径（baseItems 惰性 getter 注入），过滤域的流水线末端再
 * 叠加本域的 dndOnly 过滤视图——两域互引由组件层装配解环。
 *
 * 本域零 Pinia 依赖（prefs 经 getter 注入、store 动作经结构化接口注入），
 * jsdom 直测无需挂载 Pinia。
 */
export interface NotifyDndStore {
  isSnoozed(n: NotificationItem): boolean
}

export function useNotifyDnd(options: {
  /** 条目判定动作（结构化注入，组件传全局 notification store） */
  store: NotifyDndStore
  /** 免打扰时段偏好（组件传 dndStore.prefs；getter 形态随响应式读） */
  prefs: () => DndWindow
  /** 摘要计数底集：项目+runtime 维过滤后的条目流（filters 域产物，惰性求值） */
  baseItems: () => NotificationItem[]
}) {
  // 时间窗判定复用 P-40 的 dndSchedule 纯函数（lastEndedDndWindow，同日/跨
  // 午夜同口径），纯 UI 侧按条目 time 过滤，无 Go 改动。nowMs 是响应式时钟锚：
  // 面板打开时刷新（摘要只在面板可见，窗口随墙钟推进在下次打开时自然修正），
  // 面板常开跨过窗口结束边界的场景由重开补上
  const nowMs = ref(Date.now())
  const dndWindow = computed<DndInterval | null>(() =>
    lastEndedDndWindow(options.prefs(), new Date(nowMs.value)))
  function inDndWindow(n: NotificationItem): boolean {
    const w = dndWindow.value
    if (!w) return false
    const ts = new Date(n.time).getTime()
    return ts >= w.startMs && ts < w.endMs
  }

  // 点击摘要切换「仅显窗口内条目」的过滤视图（叠加在分类/项目维之上）；
  // 查看过（退出过滤视图）或手动关闭后消隐，会话内态（组件常驻 App.vue，
  // ref 存活整个页面会话、不持久化）。消隐按窗口 endMs 记账：同配置次日
  // （或新一段时段）解除时是新窗口，摘要应重新出现
  const dndOnly = ref(false)
  const dismissedWindowEnd = ref<number | null>(null)
  // 摘要计数口径 = 窗口内 ∩ 当前项目维 ∩ 当前 runtime 维 ∩ 非延后中（与常规流
  // 可见性一致：延后是「暂离视线」语义，已在「已延后」页签有归属；列表 ≤200 条
  // O(n) 扫描）
  const dndMissedCount = computed(() => {
    if (!dndWindow.value) return 0
    return options.baseItems().filter(n => inDndWindow(n) && !options.store.isSnoozed(n)).length
  })
  const showDndSummary = computed(() =>
    dndWindow.value !== null && (dismissedWindowEnd.value !== dndWindow.value.endMs || dndOnly.value) && (dndMissedCount.value > 0 || dndOnly.value))

  /** 面板打开时刷新时钟锚（组件的 store.showPanel watch 调用） */
  function refreshClock(): void {
    nowMs.value = Date.now()
  }

  function toggleDndOnly(): void {
    dndOnly.value = !dndOnly.value
    // 退出过滤视图 = 已查看过，摘要完成使命（仍在窗内时 dismissed 被
    // endMs 相等判定挡住，退出即消隐；过滤态下摘要保留作激活态指示）
    if (!dndOnly.value && dndWindow.value) dismissedWindowEnd.value = dndWindow.value.endMs
  }
  function closeDndSummary(): void {
    // 手动关闭连过滤态一起退出，不留不可见的过滤视图
    dndOnly.value = false
    if (dndWindow.value) dismissedWindowEnd.value = dndWindow.value.endMs
  }
  // 窗口失效（偏好改/禁用）或窗口内条目清零时自动退出过滤并消隐——同项目维
  // 过滤「选中项清空自动回落」的既有惯例，避免空列表无解释、过滤态不可见
  watch([dndWindow, dndMissedCount], ([w, n]) => {
    if (!dndOnly.value) return
    if (!w || n === 0) closeDndSummary()
  })

  return {
    nowMs, dndWindow, inDndWindow,
    dndOnly, dismissedWindowEnd,
    dndMissedCount, showDndSummary,
    refreshClock, toggleDndOnly, closeDndSummary,
  }
}
