import { defineStore } from 'pinia'
import { REMOTE_TASK_PREFIX } from '../utils/remoteTaskKey'
import { opsTaskApi, type ActiveOpsTask } from '../api/domains/opstask'
import { registerReconnectRefetch } from '../composables/reconnectRefetch'

/**
 * 智能体任务进度状态（Agent Loop 的前端感知层）：
 * - 底层智能体执行中经 /api/ops-notify 上报 task.progress 事件，
 *   useOpsChannel 分发为 sc-ops:task.progress window 事件，由 OpsChannelBridge 写入本 store
 * - 收起后的悬浮球/迷你进度窗读取本 store 实时渲染
 * - 陈旧失联预警（P-20261003-303）：agent 是外部进程，服务端无存活真相——
 *   进程崩溃/断网/被关时 done/failed 永不到达，消费面会永远显示 running。
 *   running 态超时无上报即渲染「可能已失联」弱化预警（不清数据，真终态到达
 *   仍可覆盖）；会话关闭经 terminals.changed 快照对账清账（pruneClosedSessions）
 * - 联邦派发回流（P-20261004-131）：对端会话进度经 useFleetTaskBackflow 轮询
 *   映射进 bySession，键走 remote: 命名空间（utils/remoteTaskKey），条目携带
 *   remote 元数据供悬浮球/监控卡标实例徽标
 * - 重启恢复补账（P-20261004-120）：bySession 是纯内存态，刷新/重启后全灭，
 *   agent 下一条 progress 上报（慢步骤可达数分钟）前监控面是盲区——
 *   seedActive 挂载/重连即拉 GET /api/ops-tasks/active（服务端 per-session
 *   最近上报缓存）回填，asks/approvals/progress 三大瞬态面补账齐套
 */

/** task.progress.steps 清单项（P-20261004-7）：结构化步骤清单，服务端发布口已规整 */
export interface TaskProgressStep {
  name: string
  done: boolean
}

/** 远程进度条目元数据（P-20261004-131）：实例徽标与显示名的来源标注 */
export interface RemoteTaskMeta {
  instanceId: string
  /** 实例展示名（派发时刻快照，实例改名/删除后徽标仍有源可标） */
  instanceName: string
  /** 对端会话名（本地会话表查不到远程会话，显示名随回流自带） */
  sessionName: string
}

/** 清单规整（防各上报路径的畸形项）：仅保留带非空 name 的项，done 严格布尔 */
function normSteps(steps?: TaskProgressStep[] | null): TaskProgressStep[] {
  return (steps ?? [])
    .filter(s => !!s && typeof s.name === 'string' && s.name.trim() !== '')
    .map(s => ({ name: s.name.trim(), done: s.done === true }))
}

/** 陈旧阈值（P-20261003-303）：running 且超此时长无 task.progress 上报即视为
 *  「可能失联」。10 分钟保守值起步（agent 长步骤无上报的误报以弱样式容忍，
 *  不清数据不弹窗）——常量留设置项余地，暂不设面板 */
export const TASK_STALE_MS = 10 * 60_000

/** 陈旧纯判定（thresholdMs 注入可测）：仅 running 态会陈旧——done/failed 是
 *  终态，陈旧无意义；updatedAt=0（从未上报）不算 */
export function isTaskStale(
  status: string | undefined,
  updatedAt: number,
  now: number,
  thresholdMs = TASK_STALE_MS,
): boolean {
  return status === 'running' && updatedAt > 0 && now - updatedAt >= thresholdMs
}

/** 陈旧判定心跳间隔：getter 只对响应式依赖重算，Date.now() 不 tick 则失联
 *  徽标在阈值跨过后永不点亮（agent 已死、无人再写 store）——低频心跳推进
 *  nowTick 让陈旧判定随时间自愈。30s 足够（徽标是弱预警，无实时承诺） */
const STALE_HEARTBEAT_MS = 30_000

/** 模块级心跳句柄（懒启动：首次进度上报才起；store 生命周期同页面，无需清理——
 *  单测经 resetForTest 显式清防 vitest worker 挂定时器不退） */
let staleHeartbeat: ReturnType<typeof setInterval> | null = null

export const useAssistantTaskStore = defineStore('assistantTask', {
  state: () => ({
    /** 是否有进行中的任务（发送中或智能体上报 running） */
    active: false,
    /** 任务简称（用户消息摘要或智能体上报的 task 字段） */
    task: '',
    /** 当前步骤描述（智能体上报的 step 字段）；steps 在位时视为当前项指针 */
    step: '',
    /** 结构化步骤清单（P-20261004-7）：首报带全量、后续整包替换（最后一份为准）；
     *  无 steps 字段的上报保留既有清单——单句 step 进度不打断清单展示 */
    steps: [] as TaskProgressStep[],
    /** running | done | failed | '' */
    status: '',
    updatedAt: 0,
    /** 会话粒度进度归属（P7）：terminalId（CC_TERMINAL_ID）→ 最近一次上报。
     *  带 terminalId 的 task.progress 写这里；悬浮球/条的点击跳转取时间戳
     *  最新的那条作为「进度所属会话」。联邦派发回流（P-20261004-131）写
     *  remote:<instanceId>:<sessionId> 键，条目带 remote 元数据（徽标来源） */
    bySession: {} as Record<string, { task: string; step: string; status: string; updatedAt: number; steps: TaskProgressStep[]; remote?: RemoteTaskMeta }>,
    /** 陈旧判定时钟（P-20261003-303）：心跳低频推进（STALE_HEARTBEAT_MS），
     *  让 isStale/staleSessionIds 随时间重算；0 = 心跳未启动（无任务态无谓计算） */
    nowTick: 0,
  }),
  getters: {
    /** 进度所属会话（bySession 中 updatedAt 最新的）；无归属上报时为 null */
    latestSessionId(state): string | null {
      let best: string | null = null
      let bestAt = -1
      for (const [sid, v] of Object.entries(state.bySession)) {
        if (v.updatedAt > bestAt) {
          bestAt = v.updatedAt
          best = sid
        }
      }
      return best
    },
    /** 全局进度是否可能失联（P-20261003-303）：running 且超时无上报。
     *  progressFor 透传全局字段，全局 updatedAt 与最新归属会话同拍——悬浮
     *  球/管理页状态点（消费全局字段）据此弱化展示 */
    isStale(state): boolean {
      return isTaskStale(state.status, state.updatedAt, state.nowTick || Date.now())
    },
    /** 可能失联的会话 id 集合（值班大屏逐卡判定消费；随心跳重算） */
    staleSessionIds(state): Set<string> {
      const now = state.nowTick || Date.now()
      const out = new Set<string>()
      for (const [sid, v] of Object.entries(state.bySession)) {
        if (isTaskStale(v.status, v.updatedAt, now)) out.add(sid)
      }
      return out
    },
    /** 悬浮条/球显示的任务文本：优先归属会话的任务，否则全局任务 */
    displayTask(state): string {
      const sid = this.latestSessionId
      if (sid && state.bySession[sid]?.task) return state.bySession[sid]!.task
      return state.task
    },
    /** 悬浮条/球显示的步骤清单：优先归属会话，否则全局（P-20261004-7） */
    displaySteps(state): TaskProgressStep[] {
      const sid = this.latestSessionId
      if (sid && state.bySession[sid]?.steps.length) return state.bySession[sid]!.steps
      return state.steps
    },
  },
  actions: {
    /** 陈旧判定心跳（懒启动）：首次进度上报才起——无任务态零开销；常驻单例
     *  写一个数字的开销可忽略，随页面生命周期终结（单测经 resetForTest 清） */
    ensureStaleHeartbeat() {
      if (staleHeartbeat !== null) return
      this.nowTick = Date.now()
      staleHeartbeat = setInterval(() => { this.nowTick = Date.now() }, STALE_HEARTBEAT_MS)
    },
    progress(p: { task?: string; status?: string; step?: string; steps?: TaskProgressStep[] | null }) {
      this.ensureStaleHeartbeat()
      this.active = true
      if (p.task) this.task = p.task
      this.status = p.status || 'running'
      if (p.step !== undefined) this.step = p.step
      if (p.steps !== undefined) this.steps = normSteps(p.steps)
      this.updatedAt = Date.now()
    },
    /** 带会话归属的上报（task.progress.payload.terminalId 非空时）：
     *  写 bySession，同时透传全局字段（管理页状态点等旧消费方不感知变化） */
    progressFor(sessionId: string, p: { task?: string; status?: string; step?: string; steps?: TaskProgressStep[] | null }) {
      this.progress(p)
      this.progressForSession(sessionId, p)
    },
    /** 仅写会话归属表（progressFor 的归属半边，不透传全局字段）：重启补账
     *  逐条回填用——全局字段由 applyActiveSnapshot 按所有已应用条目的最新
     *  服务端时刻统一裁决（快照与实时广播竞态下旧条目不得倒退全局态） */
    progressForSession(sessionId: string, p: { task?: string; status?: string; step?: string; steps?: TaskProgressStep[] | null }) {
      const prev = this.bySession[sessionId]
      this.bySession[sessionId] = {
        task: p.task ?? prev?.task ?? '',
        step: p.step ?? prev?.step ?? '',
        status: p.status || prev?.status || 'running',
        steps: p.steps !== undefined ? normSteps(p.steps) : (prev?.steps ?? []),
        updatedAt: Date.now(),
      }
    },
    /** 联邦派发回流上报（P-20261004-131）：remote: 命名空间键 + 实例元数据。
     *  全局字段同样透传（远程任务也是「有活在跑」，悬浮球呼吸/收起判断同口径
     *  消费）；meta 逐次整包替换（实例改名等快照随最新回流到位） */
    progressForRemote(
      key: string,
      p: { task?: string; status?: string; step?: string; steps?: TaskProgressStep[] | null },
      meta: RemoteTaskMeta,
    ) {
      this.progressFor(key, p)
      const prev = this.bySession[key]
      if (prev) prev.remote = meta
    },
    finish(status = 'done') {
      this.active = false
      this.status = status
      this.updatedAt = Date.now()
    },
    /** 关闭清账（P-20261003-303）：terminals.changed 快照 / GET /terminals 对账——
     *  本机终端会话是 task.progress 归属（CC_TERMINAL_ID）的唯一合法来源，快照
     *  活着名单之外的归属即死会话。只清 running 态条目（done/failed 真终态
     *  保留供回看，与「关闭清账不清真实终态」的风险注记一致）；最新归属被清
     *  且再无 running 归属时收敛全局态——不清则值班大屏 globalTaskCard 兜底卡
     *  会以「无归属 running」形态续显，死会话假阳性换了个位置。
     *  remote: 命名空间键（P-20261004-131）不参与本地快照对账——远程会话不在
     *  本机 terminals 快照里是常态而非死亡，其收账挂派发记录生命周期
     *  （useFleetTaskBackflow 的 pruneWithoutRecords） */
    pruneClosedSessions(aliveIds: string[]) {
      const alive = new Set(aliveIds)
      const latest = this.latestSessionId
      let latestPruned = false
      for (const sid of Object.keys(this.bySession)) {
        if (sid.startsWith(REMOTE_TASK_PREFIX)) continue
        if (alive.has(sid)) continue
        if (this.bySession[sid]?.status !== 'running') continue
        delete this.bySession[sid]
        if (sid === latest) latestPruned = true
      }
      if (!latestPruned) return
      if (this.status !== 'running') return
      const anyRunning = Object.values(this.bySession).some(v => v.status === 'running')
      if (anyRunning) return
      // 收敛为空态而非 done/failed——不是真实终态（真终态仍以 agent 上报为准），
      // 只是「归属主体已消失」的客户端对账
      this.active = false
      this.status = ''
    },
    /** 仅供测试使用：清空全部状态并停掉陈旧心跳（防 vitest worker 挂定时器） */
    resetForTest() {
      if (staleHeartbeat !== null) {
        clearInterval(staleHeartbeat)
        staleHeartbeat = null
      }
      this.active = false
      this.task = ''
      this.step = ''
      this.steps = []
      this.status = ''
      this.updatedAt = 0
      this.bySession = {}
      this.nowTick = 0
    },
    /** 重启恢复补账（P-20261004-120）：逐条回填服务端 active 快照。归属表写入
     *  复用实时链同一套字段合并规则（progressForSession），全局字段按快照内
     *  最新一条统一落位（等价于逐事件到达的净效果）；零通知重放（agentTaskNotify
     *  通知链、未读点均不触发——补账不重放，fleet 回流同裁决），也不清既有
     *  条目（快照缺席的实时条目不抹）。
     *  服务端 receivedAt 升序到达；同会话已有更新的实时条目时跳过该条目——
     *  seed 的 GET 在途期间可能先到新广播（断线重连场景尤甚），旧快照不得
     *  倒退覆盖新进度；全局时刻只前进不后退（updatedAt 是引用同一时钟的
     *  「最近上报时刻」比较口径） */
    applyActiveSnapshot(entries: ActiveOpsTask[]) {
      let newestAt = 0
      let newestPayload: ActiveOpsTask['payload'] | null = null
      for (const e of entries ?? []) {
        if (!e || !e.sessionId || !e.payload) continue
        const at = e.receivedAt > 0 ? e.receivedAt : 0
        const prev = this.bySession[e.sessionId]
        if (prev && at > 0 && prev.updatedAt >= at) continue
        this.progressForSession(e.sessionId, e.payload)
        if (at > 0) {
          // 条目时刻对齐服务端 receivedAt：陈旧判活的诚实时钟——页面关闭
          // 期间的沉默在补账后立刻如实计入陈旧，而非从补账时刻重新起算
          //（10min 阈值复用 P-303 既有口径，零新常量）
          this.bySession[e.sessionId]!.updatedAt = at
          if (at >= newestAt) {
            newestAt = at
            newestPayload = e.payload
          }
        }
      }
      // 全局字段（悬浮球/兜底卡/管理页状态点）取快照内最新一条且不早于
      // 既有全局时刻：终态条目落位后净效果与实时链「终态+归属」一致
      //（active 保持可见，沉淀入口依赖该形态）
      if (newestPayload && newestAt >= this.updatedAt) {
        this.progress(newestPayload)
        this.updatedAt = newestAt
      }
    },
    /** 重启恢复补账入口：拉 GET /api/ops-tasks/active（服务端 per-session
     *  最近上报缓存，瞬态内存面）回填 bySession/全局字段。OpsChannelBridge
     *  挂载即拉（锁定引导期挂起、解锁落定即拉——approvals.seedPending 同款
     *  时序）+ ops 通道重连补拉（reconnectRefetch 注册表 assistantTask 域）；
     *  拉取失败静默（WS 广播兜底增量，agent 下一条上报自会续上） */
    async seedActive() {
      try {
        // 响应解包约定：axios 拦截器已返回 gin body，业务负载在 res.data
        const res = (await opsTaskApi.listActive()) as unknown as { data?: { tasks?: ActiveOpsTask[] } }
        this.applyActiveSnapshot(res?.data?.tasks ?? [])
      } catch { /* 快照拉取失败不阻塞（WS 广播兜底增量） */ }
    },
  },
})

// ops 通道重连补拉（P-20261003-236 注册表）：断线窗口期的 task.progress 广播
// 不可回放，重连成功即 seedActive 全量对账——approvals 域注册同款形态
registerReconnectRefetch('assistantTask', () => { void useAssistantTaskStore().seedActive() })
