// WebSocket 生命周期小环（P-20261124-2 S1a④）：统一记录五处常驻通道 + 短命
// 通道的关闭/错误生命周期，替代此前「close code 分散六处、没人知道哪个通道
// 断了」的盲区。叶子模块：只依赖脱敏原语，不 import 任何 store/composable——
// 反向依赖会让 WS 消费方与本模块成环（useWebSocketBase ↔ 通知 store 先例）。
//
// 记录语义：
//   - 服务端/网络侧关闭（1006 异常、4001 锁定拒绝、1009 消息超限、1011 服务端
//     异常、1000/1001 正常关闭）由各通道 onclose 显式上报，逐码保留不折叠；
//   - 客户端主动 close()（实例切换/卸载/取消）的 close 事件通常报 1005（无状态
//     码）且 close 事件可能被 onclose=null 抑制——调用方必须显式传
//     intentional=true（见各埋点注释），不能靠 onclose 推断；
//   - 环上限 50：WS 重连风暴下高频条目自然淘汰最旧的，不占内存。

import { sanitizeMessage, sanitizeWsPath } from './diagSanitize'

export const WS_LIFECYCLE_LIMIT = 50
const REASON_MAX = 200

/** 关闭语义分类（人类/agent 扫读用，不替代原始 code） */
export type WsCloseKind =
  | 'normal'      // 1000/1001/主动关闭
  | 'abnormal'    // 1006（握手失败/网络中断/浏览器拿不到握手 HTTP 状态）
  | 'locked'      // 4001 应用保留段：锁定拒绝
  | 'message-too-big' // 1009
  | 'internal-error'  // 1011
  | 'error'       // 仅收到 onerror、未观察到 close code
  | 'unknown'

export interface WsLifecycleEntry {
  ts: string
  /** 模板化后的通道路径（无 host/query；如 /ws/terminal/:id） */
  path: string
  code: number
  closeKind: WsCloseKind
  /** 服务端/浏览器关闭原因，截断 200 字符并去绝对路径 */
  reason: string
  wasClean: boolean
  /** 连接存活时长 ms；openedAt 未知（open 前就失败）时缺省 */
  openMs?: number
  /** 该连接建立时的重连轮次（0 = 首次/无重连语义） */
  attempt: number
  /** true = 客户端主动关闭（close 事件被抑制或 1005） */
  intentional: boolean
}

let entries: WsLifecycleEntry[] = []

/** close code → 语义分类；intentional 优先（客户端 close() 常报 1005） */
export function wsCloseKindOf(code: number, intentional: boolean): WsCloseKind {
  if (code === 4001) return 'locked'
  if (code === 1009) return 'message-too-big'
  if (code === 1011) return 'internal-error'
  if (code === 1006) return 'abnormal'
  if (code === 0) return 'error'
  if (intentional || code === 1000 || code === 1001 || code === 1005) return 'normal'
  return 'unknown'
}

/**
 * 记录一次 WS 生命周期事件（叶子入口，位置参数与服务端字段口径一致）。
 * @param url 连接 URL（绝对/相对均可，入库前模板化）
 * @param code close code；仅 onerror 时为 0
 * @param reason close reason（可为空）
 * @param wasClean 浏览器 CloseEvent.wasClean
 * @param openedAt onopen 时刻的 Date.now()，未知传 0
 * @param attempt 重连轮次
 * @param intentional 客户端主动关闭（取消/卸载/实例切换）
 */
export function recordWsLifecycle(
  url: string,
  code: number,
  reason: string,
  wasClean: boolean,
  openedAt: number,
  attempt: number,
  intentional: boolean,
): void {
  const now = Date.now()
  entries.unshift({
    ts: new Date(now).toISOString(),
    path: sanitizeWsPath(url),
    code: Number.isFinite(code) ? code : 0,
    closeKind: wsCloseKindOf(code, intentional),
    reason: sanitizeMessage(reason, REASON_MAX),
    wasClean: !!wasClean,
    openMs: openedAt > 0 ? Math.max(0, now - openedAt) : undefined,
    attempt: Number.isFinite(attempt) ? attempt : 0,
    intentional: !!intentional,
  })
  if (entries.length > WS_LIFECYCLE_LIMIT) entries.length = WS_LIFECYCLE_LIMIT
}

/** 只读快照（拷贝条目，消费方改不坏环） */
export function getWsLifecycleEntries(): WsLifecycleEntry[] {
  return entries.map((e) => ({ ...e }))
}

export function clearWsLifecycle(): void {
  entries = []
}
