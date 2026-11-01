import { computed, ref } from 'vue'
import { instanceFetch } from '../api/instanceFetch'
import { useInstanceStore } from '../stores/instance'
import type { NotificationItem } from '../api/client'

/**
 * 跨实例通知聚合（P-20261003-125）：fleet 值守面——本机 + 各远程实例的通知
 * 一屏聚合。数据通道复用 InstanceSessionOverview 同款实例 API 助手
 * （instanceFetch：本机 = 同源 /api，远程 = 既有回环代理 /proxy/<id>/api 带
 * 锁令牌，跨实例鉴权沿实例探活同款同机互信边界），逐实例并行拉
 * GET /notifications（服务端 200 条封顶），单实例失败标离线不拖垮整体。
 * 聚合只读：条目不带任何写操作（已读/移除/延后回各自实例的通知中心做，
 * 跨实例写不引入），error/warning 优先排序 + 实例徽标随行。
 *
 * 值班大屏通知卡（FleetNotifyCard）与聚合弹层（InstanceNotifyOverview）
 * 两个宿主各自实例化本组合式：弹层打开即全量 load（重取实例列表，新注册
 * 实例即现）；卡片挂载全量 load + 60s 静默轮询既有块（不重取实例列表——
 * 避免 checkBatch 探测 fan-out，成员漂移靠手动刷新/重开自愈）。
 */

/** 聚合行：条目 + 来源实例徽标信息 */
export interface FleetNotifyRow {
  item: NotificationItem
  instanceId: string
  instanceName: string
  isLocal: boolean
}

/** 单实例块：拉取状态 + 该实例通知列表（口径同 InstanceSessionOverview 块） */
export interface FleetNotifyInstance {
  id: string
  name: string
  isLocal: boolean
  reachable: boolean
  loading: boolean
  items: NotificationItem[]
  /** 本块最后一次成功拉取的时刻（0 = 尚未成功过，如仍在 loading） */
  refreshedAt: number
}

// 严重度权重：error > warning > success > info——值班面要「异常置顶」，
// error/warning 优先排序（提案口径），同级按时间倒序（最新在前）
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, success: 2, info: 3 }
export function severityRank(type: string): number {
  return SEVERITY_ORDER[type] ?? 3
}

/** 延后中判定（notification store isSnoozed 的纯函数副本，避免为读一个判定
 *  拉起整个 store）：聚合面尊重「延后 = 暂离视线」语义（P-20261003-36），
 *  延后中条目不入聚合——否则值班面把操作员明确搁置的条目又顶回来。
 *  与 store 副本同口径：标记在位即延后中（不看墙钟），到点重挂由服务端巡检
 *  清标记，空窗期不提前弹回 */
function isSnoozed(n: NotificationItem): boolean {
  return !!n.snoozeUntil
}

/** 模板化文案渲染（通知中心同款，日报 P-20261001-30）：titleKey/bodyKey 优先
 *  按 key + msgParams 走 i18n 模板（远程条目随本地界面语言渲染），原文回退 */
export function notifyTitle(n: NotificationItem, t: (k: string, p?: Record<string, unknown>) => string): string {
  return n.titleKey ? t(n.titleKey, n.msgParams ?? {}) : n.title
}
export function notifyBody(n: NotificationItem, t: (k: string, p?: Record<string, unknown>) => string): string {
  if (!n.bodyKey) return n.body ?? ''
  const summary = t(n.bodyKey, n.msgParams ?? {})
  return n.body ? `${summary}\n${n.body}` : summary
}

export function useFleetNotifications() {
  const instanceStore = useInstanceStore()
  const instances = ref<FleetNotifyInstance[]>([])
  // 全量装载中（弹层首开 spin；块级静默刷新不触发）
  const loading = ref(false)

  async function fetchItems(instanceId: string): Promise<NotificationItem[]> {
    const j = await instanceFetch<{ data?: NotificationItem[] }>(instanceId, 'GET', '/notifications')
    return j.data || []
  }

  /** 单块拉取：失败标离线。silent = 静默轮询——失败只降级不清已有数据
   *  （值班正盯着的列表因一次抖动闪没比短暂陈旧更糟，恢复在线下一轮自愈，
   *  与 InstanceSessionOverview.pollBlock 同约定） */
  async function refreshBlock(b: FleetNotifyInstance, silent = false): Promise<void> {
    if (!silent) b.loading = true
    try {
      b.items = await fetchItems(b.id)
      b.reachable = true
      b.refreshedAt = Date.now()
    } catch {
      b.reachable = false
      if (!silent) b.items = []
    } finally {
      if (!silent) b.loading = false
    }
  }

  /** 全量装载：重取实例列表 → 本机 + 全部远程块并行拉取。块 0 恒为中心机
   *  （id='local' 不经实例改写，/api 恒为中心数据），名字取中心实例而非
   *  currentInstance——视图切在远程实例上时不能把中心数据标成远程实例名，
   *  与 InstanceSessionOverview 同口径 */
  async function load(): Promise<void> {
    loading.value = true
    try {
      await instanceStore.fetchInstances()
      const central = instanceStore.instances.find(i => i.isLocal)
      const all = [
        { id: 'local', name: central?.name || 'Local', isLocal: true },
        ...instanceStore.instances
          .filter(i => !i.isLocal)
          .map(i => ({ id: i.id, name: i.name, isLocal: false })),
      ]
      instances.value = all.map(b => ({ ...b, reachable: b.isLocal, loading: !b.isLocal, items: [], refreshedAt: 0 }))
      await Promise.all(instances.value.map(b => refreshBlock(b)))
    } finally {
      loading.value = false
    }
  }

  /** 既有块静默重拉（不重取实例列表）：卡片 60s 轮询 / 弹层头部刷新用，
   *  轻量 N 个 JSON GET、零实例探测 fan-out */
  async function refreshAll(): Promise<void> {
    await Promise.all(instances.value.map(b => refreshBlock(b, true)))
  }

  /** 聚合统一列表：可达实例的条目展平（延后中除外）+ error/warning 优先排序。
   *  实例徽标（instanceName）随行携带，渲染层的分组/过滤都在此之上做 */
  const aggregated = computed<FleetNotifyRow[]>(() => {
    const rows: FleetNotifyRow[] = []
    for (const b of instances.value) {
      if (!b.reachable) continue
      for (const item of b.items) {
        if (isSnoozed(item)) continue
        rows.push({ item, instanceId: b.id, instanceName: b.name, isLocal: b.isLocal })
      }
    }
    return rows.sort((a, b) => {
      const d = severityRank(a.item.type) - severityRank(b.item.type)
      if (d !== 0) return d
      return (Date.parse(b.item.time) || 0) - (Date.parse(a.item.time) || 0)
    })
  })

  // 计数族：弹层 meta 行 / 徽标未读数与值班卡状态点、离线注记共用
  const offlineCount = computed(() =>
    instances.value.filter(b => !b.isLocal && !b.reachable && !b.loading).length)
  const unreadByInstance = computed(() => {
    const m = new Map<string, number>()
    for (const r of aggregated.value) {
      if (!r.item.read) m.set(r.instanceId, (m.get(r.instanceId) || 0) + 1)
    }
    return m
  })
  const unreadCount = computed(() => aggregated.value.filter(r => !r.item.read).length)
  const unreadErrorCount = computed(() =>
    aggregated.value.filter(r => !r.item.read && r.item.type === 'error').length)
  const unreadIssueCount = computed(() =>
    aggregated.value.filter(r => !r.item.read && (r.item.type === 'error' || r.item.type === 'warning')).length)

  return {
    instances, loading, load, refreshAll, aggregated,
    offlineCount, unreadByInstance, unreadCount, unreadErrorCount, unreadIssueCount,
  }
}
