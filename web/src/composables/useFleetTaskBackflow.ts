import { instanceFetch } from '../api/instanceFetch'
import type { DispatchRecord } from '../api/domains/system'
import { useAssistantTaskStore } from '../stores/assistantTask'
import { useLockStore } from '../stores/lock'
import { handleAgentTaskProgressNotify } from '../utils/agentTaskNotify'
import { parseRemoteTaskKey, remoteTaskKey } from '../utils/remoteTaskKey'

/**
 * 联邦派发进度回流（P-20261004-131）：中心对有派发记录的实例轮询对端任务
 * 事件流，把对端会话进度映射进本地 bySession（remote: 命名空间）+ 终态触发
 * 既有通知链——「选机→派活→监控→回流」四段的最后一米。
 *
 * 数据通道（两跳都走 instanceFetch 同源/回环代理，不经 axios 实例改写）：
 * - 寻址：中心自身 GET /api/instances/dispatched（派发落账，恒读中心——
 *   浏览器切到远程实例视图时 axios 会被改写成对端，回流寻址必须锚定中心）
 * - 进度：对端 GET /api/agent-tasks?sessionId=<remoteSessionId>&limit=5
 *   （B6 落库任务事件流，最新在前；返回第一条 task.progress 即会话现状）。
 *   对端版本无该端点 → 404 降级跳过（实例探活矩阵 404 同惯例，本页会话内
 *   不再重试）；网络不通 → 静默跳过下一轮自愈（fleet 块级降级同约定）
 *
 * 成本注记（提案口径）：dispatched 集合通常 1-3 实例，每 15s 每活跃记录一次
 * 小 JSON GET；终态是回流跟踪的终点——观察到 done/failed 后该记录本页不再
 * 轮询（对端后续新任务不在本条派发跟踪语义内，其进度由对端自身界面承载）。
 * 对端落库事件不含 steps 结构化清单（AgentTask 只持久化 task/status/step），
 * 远程条目回步文本不回清单——诚实边界。
 *
 * 通知语义：仅「页面开着期间观察到的 running→终态沿」且事件新鲜（2min 窗）
 * 才入账——页面关闭期间错过的终态只映射状态（监控卡回看），刷新/重开不重放
 * 旧终态骚扰。防重复/耗时统计沿 handleAgentTaskProgressNotify 既有链。
 */

/** 轮询间隔（提案定值）：dispatched 通常 1-3 实例，成本可控 */
export const FLEET_BACKFLOW_POLL_MS = 15_000

/** 终态通知新鲜度窗：事件时刻距今超过该值只映射状态不通知（补账不重放） */
export const BACKFLOW_NOTIFY_FRESH_MS = 2 * 60_000

/** 对端 /agent-tasks 事件形态（store.AgentTask 落库视图同构） */
interface PeerTaskEvent {
  type?: string
  task?: string
  status?: string
  step?: string
  at?: string
}

// ── 模块级单例状态（App 生命周期一份；页面刷新即重置——与指纹表同语义） ──
let timer: ReturnType<typeof setInterval> | null = null
/** 防重入：慢请求跨 tick 时丢弃本轮（上轮未归，15s 间隔远大于请求耗时） */
let ticking = false
/** 本页观察到的远程键最后状态（缺省 = 未观察过）：终态沿检测 */
const observedStatus = new Map<string, string>()
/** 已收口（终态已观察）的记录 id：不再轮询 */
const settledRecords = new Set<string>()
/** 无任务事件流端点的实例（404）：本页会话内跳过（旧版本对端降级） */
const unsupportedInstances = new Set<string>()

/** 测试钩子：清空模块级状态（用例间隔离） */
export function resetFleetTaskBackflowForTest(): void {
  stopFleetTaskBackflow()
  ticking = false
  observedStatus.clear()
  settledRecords.clear()
  unsupportedInstances.clear()
}

/** 启动轮询（幂等）：立即先跑一轮再挂 15s 间隔。App 根挂载期调用 */
export function startFleetTaskBackflow(): void {
  if (timer !== null) return
  void pollOnce()
  timer = setInterval(() => { void pollOnce() }, FLEET_BACKFLOW_POLL_MS)
}

export function stopFleetTaskBackflow(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

/** 单轮回流：拉寻址账 → 逐记录拉对端进度 → 映射 bySession + 终态沿通知。
 *  任一环节失败只降级本轮（下轮自愈），绝不打断既有界面 */
async function pollOnce(): Promise<void> {
  if (ticking) return
  // 锁定态跳过（token 已失效轮询必 423 空转；解锁后下一轮自然恢复）
  if (useLockStore().isLocked) return
  ticking = true
  try {
    let records: DispatchRecord[]
    try {
      const res = await instanceFetch<{ data?: DispatchRecord[] }>('local', 'GET', '/instances/dispatched')
      records = res.data ?? []
    } catch {
      return // 中心自身不可达（理论罕见）：本轮放弃
    }
    pruneWithoutRecords(records)
    await Promise.all(records.map(rec => backfillRecord(rec)))
  } finally {
    ticking = false
  }
}

/** 回流态收账（清理挂派发记录生命周期）：bySession 里 running 态的 remote
 *  键若不再有对应记录（过期/被删/实例移除），随账清掉；done/failed 真终态
 *  保留供回看（与 pruneClosedSessions「不清真实终态」同一裁决）。页面内存态
 *  而已，刷新自归零 */
function pruneWithoutRecords(records: DispatchRecord[]): void {
  const tracked = new Set(records.map(rec => remoteTaskKey(rec.instanceId, rec.remoteSessionId)))
  const store = useAssistantTaskStore()
  for (const [key, entry] of Object.entries(store.bySession)) {
    if (!parseRemoteTaskKey(key)) continue
    if (!tracked.has(key) && entry.status !== 'done' && entry.status !== 'failed') {
      delete store.bySession[key]
      observedStatus.delete(key)
    }
  }
}

/** 单记录回流：拉对端事件流最新 task.progress，映射 + 终态沿通知 */
async function backfillRecord(rec: DispatchRecord): Promise<void> {
  if (settledRecords.has(rec.id)) return
  if (unsupportedInstances.has(rec.instanceId)) return
  const key = remoteTaskKey(rec.instanceId, rec.remoteSessionId)
  // 本页已观察到终态（即使记录尚未标收口——等下一轮统一收）：不再打扰
  const prev = observedStatus.get(key)
  if (prev === 'done' || prev === 'failed') {
    settledRecords.add(rec.id)
    return
  }
  let events: PeerTaskEvent[]
  try {
    const res = await instanceFetch<{ data?: PeerTaskEvent[] }>(
      rec.instanceId,
      'GET',
      `/agent-tasks?sessionId=${encodeURIComponent(rec.remoteSessionId)}&limit=5`,
    )
    events = res.data ?? []
  } catch (e) {
    // 404 = 对端版本无任务事件流端点：本页会话内降级跳过（探活矩阵 404 同
    // 惯例）；其余（网络抖动/423 锁定）静默，下一轮自愈
    if (e instanceof Error && e.message === '404') unsupportedInstances.add(rec.instanceId)
    return
  }
  const ev = events.find(t => t?.type === 'task.progress')
  if (!ev) return // 对端 agent 尚未上报（纯 shell/未用 ops-notify）：映射空态即无操作
  const status = ev.status || 'running'
  const store = useAssistantTaskStore()
  store.progressForRemote(key, { task: ev.task, status, step: ev.step }, {
    instanceId: rec.instanceId,
    instanceName: rec.instanceName || rec.instanceId,
    sessionName: rec.remoteSessionName || rec.remoteSessionId,
  })
  observedStatus.set(key, status)
  const meta = {
    instanceId: rec.instanceId,
    instanceName: rec.instanceName || rec.instanceId,
    sessionName: rec.remoteSessionName || rec.remoteSessionId,
  }
  const payload = { task: ev.task, status, step: ev.step, terminalId: key, remoteMeta: meta }
  if (status !== 'done' && status !== 'failed') {
    // 非终态：通知链内部仅记耗时起点（终态正文带耗时）——本地 WS 链同款
    handleAgentTaskProgressNotify(payload)
    return
  }
  // 终态沿 + 事件新鲜 → 既有通知链（防重复在其内部；terminalId 携 remote:
  // 键，agentTaskNotify 据此把直达跳转换成跳实例）。页面关闭期间错过的旧
  // 终态只映射状态不通知（补账不重放）
  if ((prev === undefined || prev === 'running')) {
    const at = Date.parse(ev.at || '') || 0
    if (Date.now() - at <= BACKFLOW_NOTIFY_FRESH_MS) {
      handleAgentTaskProgressNotify(payload)
    }
  }
  settledRecords.add(rec.id)
}
