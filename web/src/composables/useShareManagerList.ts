import { computed, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ShareHealth, ShareInfo, ShareKind } from '../api/domains/share'

// 分享管理列表的筛选/状态/排序纯逻辑（P-20261020-10）：从 ShareManagerView
// 抽出，供单测与视图共用。排序在分页前作用于全集——NDataTable 只见当前页，
// 页内排序翻页即失效（沿用 P-20261005-176 frozenBytes 的预分页模式）。

export type ShareStatusFilter = '' | 'active' | 'expired' | 'consumed' | 'abnormal'
export type ShareSortKey = 'frozenBytes' | 'createdAt' | 'expiresAt' | 'hits' | 'lastAccessAt'
export type ShareSortOrder = false | 'ascend' | 'descend'

/** 服务端 health 缺省（旧服务端）按 ok 解读——纯增量字段的升级兼容 */
export function shareHealth(row: ShareInfo): ShareHealth {
  return row.health ?? 'ok'
}

/** 有效期已过（服务端按 ExpiresAt 判定；前端用同一时点判定供即时筛选） */
export function shareExpired(row: ShareInfo, now: number): boolean {
  if (!row.expiresAt) return false
  const at = Date.parse(row.expiresAt)
  return Number.isFinite(at) && at <= now
}

/** 一次性分享已消费（服务端已判宽限窗，前端只消费投影） */
export function shareConsumed(row: ShareInfo): boolean {
  return row.consumed === true
}

/** 健康异常（目标/项目/快照任一缺失） */
export function shareAbnormal(row: ShareInfo): boolean {
  return shareHealth(row) !== 'ok'
}

/**
 * 状态筛选谓词。过期/异常可重叠（一条已过期的坏链在两个筛选下都该可见），
 * 因此除 active 外不做互斥裁剪；active = 三者皆否的「仍可正常服务」态。
 */
export function shareMatchesStatus(row: ShareInfo, filter: ShareStatusFilter, now: number): boolean {
  switch (filter) {
    case 'active': return !shareExpired(row, now) && !shareConsumed(row) && !shareAbnormal(row)
    case 'expired': return shareExpired(row, now)
    case 'consumed': return shareConsumed(row)
    case 'abnormal': return shareAbnormal(row)
    default: return true
  }
}

/** 排序取值：null = 缺省/无效（缺省值恒排最后，不随升降序翻到前面） */
export function shareSortValue(row: ShareInfo, key: ShareSortKey): number | null {
  switch (key) {
    case 'frozenBytes': return row.frozenBytes ?? null
    case 'hits': return row.hits ?? 0
    case 'createdAt': return parseTime(row.createdAt)
    case 'expiresAt': return parseTime(row.expiresAt)
    case 'lastAccessAt': return parseTime(row.lastAccessAt)
  }
}

function parseTime(v: string | undefined): number | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** 升序比较：缺省值恒最后（descend 由调用方翻转非 null 比较） */
export function compareShareRows(a: ShareInfo, b: ShareInfo, key: ShareSortKey): number {
  const av = shareSortValue(a, key)
  const bv = shareSortValue(b, key)
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  return av - bv
}

/** 预分页排序（不改原数组；稳定排序依赖 JS 规范） */
export function sortShareRows(
  rows: ShareInfo[], key: ShareSortKey | '', order: ShareSortOrder,
): ShareInfo[] {
  if (!key || !order) return rows
  const dir = order === 'descend' ? -1 : 1
  return [...rows].sort((a, b) => {
    const av = shareSortValue(a, key)
    const bv = shareSortValue(b, key)
    if (av === null && bv === null) return 0
    // 缺省值不参与方向翻转：翻到榜首的「—」没有信息量
    if (av === null) return 1
    if (bv === null) return -1
    return (av - bv) * dir
  })
}

export function useShareManagerList(
  shares: Ref<ShareInfo[]>, now: Ref<number>, pageSize = 15,
) {
  const search = ref('')
  const kindFilter = ref<ShareKind | ''>('')
  const statusFilter = ref<ShareStatusFilter>('')
  const page = ref(1)
  const sortKey = ref<ShareSortKey | ''>('')
  const sortOrder = ref<ShareSortOrder>(false)

  const isFiltering = computed(() =>
    search.value.trim() !== '' || kindFilter.value !== '' || statusFilter.value !== '')

  const visibleShares = computed(() => {
    if (!isFiltering.value) return shares.value
    const q = search.value.trim().toLowerCase()
    return shares.value.filter((s) =>
      (!kindFilter.value || s.kind === kindFilter.value) &&
      shareMatchesStatus(s, statusFilter.value, now.value) &&
      (!q || [s.name, s.projectName, s.path, (s.paths || []).join(' '), s.terminalId, s.recordingId, s.sessionId]
        .some((v) => (v || '').toLowerCase().includes(q))))
  })

  const sortedShares = computed(() => sortShareRows(visibleShares.value, sortKey.value, sortOrder.value))
  const paged = computed(() =>
    sortedShares.value.slice((page.value - 1) * pageSize, page.value * pageSize))
  const pageCount = computed(() => Math.max(1, Math.ceil(sortedShares.value.length / pageSize)))
  const abnormalCount = computed(() => shares.value.filter(shareAbnormal).length)

  // 筛选条件变化回第 1 页（排序不改变命中集合，保持当前页）
  watch([search, kindFilter, statusFilter], () => {
    if (page.value !== 1) page.value = 1
  })

  // Naive UI 的 @update:sorter 载荷是 { columnKey, order, sorter }（无 key）；
  // 同时兼容 key 形态供调用方自建表头复用。首击为 descend（Naive 默认循环）
  function onSorter(s: { columnKey?: string | number; key?: string | number; order: ShareSortOrder } | null) {
    if (!s || !s.order) {
      sortKey.value = ''
      sortOrder.value = false
      return
    }
    const key = s.columnKey ?? s.key
    if (key !== 'frozenBytes' && key !== 'createdAt' && key !== 'expiresAt'
      && key !== 'hits' && key !== 'lastAccessAt') {
      return
    }
    sortKey.value = key
    sortOrder.value = s.order
  }

  function sortOrderFor(key: ShareSortKey): ShareSortOrder {
    return sortKey.value === key ? sortOrder.value : false
  }

  /** 类别徽标点选（受控）：checked=false 即取消该类别回到全部 */
  function onKindChecked(kind: ShareKind | '', checked: boolean) {
    kindFilter.value = checked ? kind : ''
  }

  /** 状态徽标点选（受控）：checked=false 即取消该状态回到全部 */
  function onStatusChecked(status: ShareStatusFilter, checked: boolean) {
    statusFilter.value = checked ? status : ''
  }

  /** 工具栏「N 条异常」快捷入口 */
  function filterAbnormal() {
    statusFilter.value = 'abnormal'
  }

  return {
    search, kindFilter, statusFilter, page, sortKey, sortOrder,
    isFiltering, visibleShares, sortedShares, paged, pageCount, abnormalCount,
    onSorter, sortOrderFor, onKindChecked, onStatusChecked, filterAbnormal,
  }
}
