import { computed, ref, watch, type Ref } from 'vue'
import { useI18n } from './useI18n'
import { loadNotifyFilterPrefs, watchNotifyFilterPrefs } from './useNotifyFilterPrefs'
import { confirmDialog } from './useDialog'
import type { NotificationItem } from '../api/client'

/**
 * 通知中心过滤域（自 NotificationCenter.vue P-20261007-23 分域拆解迁入）：
 * 分类/项目/runtime 三维过滤状态 + 候选聚合 + 对账回落 + 持久化（P-173/187）
 * + 页签计数 + 清空按钮语义，整体收口于此——后续新增过滤维只改本 composable
 * 一处（候选聚合、过滤流水线、counts、清空语义、对账回落同址）。
 *
 * 与免打扰域（useNotifyDnd）互为输入：流水线末端叠加 dndOnly 过滤视图
 * （dnd gate 注入），dnd 摘要计数反向取本域的 runtimeFilteredItems 作底集。
 *
 * 本域零 Pinia 依赖（store 动作经结构化接口注入），jsdom 直测无需挂载 Pinia。
 */
export interface NotifyFiltersStore {
  items: Ref<NotificationItem[]>
  isSnoozed(n: NotificationItem): boolean
  clear(): Promise<void> | void
  dismissMany(ids: string[]): Promise<void> | void
}

/** 免打扰 gate：过滤视图开关 + 窗口判定（useNotifyDnd 产物） */
export interface NotifyFilterDndGate {
  dndOnly: Ref<boolean>
  inDndWindow(n: NotificationItem): boolean
}

// 分类筛选：全部 / 未读 / 已延后 / 各类别
export type NotifyFilter = 'all' | 'unread' | 'snoozed' | 'git' | 'task' | 'clone' | 'system' | 'error' | 'drop'

export function useNotifyFilters(options: { store: NotifyFiltersStore; dnd: NotifyFilterDndGate }) {
  const { store, dnd } = options
  const { t } = useI18n()

  const filters: Array<{ key: NotifyFilter; label: string; icon?: string }> = [
    { key: 'all', label: t('notification.filter.all') },
    { key: 'unread', label: t('notification.filter.unread') },
    { key: 'snoozed', label: t('notification.filter.snoozed') },
    { key: 'task', label: t('notification.category.task') },
    { key: 'clone', label: t('notification.category.clone') },
    { key: 'git', label: t('notification.category.git') },
    { key: 'system', label: t('notification.category.system') },
    { key: 'error', label: t('notification.category.error') },
    // 快投递到达（P-20261006-51）：手机/脚本 → 工作台的投递收件
    { key: 'drop', label: t('notification.category.drop') },
  ]

  // 过滤选择持久化（P-20261003-173）：分类页签 + 项目下拉的当前选择 localStorage
  // 记忆（键 notify-filter）——常用组合（「只看某项目 error」）跨页面刷新/重启
  // 不再重选。恢复入口零新增 UI：「全部」页签与「全部项目」下拉项即默认档，点选
  // 即写回。读侧按 filters 键清单校验（无效键回落 all），project 的存在性由下方
  // projectOptions 对账 watch 动态回落——通知历史异步加载后仍有效的选择才站得住
  const restoredFilter = loadNotifyFilterPrefs(filters.map(f => f.key))
  const activeFilter = ref<NotifyFilter>(restoredFilter.filter as NotifyFilter)
  const activeProject = ref(restoredFilter.project)
  const activeRuntime = ref(restoredFilter.runtime)
  const projectOptions = computed(() => {
    const byId = new Map<string, string>()
    for (const n of store.items.value) {
      if (n.projectId) byId.set(n.projectId, n.projectName || n.projectId)
    }
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  watch(projectOptions, (opts) => {
    if (activeProject.value !== '' && !opts.some(o => o.id === activeProject.value)) {
      activeProject.value = ''
    }
  })
  // runtime 过滤候选（P-20261003-187）：条目携带的 runtime 注册名去重聚合——
  // 出现过的运行时才成 chip（动态清单，无 runtime 条目的通知不产生本行）。
  // 列表 ≤200 条 O(n) 扫描，同 projectOptions 口径
  const runtimeOptions = computed(() => {
    const seen = new Set<string>()
    for (const n of store.items.value) {
      if (n.runtime) seen.add(n.runtime)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  })
  watch(runtimeOptions, (opts) => {
    // 对账回落同项目维：选中运行时的条目清空后（dismiss/清空/实例切换）候选
    // 消失，回落「全部运行时」且回落态经下方 watch 落盘——陈旧选择不复活
    if (activeRuntime.value !== '' && !opts.includes(activeRuntime.value)) {
      activeRuntime.value = ''
    }
  })
  // 选择变更即写持久层（P-20261003-173）：非 immediate——启动恢复不回写，未动过
  // 的默认态零存储写入；上方对账回落（项目通知清空/实例切换清列表）同样触发本
  // watch 落盘，删除项目的陈旧选择不会在下次启动复活
  watchNotifyFilterPrefs(activeFilter, activeProject, activeRuntime)
  const projectFilteredItems = computed(() =>
    activeProject.value === ''
      ? store.items.value
      : store.items.value.filter(n => n.projectId === activeProject.value))
  // runtime 维过滤（P-20261003-187）：与项目/分类维正交 AND 叠加（P-173 持久化
  // 同构）。语义：记录无 runtime（任务/克隆等无归属类别）不受过滤——只有明确
  // 归属某运行时的条目才按选中值分流，「只看 claude 的」不把无归属条目藏掉
  const runtimeFilteredItems = computed(() =>
    activeRuntime.value === ''
      ? projectFilteredItems.value
      : projectFilteredItems.value.filter(n => !n.runtime || n.runtime === activeRuntime.value))

  // 下拉 title：选中项目名过长被截断时悬停看全名；未选中时是功能提示
  const projectSelectTitle = computed(() => {
    if (activeProject.value === '') return t('notification.projectFilter.label')
    return projectOptions.value.find(o => o.id === activeProject.value)?.name
      ?? t('notification.projectFilter.all')
  })

  // 筛选流水线（P-20261003-36 起含延后维）：延后中的条目从常规流（全部/未读/
  // 分类）隐藏、只入「已延后」页签——分诊三态里「延后」即暂离视线，徽标与
  // 分类计数同步沉默；到点重挂或取消延后即回到常规流。dndOnly（P-20261003-64）
  // 正交叠加在最外层：仅显免打扰窗口内的条目。runtime 维（P-20261003-187）在
  // 项目维之后、分类页签之前收窄底集：无 runtime 条目穿透 runtime 过滤
  const filteredItems = computed(() => {
    if (activeFilter.value === 'snoozed') {
      const base = runtimeFilteredItems.value.filter(n => store.isSnoozed(n))
      return dnd.dndOnly.value ? base.filter(dnd.inDndWindow) : base
    }
    let base = runtimeFilteredItems.value
    if (activeFilter.value === 'unread') base = base.filter(n => !n.read)
    else if (activeFilter.value !== 'all') base = base.filter(n => n.category === activeFilter.value)
    base = base.filter(n => !store.isSnoozed(n))
    return dnd.dndOnly.value ? base.filter(dnd.inDndWindow) : base
  })

  // 页签计数：未读=未读数（延后中不计），已延后=延后数，分类=该类总数（不含
  // all）——筛选处直接感知分布；项目/runtime 维过滤叠加后按子集计数（与列表
  // 所见一致）
  const filterCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {
      unread: runtimeFilteredItems.value.filter(n => !n.read && !store.isSnoozed(n)).length,
      snoozed: runtimeFilteredItems.value.filter(n => store.isSnoozed(n)).length,
    }
    for (const n of runtimeFilteredItems.value) {
      if (store.isSnoozed(n)) continue
      counts[n.category] = (counts[n.category] || 0) + 1
    }
    return counts
  })

  // 清空按钮语义跟随筛选：全部（无任何过滤，免打扰过滤视图也不算「无过滤」）
  // → 清空全部（服务端 clear）；任一过滤生效（分类/未读/项目/runtime/免打扰
  // 窗口）→ 只清当前筛选结果（批量移除）。破坏性动作先确认——与删除目录/移除
  // 项目的应用内惯例一致，误触不再直接丢掉全部历史
  const clearTitle = computed(() =>
    activeFilter.value === 'all' && activeProject.value === '' && activeRuntime.value === '' && !dnd.dndOnly.value
      ? t('notification.clearAll')
      : t('notification.clearFiltered', { n: filteredItems.value.length }))
  async function clearCurrent(): Promise<void> {
    const n = filteredItems.value.length
    if (n === 0) return
    const ok = await confirmDialog({
      title: clearTitle.value,
      content: t('notification.clearConfirm', { n }),
      type: 'warning',
    })
    if (!ok) return
    if (activeFilter.value === 'all' && activeProject.value === '' && activeRuntime.value === '' && !dnd.dndOnly.value) return store.clear()
    await store.dismissMany(filteredItems.value.map(item => item.id))
  }

  return {
    filters, activeFilter, activeProject, activeRuntime,
    projectOptions, runtimeOptions, projectSelectTitle,
    projectFilteredItems, runtimeFilteredItems, filteredItems,
    filterCounts, clearTitle, clearCurrent,
  }
}
