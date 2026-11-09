import { ref } from 'vue'
import { shareApi, type ShareInfo } from '../api/domains/share'

/**
 * 活跃终端直播锚点表（P-20261005-161 主播侧可见性）：sessionId → 活跃
 * kind=terminal 分享投影，供终端 tab 红点徽标与右键「结束直播」消费。
 *
 * 数据源 = GET /api/share 全量列表过滤（服务端无 share 域广播事件，直播
 * 创建/撤销/轮换的对账走 30s 惰性轮询 + 变更点即时 bump 双通道）：
 * - 创建（tab 右键「直播分享」/agent 代开 POST /api/share/terminal）：前者
 *   创建成功即 bump 即现，后者最迟下轮轮询点亮；
 * - 撤销/轮换（本页右键「结束直播」/分享管理页同族动作）：动作点 bump 即摘；
 * - 过期（TTL 30 分钟～24h）：列表过滤 expiresAt + 徽标 title 的 now tick
 *   双重判定，TTL 到界即摘（不等服务端 CleanupExpired 巡检）。
 *
 * 观看数口径：取分享记录既有 hits（P-20261002-14 累计打开次数）——liveterm
 * hub 的实时订阅计数无 API 出口，前端零 Go 改动约束下这是唯一可得口径。
 *
 * 模块级单例（useShareDialog 同范式）：TerminalView（底部终端）、
 * AgentTerminalView（终端会话管理页）、创建/撤销动作点共享同一份状态，无跨
 * 组件接线成本。徽标投影（title 文案）收口在 useTerminalShareActions（双入口
 * 共用件，P-20261106-7 起）。
 *
 * 轮询宿主引用计数（P-20261106-7）：start/stop 可被多宿主并存调用（底部终端
 * tab 挂载与管理页挂载互不同步——BottomPanel 的 TerminalView 是 v-if 惰性
 * 挂载，管理页开着自己的轮询时卸载底部终端不得掐掉共享定时器），计数归零才
 * 真正停表。单宿主语义与历史版本一致（挂载 start、卸载 stop）。
 */

// LiveShareActive 单个活跃直播投影（ShareInfo 子集，徽标 title 与撤销动作所需）
export interface LiveShareActive {
  token: string
  name: string
  /** 过期时点（ISO）：缺省 = 无 TTL（理论不出现，服务端钳 24h 上限） */
  expiresAt?: string
  /** 累计打开次数（P-20261002-14 口径，0/缺省 = 未被看过） */
  hits?: number
}

// POLL_MS 惰性轮询周期：对齐分享管理页倒计时 tick 的 30s 档——直播创建/撤销
// 的主流路径都有即时 bump 兜底，轮询只服务 agent 代开等带外变更，无需更密
const POLL_MS = 30_000

const liveBySession = ref<Record<string, LiveShareActive>>({})
// 倒计时基准（P-20261106-7 起）：与轮询同一定时器同点自 tick——徽标 title 的
// 剩余时长随轮询周期重算（分钟级展示不需要秒针精度），不再各宿主自备 tick
const nowTick = ref(Date.now())

let pollTimer: ReturnType<typeof setInterval> | undefined
let hostCount = 0
let refreshing = false
let rerunPending = false

/** isExpired TTL 判定（本机时钟；expiresAt 缺省按未过期处理，交由下轮对账） */
function isExpired(s: ShareInfo, now: number): boolean {
  return !!s.expiresAt && new Date(s.expiresAt).getTime() <= now
}

/** refresh 拉全量分享列表重建锚点表（对账式整体替换，撤销/过期即消失）。
 *  并发收敛：进行中再触发只记一次重跑（撤销风暴下不堆请求） */
export async function refreshTerminalLiveShares(): Promise<void> {
  if (refreshing) {
    rerunPending = true
    return
  }
  refreshing = true
  try {
    // 拦截器已解包 envelope：返回值即 {data: [...]}（useShareDialog 同款断言）
    const res = (await shareApi.list()) as unknown as { data?: ShareInfo[] }
    const next: Record<string, LiveShareActive> = {}
    const now = Date.now()
    for (const s of res.data || []) {
      if (s.kind !== 'terminal' || !s.terminalId || isExpired(s, now)) continue
      // 服务端同会话 get-or-create 幂等恒同链（至多一条）；防御式保留首条
      if (!next[s.terminalId]) {
        next[s.terminalId] = { token: s.token, name: s.name, expiresAt: s.expiresAt, hits: s.hits }
      }
    }
    liveBySession.value = next
  } catch {
    // 列表拉取失败维持现状（下轮对账自愈），不打扰主播
  } finally {
    refreshing = false
    if (rerunPending) {
      rerunPending = false
      void refreshTerminalLiveShares()
    }
  }
}

/** bump 变更点即时对账：创建/撤销/轮换/改 TTL 后调用，徽标即现即摘不等轮询 */
export function bumpTerminalLiveShares(): void {
  void refreshTerminalLiveShares()
}

/** useTerminalLiveShares 轮询宿主句柄：宿主挂载 start、卸载 stop（引用计数，
 *  多宿主并存共享同一定时器——最后一个宿主离场才真正停表）；读面
 *  liveBySession（锚点表）与 now（倒计时基准，徽标 title 投影用），投影文案
 *  由宿主侧（useTerminalShareActions.liveTitles）收口 */
export function useTerminalLiveShares() {
  function start(): void {
    hostCount++
    if (hostCount > 1) return
    nowTick.value = Date.now()
    void refreshTerminalLiveShares()
    pollTimer = setInterval(() => {
      nowTick.value = Date.now()
      void refreshTerminalLiveShares()
    }, POLL_MS)
  }
  function stop(): void {
    if (hostCount > 0) hostCount--
    if (hostCount === 0 && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }
  return { liveBySession, now: nowTick, start, stop, bump: bumpTerminalLiveShares }
}
