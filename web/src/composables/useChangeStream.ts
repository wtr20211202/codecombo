import { computed, onScopeDispose, ref } from 'vue'
import { watchActivityApi, type ChangeStreamEvent } from '../api/domains/system'
import { useProjectStore, type Project } from '../stores/project'

/**
 * 跨项目实时变更流（P-20261003-232）：「刚刚发生了什么」——内核总线
 * file.changed 全局广播的服务端只读内存快照（GET /api/watch/activity），
 * 本组合式轮询拉取并聚合为「项目徽标 + 文件 + 时间」的分批时间线。
 *
 * 去抖聚合（风暴防护的前端半边，服务端半边是环形缓冲容量封顶）：同项目的
 * 连续事件在 GROUP_WINDOW_MS 时间窗内合并为一个批次行（agent 批量产文件/
 * 构建输出一次只占一行，不逐文件刷屏）；合并为纯函数 coalesceBatches，
 * 每次轮询全量重算——快照拉取本身有界（服务端环 ≤512、单次 ≤200），重算
 * 复杂度 O(事件数)，秒级轮询下远非热路径。
 *
 * 读取姿态与 useFleetNotifications 同约定：轮询失败静默保旧数据（值班正盯
 * 的列表闪没比短暂陈旧更糟），恢复后下一轮自愈；服务端重启清空快照，视图
 * 自然回落空态（内存观测面语义，端口注册表同类 MVP）。
 *
 * 条目深链（P-20261006-52）：批次行可点击——跨项目条目经 /project?project=&file=
 * 深链（P-20261006-43 规则文件同款两段式，Layout 消费链 consumeFileQuery 负责
 * 守卫切项目 + 打开 + 清 query）；无可靠相对路径时（项目根不匹配等）降级为
 * 只切项目不打开。MVP 单条目粒度：点击只开批内最新一个文件（lastPath），不
 * 整批打开——防误开 N 个 tab。
 */

/** 轮询间隔：值班感知秒级够用，与 InstanceHealthCard 30s / FleetNotifyCard
 * 60s 档位相比更短——变更流的价值恰在「新近」，5s 是信息密度与请求量的折中 */
export const CHANGE_STREAM_POLL_MS = 5_000
/** 同项目连续事件合并窗口：批内最旧事件与最新事件的最大时差 */
export const CHANGE_STREAM_GROUP_WINDOW_MS = 2_000
/** 时间线最大批次行数（超过截旧——视图滚动区有界，不随风暴无限增长） */
export const CHANGE_STREAM_MAX_BATCHES = 60
/** 每批展示的文件预览条数（其余以「+N」计数呈现） */
export const CHANGE_STREAM_FILES_PER_BATCH = 4

/** 批次行：同项目时间窗内连续事件的聚合 */
export interface ChangeBatch {
  /** 首事件键（Vue :key 用；ts+projectId+path 在环容量内唯一） */
  id: string
  projectId: string
  /** 项目名（清单已删/未知时为空串，视图降级显示短 id） */
  projectName: string
  /** 批内事件数（含未入预览的） */
  count: number
  /** 预览文件相对路径（服务端绝对路径剥项目根；截断到 filesPerBatch） */
  files: string[]
  /** 批内最新事件时刻（UnixMilli） */
  lastTs: number
  /** 批内最新事件原始绝对路径（=files[0] 的服务端形态，未剥根）——深链打开
   *  目标（P-20261006-52）；相对折算放点击时点（deepLinkRelPath）而非聚合时
   *  点：项目根可能随时增删/迁移，聚合时折算会陈旧 */
  lastPath: string
}

function eventKey(e: ChangeStreamEvent): string {
  return `${e.ts}:${e.projectId}:${e.path}`
}

/** 路径归一：反斜杠 → 正斜杠（URL/深链语义跨平台一致，useFileDeepLink 同口径，
 * 消费端 openFileByPath 直接可用） */
function normSlash(s: string): string {
  return s.replace(/\\/g, '/')
}

/** 深链相对路径（P-20261006-52）：与 displayPath 同一归一口径（正斜杠 + 剥
 * 项目根），但根不匹配/无项目根时返回 null——displayPath 的 basename 降级是
 * 「给人看」的兜底，拿去开文件会静默命中同名异实文件（openDeepLinkedFile 的
 * 放弃语义同源）；调用方按 null 降级为只切项目不打开 */
export function deepLinkRelPath(path: string, projectPath?: string): string | null {
  if (!projectPath) return null
  const p = normSlash(path)
  const root = normSlash(projectPath).replace(/\/+$/, '')
  if (root && p.startsWith(root + '/')) {
    const rel = p.slice(root.length + 1)
    if (rel) return rel
  }
  return null
}

/** 项目相对展示路径：两侧统一归一为正斜杠后剥项目根前缀——不假设服务端
 * 平台的分隔符方向（win 反斜杠 / posix 正斜杠都能剥中）；根不匹配（项目
 * 已删除/路径迁移）退回文件名 */
export function displayPath(path: string, projectPath?: string): string {
  const base = normSlash(path).split('/').pop() || path
  return deepLinkRelPath(path, projectPath) ?? base
}

/** 聚合纯函数：新→旧事件流 → 批次行（同项目且与批内最新事件时差 ≤windowMs
 * 的相邻事件并成一批）。projects 为项目清单（名字/根路径解析源） */
export function coalesceBatches(
  events: ChangeStreamEvent[],
  projects: Project[],
  opts?: { windowMs?: number; maxBatches?: number; filesPerBatch?: number },
): ChangeBatch[] {
  const windowMs = opts?.windowMs ?? CHANGE_STREAM_GROUP_WINDOW_MS
  const maxBatches = opts?.maxBatches ?? CHANGE_STREAM_MAX_BATCHES
  const filesPerBatch = opts?.filesPerBatch ?? CHANGE_STREAM_FILES_PER_BATCH
  const byId = new Map(projects.map(p => [p.id, p]))
  const batches: ChangeBatch[] = []
  for (const e of events) {
    const last = batches[batches.length - 1]
    const proj = byId.get(e.projectId)
    if (
      last && last.projectId === e.projectId &&
      last.lastTs - e.ts <= windowMs && e.ts <= last.lastTs
    ) {
      last.count++
      if (last.files.length < filesPerBatch) {
        last.files.push(displayPath(e.path, proj?.path))
      }
      continue
    }
    if (batches.length >= maxBatches) break
    batches.push({
      id: eventKey(e),
      projectId: e.projectId,
      projectName: proj?.name ?? '',
      count: 1,
      files: [displayPath(e.path, proj?.path)],
      lastTs: e.ts,
      lastPath: e.path,
    })
  }
  return batches
}

/** 单宿主实例化的轮询聚合（值班大屏卡与活动栏面板各自实例化——两宿主不同
 * 路由，不会同时挂载产生双倍轮询；onScopeDispose 兜底停表） */
export function useChangeStream() {
  const projectStore = useProjectStore()
  const loading = ref(false)
  const failed = ref(false)
  const loaded = ref(false)
  const events = ref<ChangeStreamEvent[]>([])
  const dropped = ref(0)

  const batches = computed(() => coalesceBatches(events.value, projectStore.projects))

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      // 全量快照（非 since 增量）：环只有 512 条，全量省去合并对账，服务端
      // 重启清空后视图自然回落空态（增量语义会把陈旧内存留成幽灵）
      const res = await watchActivityApi.get({ limit: 200 })
      events.value = res.data?.events ?? []
      dropped.value = res.data?.dropped ?? 0
      failed.value = false
      loaded.value = true
    } catch {
      // 静默保旧数据（与 useFleetNotifications 同姿态）
      failed.value = true
    } finally {
      loading.value = false
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  function start(): void {
    if (timer) return
    // 项目清单是名字/根路径解析源：直接进入面板（store 尚未装载，如刷新后
    // 首站就是 /monitor）时补拉一次——幂等 GET，装载过则零成本跳过
    if (projectStore.projects.length === 0) void projectStore.fetchProjects()
    void refresh()
    timer = setInterval(() => void refresh(), CHANGE_STREAM_POLL_MS)
  }
  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
  // failSilently：单测裸实例化无 effect scope，缺省注销会逐次告警（useQuickNav 同款）
  onScopeDispose(stop, true)

  return { batches, loading, failed, loaded, dropped, refresh, start, stop }
}
