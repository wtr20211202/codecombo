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
 * 消费面：AgentTerminalView（侧栏会话行橙点徽标 + 右键「收回访客输入」
 * ——直通 v1 限定 agent 会话，本管理页就是 owner 侧的会话常驻位）、
 * ShareManagerView（行内持权卡/一键收回）与 useLayoutShell（通知中心
 * 持权卡收回动作）共享同一份状态；变更点（批准/收回动作后）bump 即时
 * 对账。
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
}

// POLL_MS 惰性轮询周期：对齐直播锚点表的 30s 档再加密一档（15s）——
// 徽标的「还在输入」语义比「直播还活着」更即时，但远高于输入频次
const POLL_MS = 15_000

const holdBySession = ref<Record<string, DirectInputActive>>({})

let pollTimer: ReturnType<typeof setInterval> | undefined
let refreshing = false
let rerunPending = false

/** refresh 拉全量分享列表重建锚点表（对账式整体替换；expiresIn<=0 的持权
 *  视同已回收——服务端惰性时效可能尚未触发，本地先摘） */
export async function refreshDirectInputShares(): Promise<void> {
  if (refreshing) {
    rerunPending = true
    return
  }
  refreshing = true
  try {
    const res = (await shareApi.list()) as unknown as { data?: Array<{ token: string; kind?: string; terminalId?: string; direct?: ShareDirectProjection }> }
    const next: Record<string, DirectInputActive> = {}
    for (const s of res.data || []) {
      if (!s.direct?.held || !s.terminalId) continue
      if ((s.direct.expiresIn ?? 1) <= 0) continue
      if (!next[s.terminalId]) {
        next[s.terminalId] = {
          token: s.token,
          sessionId: s.terminalId,
          visitorTail: s.direct.visitorTail,
          nick: s.direct.nick,
          expiresIn: s.direct.expiresIn,
        }
      }
    }
    holdBySession.value = next
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
 *  读面只有 holdBySession */
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
  return { holdBySession, start, stop, bump: bumpDirectInputShares }
}
