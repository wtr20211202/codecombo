import { ref } from 'vue'
import { shareApi, type ShareDirectProjection } from '../api/domains/share'

/**
 * 直通输入持权锚点表（P-20261024-1「访客输入中」徽标 owner 侧数据面）：
 * sessionId → 持权投影，供终端 tab 徽标与右键「收回访客输入」消费。
 * useTerminalLiveShares 同款模块级单例（30s 惰性轮询 + 变更点即时 bump），
 * 数据源同为 GET /api/share 全量列表过滤——direct 投影是行字段（服务端
 * shareSvc 状态投影），轮询粒度 15s（持权滑动时效 10min，15s 粒度对
 * 「访客还在输入吗」的徽标语义绰绰有余；量级 = 分享数个位数，全量拉取
 * 代价可忽略）。
 *
 * P-20261106-8 起同一次列表拉取顺带重建可写分享的「访客输入中」锚点表
 *（writableBySession——wtyping 行字段同源投影，零额外请求）：可写上行
 * 连接在场即入表，徽标与「收回访客输入」动作复用同一消费面（收回方向
 * = setWritable off）。sc-ops:share.wtyping 广播是即时对账路，本表轮询
 * 是断线兜底，两路同源服务端状态。
 *
 * P-20261121-2 起同一次拉取再建待批申请锚点表（pendingByToken——
 * direct.pending 行字段同源投影，此前 pending 被显式丢弃、owner 面零
 * 投影零入口，申请-批准握手断裂的投影半边）：管理器行内「批准/拒绝」
 * 升格钮与会话行待批徽标的数据源。sc-ops:share.direct-request 广播是
 * 即时对账路（useLayoutShell toast 后 bump），15s 轮询是断线兜底。
 *
 * 消费面：AgentTerminalView（侧栏会话行橙点徽标 + 右键「收回访客输入」
 * ——直通 v1 限定 agent 会话，本管理页就是 owner 侧的会话常驻位）、
 * ShareManagerView（行内待批批准/拒绝钮 + 行内持权卡/一键收回）与
 * useLayoutShell（通知中心持权卡收回/申请卡批准动作）共享同一份状态；
 * 变更点（批准/收回/拒绝动作后）bump 即时对账。
 */

// DirectInputActive 单个持权投影（ShareDirectProjection + 分享锚点）
export interface DirectInputActive {
  token: string
  sessionId: string
  /** 持权访客摘要（visitorId 前 8 位） */
  visitorTail?: string
  nick?: string
  /** 持权剩余秒数（服务端滑动时效投影，<0 = 已过期等下轮对账摘除） */
  expiresIn?: number
  /** 可写分享来源（P-20261106-8）：true = 本条目来自可写上行连接（收回
   *  动作走 setWritable off 而非直通 revoke），消费面据此分流 */
  writable?: boolean
}

// DirectPending 一条待批申请投影（P-20261121-2）：token 键（管理器行
// 消费面按 token 对位；会话行徽标经 pendingBySession 取同源数据）
export interface DirectPending {
  token: string
  /** 申请访客摘要（visitorId 前 8 位） */
  visitorTail?: string
  nick?: string
  /** 申请剩余秒数（服务端时效投影，<0 = 已过期等下轮对账摘除） */
  expiresIn?: number
}

// POLL_MS 惰性轮询周期：对齐直播锚点表的 30s 档再加密一档（15s）——
// 徽标的「还在输入」语义比「直播还活着」更即时，但远高于输入频次
const POLL_MS = 15_000

const holdBySession = ref<Record<string, DirectInputActive>>({})
const pendingByToken = ref<Record<string, DirectPending>>({})
const pendingBySession = ref<Record<string, DirectPending>>({})

let pollTimer: ReturnType<typeof setInterval> | undefined
let refreshing = false
let rerunPending = false

/** refresh 拉全量分享列表重建锚点表（对账式整体替换；expiresIn<=0 的持权
 *  视同已回收——服务端惰性时效可能尚未触发，本地先摘。直通持权与可写
 *  上行同一张表：可写条目带 writable 标记，直通持权优先——同一会话两态
 *  并存时直通的「申请-批准」语义更具体。P-20261121-2 起同轮顺带建待批
 *  申请双表：pendingByToken（管理器行）+ pendingBySession（会话行徽标），
 *  expiresIn<=0 同款先摘——服务端惰性清扫可能尚未触发） */
export async function refreshDirectInputShares(): Promise<void> {
  if (refreshing) {
    rerunPending = true
    return
  }
  refreshing = true
  try {
    const res = (await shareApi.list()) as unknown as { data?: Array<{ token: string; kind?: string; terminalId?: string; direct?: ShareDirectProjection; wtyping?: { visitors?: number } }> }
    const next: Record<string, DirectInputActive> = {}
    const nextPending: Record<string, DirectPending> = {}
    const nextPendingBySession: Record<string, DirectPending> = {}
    for (const s of res.data || []) {
      if (!s.terminalId) continue
      if (s.direct?.held) {
        if ((s.direct.expiresIn ?? 1) > 0 && !next[s.terminalId]) {
          next[s.terminalId] = {
            token: s.token,
            sessionId: s.terminalId,
            visitorTail: s.direct.visitorTail,
            nick: s.direct.nick,
            expiresIn: s.direct.expiresIn,
          }
        }
        continue
      }
      // 待批申请在途（P-20261121-2）：行投影 direct.pending 即入双表
      //（此前此分支被 continue 显式丢弃——owner 面零待批投影的根因）
      if (s.direct?.pending) {
        if ((s.direct.expiresIn ?? 1) > 0 && !nextPending[s.token]) {
          nextPending[s.token] = {
            token: s.token,
            visitorTail: s.direct.visitorTail,
            nick: s.direct.nick,
            expiresIn: s.direct.expiresIn,
          }
          nextPendingBySession[s.terminalId] = nextPending[s.token]!
        }
        continue
      }
      // 可写分享上行在场（P-20261106-8）：visitors>0 即「访客输入中」
      if ((s.wtyping?.visitors ?? 0) > 0 && !next[s.terminalId]) {
        next[s.terminalId] = {
          token: s.token,
          sessionId: s.terminalId,
          nick: undefined,
          expiresIn: undefined,
          writable: true,
        }
      }
    }
    holdBySession.value = next
    pendingByToken.value = nextPending
    pendingBySession.value = nextPendingBySession
  } catch {
    // 列表拉取失败维持现状（下轮对账自愈）
  } finally {
    refreshing = false
    if (rerunPending) {
      rerunPending = false
      void refreshDirectInputShares()
    }
  }
}

/** bump 变更点即时对账：批准/收回/开关动作后调用，徽标即现即摘不等轮询 */
export function bumpDirectInputShares(): void {
  void refreshDirectInputShares()
}

/** useDirectInputShares 轮询宿主句柄：TerminalView 挂载 start、卸载 stop；
 *  读面 holdBySession + pendingByToken/pendingBySession（P-20261121-2） */
export function useDirectInputShares() {
  function start(): void {
    if (pollTimer) return
    void refreshDirectInputShares()
    pollTimer = setInterval(() => { void refreshDirectInputShares() }, POLL_MS)
  }
  function stop(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }
  return { holdBySession, pendingByToken, pendingBySession, start, stop, bump: bumpDirectInputShares }
}
