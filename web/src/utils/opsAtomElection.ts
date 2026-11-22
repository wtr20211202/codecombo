// frontend 动词族设备效应的同浏览器标签选举（P-20261117-4）：
// 同一 browserId 的多标签各持独立 ops-channel WS 连接——定向广播到达时每个
// 标签都会收到，设备效应（下载框/剪贴板/开标签/重载）必须只执行一次。选举
// 取「本浏览器唯一执行标签」：
//   - 主路径 BroadcastChannel 竞选（同源同浏览器跨标签共享，含 headless 环境
//     ——e2e 实探 Web Locks 在 Playwright headless 的每页独立 lock manager 下
//     不跨页仲裁〔同锁名双页双 granted 实证〕，而 BroadcastChannel 同 context
//     跨页收发正常）：单阶段 claim 裁决——主张重发 40ms × 收集窗 120ms，窗内
//     全体主张按 pickElectionWinner 定Winner（确定性 tie-break：at 升序 → id
//     字典序），本标签是 winner 即执行、否则静默跳过；
//   - 回退 Web Locks API（无 BroadcastChannel 的极旧浏览器）：到达时 per-arrival
//     ifAvailable 取锁执行——真浏览器 lock manager 跨标签仲裁，恰一执行；
//   - 偏好可见标签（评审建议a：后台执锁 clipboard writeText 无焦点必败走中继
//     回落多一跳）：hidden 标签主张/取锁前让先 VISIBLE_BIAS_MS，前台标签抢跑。
// e2e 只烟测防 CI 抖（任务书明示）。本模块只做「是否由本标签执行」的裁决，
// 效应本体在 utils/frontendAtomActions（桥 OpsChannelBridge 到达侧调用
// executeFrontendEffect）。

/** 竞选候选（BroadcastChannel 主路径）：id 为标签随机 id，at 为主张时刻 */
export interface ElectionCandidate {
  id: string
  at: number
}

/** 确定性 winner：at 升序、平局 id 字典序——所有标签对同一候选集算出同一
 * winner，是竞选正确性的根（首版重采样 own-claim at 导致裁决分裂双执行，
 * 实测在案）。空集返回 null（无人主张 = 不执行，防御边界） */
export function pickElectionWinner(candidates: readonly ElectionCandidate[]): ElectionCandidate | null {
  let winner: ElectionCandidate | null = null
  for (const c of candidates) {
    if (!winner || c.at < winner.at || (c.at === winner.at && c.id < winner.id)) {
      winner = c
    }
  }
  return winner
}

/** 竞选收集窗（ms）：同进程 postMessage 往返 << 120ms（e2e 实测同浏览器双标签
 * 的 claim 同毫秒互达）。服务端对同浏览器多标签的 WS 投递是同一广播循环内的
 * 背靠背写出，到达偏差毫秒级，窗内必同窗相会。诚实边界：到达错窗 >120ms 的
 * 极端形态（接收方监听器尚未挂载即错过对方主张）可能双执行——宁冒极小概率
 * 双执行不丢效应（零执行不可恢复，双执行只是重复一次同内容效应） */
export const ELECTION_COLLECT_MS = 120

/** 可见标签让先的延迟（ms）：hidden 标签到达时等这一拍再主张/取锁，可见
 * 标签抢跑——确定性偏差量级（同一拍内的竞态仍由 winner tie-break/锁仲裁兜底） */
export const VISIBLE_BIAS_MS = 150

// —— 模块态（每标签一份）——

let tabId = ''
function ensureTabId(): string {
  if (!tabId) {
    tabId = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
  return tabId
}

/** 测试钩子：清模块级状态（用例间隔离，frontendAtomActions 同惯例） */
export function resetOpsAtomElectionForTest(): void {
  tabId = ''
  electionChannel?.close()
  electionChannel = null
  cleanupWired = false
}

// BroadcastChannel 通道（懒建；无该 API 的环境返回 null）
let electionChannel: BroadcastChannel | null = null
let cleanupWired = false
function ensureElectionChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!cleanupWired) {
    cleanupWired = true
    // 文档销毁收尾（BroadcastChannel 对象随文档回收本就无害，显式 close
    // 只为通道句柄即时释放；懒建期一次性接线，免独立 init 装配点）
    window.addEventListener('pagehide', () => {
      electionChannel?.close()
      electionChannel = null
    })
  }
  if (!electionChannel) electionChannel = new BroadcastChannel('sc-ops-atom-election')
  return electionChannel
}

type ElectionMsg = { kind: 'claim'; id: string; at: number }

function postElectionMsg(ch: BroadcastChannel, msg: ElectionMsg): void {
  ch.postMessage(msg)
}

function hiddenTab(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * BroadcastChannel 主路径竞选（单阶段 claim 裁决）：claim（收集窗）→ 窗内
 * 全体主张按 pickElectionWinner 定Winner，本标签是 winner 即执行。本标签
 * hidden 时延后主张（VISIBLE_BIAS_MS），给可见标签让先。
 * 正确性根：本标签主张以「广播时刻的 at」入册（不得重采样）——BroadcastChannel
 * 不回送发布者自身（规范语义）需显式补记，若补记时重采 Date.now() 会让各标签
 * 看到互相不一致的「同一主张」（自己的主张恒比对方的晚 120ms），winner 裁决
 * 分裂为两票各名对方 → 双执行（首版实测踩坑在案，E2E 多标签用例钉住）
 */
async function electViaChannel(run: () => void | Promise<void>): Promise<boolean> {
  const ch = ensureElectionChannel()
  if (!ch) return false
  const selfId = ensureTabId()
  const claims: ElectionCandidate[] = []
  const onMsg = (ev: MessageEvent) => {
    const m = ev.data as ElectionMsg | null
    if (!m || typeof m !== 'object') return
    if (m.kind === 'claim') claims.push({ id: m.id, at: m.at })
  }
  ch.addEventListener('message', onMsg)
  try {
    if (hiddenTab()) await wait(VISIBLE_BIAS_MS)
    const claimAt = Date.now()
    // 周期性重发主张（40ms 间隔）：对端标签的事件处理可能晚于本端首条 claim 的
    // 投递（WS 消息处理延迟 vs BC 直投的赛跑）——首条 claim 落在对方监听器挂载
    // 之前即被错过（双方各见独主张 → 双执行）。重发保证对方监听器存活期内必见
    // 本端主张（同 at 幂等，重复条目对 winner 裁决无影响）
    const repost = setInterval(() => postElectionMsg(ch, { kind: 'claim', id: selfId, at: claimAt }), CLAIM_REPOST_MS)
    postElectionMsg(ch, { kind: 'claim', id: selfId, at: claimAt })
    await wait(ELECTION_COLLECT_MS)
    clearInterval(repost)
    // BroadcastChannel 不回送发布者自身（规范语义），本标签主张显式补记——
    // at 用广播时刻原值（重采样即 winner 裁决分裂，见上注）
    claims.push({ id: selfId, at: claimAt })
    const winner = pickElectionWinner(claims)
    if (!winner || winner.id !== selfId) return false
    await run()
    return true
  } finally {
    ch.removeEventListener('message', onMsg)
  }
}

/** 主张重发间隔（ms）：收集窗 120ms 内至少 3 发，对方监听器晚挂 ≤40ms 亦必见 */
const CLAIM_REPOST_MS = 40

/**
 * Web Locks 回退（无 BroadcastChannel 的极旧浏览器）：到达时 per-arrival
 * ifAvailable 取锁——取得到在本锁内执行（锁随执行完成释放，无跨到达常驻态，
 * 免 hidden 释放/关闭回收的生命周期管理）；未取得 = 他标签在持，静默跳过。
 * hidden 标签先让 VISIBLE_BIAS_MS（前台抢跑）。真浏览器 lock manager 跨标签
 * 仲裁恰一执行；裁定等到 grant 回调落地为止（上限 LOCK_SETTLE_TIMEOUT_MS 防
 * pathological 挂死，超时按未取得保守跳过——效应零执行不可恢复，但该分支
 * 只服务无 BC 的旧浏览器，抖动代价小于臆测持锁）
 */
async function executeUnderArrivalLock(run: () => void | Promise<void>): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks) return false
  if (hiddenTab()) await wait(VISIBLE_BIAS_MS)
  const state: { verdict: 'pending' | 'granted' | 'rejected' } = { verdict: 'pending' }
  // holder 对象承载松锁句柄：TS 对 let 初值 null 的收窄看不到 executor 内赋值
  //（闭包跨函数边界），对象字段不参与收窄
  const holdCtrl: { release: (() => void) | null } = { release: null }
  const hold = new Promise<void>((resolve) => {
    holdCtrl.release = resolve
  })
  navigator.locks
    .request(ARRIVAL_LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) {
        state.verdict = 'rejected'
        return
      }
      state.verdict = 'granted'
      return hold
    })
    .catch(() => {
      /* 松锁竞态 aborted 无害 */
      if (state.verdict === 'pending') state.verdict = 'rejected'
    })
  const deadline = Date.now() + LOCK_SETTLE_TIMEOUT_MS
  while (state.verdict === 'pending' && Date.now() < deadline) {
    await wait(2)
  }
  if (state.verdict !== 'granted') return false
  try {
    await run()
  } finally {
    holdCtrl.release?.()
  }
  return true
}

/** per-arrival 锁名（Web Locks 回退路径专用；sc- 前缀避让页面自身锁面） */
const ARRIVAL_LOCK_NAME = 'sc-ops-atom-arrival'

/** ifAvailable 裁定等待上限（ms）：正常即刻落定（grant/拒绝都是即时回调），
 * 上限只防 pathological 挂死 */
const LOCK_SETTLE_TIMEOUT_MS = 500

/**
 * 设备效应执行入口（OpsChannelBridge 四个 onFrontendXxx 到达侧调用）：
 * 裁决「本标签是否执行」，执行则 await run() 并返回 true，否则 false（静默
 * 跳过——执行标签的可见 toast 是唯一反馈面，非执行标签不产生第二份）。
 * 仲裁面按环境能力择路：BroadcastChannel（主，跨标签共享含 headless）→
 * Web Locks（回退，无 BC 的旧浏览器）→ 直接执行（两皆无的极老环境，
 * best-effort 不丢效应）
 */
export async function executeFrontendEffect(run: () => void | Promise<void>): Promise<boolean> {
  if (typeof BroadcastChannel !== 'undefined') {
    return electViaChannel(run)
  }
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return executeUnderArrivalLock(run)
  }
  await run()
  return true
}
