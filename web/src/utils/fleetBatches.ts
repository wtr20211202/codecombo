import type { RemoteTaskMeta, TaskProgressStep } from '../stores/assistantTask'

/**
 * 编队批聚合（P-20261005-145）：bulk-agent 批元数据（fleetBatch，随服务端
 * 会话快照 meta 反查下发）+ 任务进度 store（bySession 终态上报）→ 编队级
 * 视图。值班大屏聚合卡（MonitorView）与批级完成通知（useFleetBatchWatch）
 * 共用同一纯函数，计数口径只有一份。
 *
 * 终态口径（诚实边界）：done/failed 只认 task.progress 真实终态上报；未上报 /
 * 上报 running / 会话关闭后被清账的成员一律按 running 计——不虚构完成。
 * 「批完成」的活性因此依赖成员 agent 的终态上报（OSC133/task.progress 既有面）；
 * 纯 shell 成员永不收口（注记：可再以 tab.running+idle 阈值双信号兜底，MVP 不做）。
 */

/** 会话快照的编队批元数据（与服务端 store.FleetBatch 同形，缺 key = 非编队） */
export interface FleetBatchMeta {
  batchId: string
  launchedAt: string
  members: string[]
}

export type FleetMemberStatus = 'done' | 'failed' | 'running'

/** 聚合卡成员行（roster 全量呈现；live=false 的行不可跳转） */
export interface FleetMemberRow {
  id: string
  /** 显示名：存活会话名优先，其余回落远程元数据/任务名（展示端再兜「未知会话」） */
  name: string
  projectId: string
  status: FleetMemberStatus
  /** 会话表内存活（点击跳转的前提；关闭成员行只读呈现） */
  live: boolean
}

export interface FleetBatchView {
  batchId: string
  /** 编队显示名：全体成员同名的「fleet: x」取首个存活成员名，兜底 batchId */
  name: string
  launchedAt: string
  total: number
  done: number
  failed: number
  running: number
  members: FleetMemberRow[]
}

/** bySession 条目形状（assistantTask store 结构子集，便于单测构造） */
export type FleetBySessionEntry = {
  task: string
  step: string
  status: string
  updatedAt: number
  steps: TaskProgressStep[]
  remote?: RemoteTaskMeta
}

/** 成员终态解析：done/failed 真终态之外一律 running（见文件头诚实边界） */
export function fleetMemberStatus(bySession: Record<string, FleetBySessionEntry>, id: string): FleetMemberStatus {
  const s = bySession[id]?.status
  if (s === 'done' || s === 'failed') return s
  return 'running'
}

/** 成员显示名解析：存活会话名 → 回流自带会话名 → 任务名 → 空（展示端兜底） */
function memberName(
  sessionName: string | undefined,
  entry: FleetBySessionEntry | undefined,
): string {
  if (sessionName) return sessionName
  if (entry?.remote?.sessionName) return entry.remote.sessionName
  if (entry?.task) return entry.task
  return ''
}

/**
 * 聚合全部编队批（纯函数）：以存活会话携带的 fleetBatch 为批入口（成员全会
 * 关闭的批自然消失——追踪面只对还有落点的编队有意义，完成的批由通知承载），
 * roster 按 meta.members 花名册展开（含已关闭成员，计数不缩水）。
 * 批序 = 发起时间倒序（最新编队在上）；成员序 = 创建序。
 */
export function collectFleetBatches(
  sessions: Array<{ id: string; name: string; projectId: string; fleetBatch?: FleetBatchMeta }>,
  bySession: Record<string, FleetBySessionEntry>,
): FleetBatchView[] {
  const byId = new Map(sessions.map(s => [s.id, s]))
  const batches = new Map<string, FleetBatchView>()
  for (const s of sessions) {
    if (!s.fleetBatch?.batchId || batches.has(s.fleetBatch.batchId)) continue
    const meta = s.fleetBatch
    const members: FleetMemberRow[] = (meta.members ?? []).map(id => {
      const live = byId.get(id)
      return {
        id,
        name: memberName(live?.name, bySession[id]),
        projectId: live?.projectId || '',
        status: fleetMemberStatus(bySession, id),
        live: !!live,
      }
    })
    batches.set(meta.batchId, {
      batchId: meta.batchId,
      // 编队名：首个存活成员名（同批同名「fleet: x」）；全体关闭不可能走到
      // 这里（批入口就是存活会话），防御性兜 batchId
      name: members.find(m => m.live && m.name)?.name || s.name || meta.batchId,
      launchedAt: meta.launchedAt || '',
      total: members.length,
      done: members.filter(m => m.status === 'done').length,
      failed: members.filter(m => m.status === 'failed').length,
      running: members.filter(m => m.status === 'running').length,
      members,
    })
  }
  return [...batches.values()].sort((a, b) =>
    (Date.parse(b.launchedAt) || 0) - (Date.parse(a.launchedAt) || 0))
}
