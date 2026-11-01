import { computed, ref } from 'vue'
import { agentChainApi } from '../api/domains/agentchain'
import type { AgentChainItem } from '../api/domains/agentchain'
import {
  OPS_CHAIN_TRIGGERED,
  OPS_TERMINAL_MESSAGE,
  OPS_TERMINAL_MESSAGE_READ,
  type ChainTriggeredDetail,
  type TerminalMessageDetail,
  type TerminalMessageReadDetail,
} from '../utils/opsEvents'

/**
 * 值班大屏 agent 协作流（P-20261008-6）：多 agent 协作两基建（定向消息
 * P-20261004-68 / 接续链 P-20261004-38）的值班人观察面——
 * terminal.message / terminal.message.read / chain.triggered 三枚 ops 直通
 * 分发窗口事件（useOpsChannel 桥接，opsEvents.ts 常量）的纯前端时间线聚合
 * + 链健康清单。
 *
 * 数据姿态：纯事件驱动零轮询（对比 useChangeStream 的 5s 轮询拉服务端快照；
 * 本流的三个事件源是服务端广播的瞬时事实，无历史查询端点——消息正文是敏感
 * 面，只走收件箱 GET drain，值班卡不可拉不可回放）。时间线自「本标签页加载
 * 起」累积、上限封顶截旧（前端内存观测面，与 ChangeStream 服务端环形缓冲同
 * 哲学）；链清单可全量回填（GET /api/agent-chains），挂载进大屏拉一次 +
 * chain.triggered 触达即重读（useAgentChain 面板同纪律，免轮询）。
 *
 * 模块级单例 + 首次 use 常驻挂窗监听（不随卡卸载摘除）：事件是广播瞬时值，
 * 卡未挂载期间（值班人在别的页）错过的行同样不可回放——常驻监听让「离开
 * 大屏再回来」时间线不断档；量级 = 三枚低频事件 × 60 行环形，可忽略。
 */

/** 时间线最大行数（新→旧，超出截旧——视图滚动区有界，不随事件风暴增长） */
export const COLLAB_STREAM_MAX_ROWS = 60
/** 链冷却注记展示口径：与服务端 triggerCooldown（server/api/agentchain 1 分钟）
 * 镜像，仅作「刚触发过」的展示注记，不参与任何判定（真值在服务端三道闸） */
export const COLLAB_CHAIN_COOLDOWN_MS = 60_000

/** 时间线行：三事件源各一形态（id = 模块级自增序号键，同毫秒事件不撞 :key） */
export interface CollabMessageRow {
  kind: 'message'
  id: string
  /** 投递时刻（服务端载荷 at，epoch ms） */
  at: number
  /** 发送方会话 id（X-Session-ID / CC_TERMINAL_ID 同一命名空间） */
  fromId: string
  /** 目标会话 id（未读徽标挂靠锚点同源） */
  toId: string
  /** 正文首行速览（服务端 ≤80 rune，原文透传；全文只在收件箱面） */
  summary: string
}
export interface CollabReadRow {
  kind: 'read'
  id: string
  /** 拉取到达时刻（读广播无时刻字段，接收侧记） */
  at: number
  /** 拉取方会话 id */
  sessionId: string
  /** 本次拉取到的留言条数 */
  count: number
}
export interface CollabChainRow {
  kind: 'chain'
  id: string
  /** 触发到达时刻（广播无时刻字段，接收侧记） */
  at: number
  chainId: string
  /** 链源会话 id（上一棒） */
  sourceId: string
  /** 拉起的下一棒会话 id */
  nextId: string
  /** 链源终态 done / failed（后者仅 onFailure=true 链） */
  status: string
}
export type CollabRow = CollabMessageRow | CollabReadRow | CollabChainRow

// ── 模块级单例状态（监听随首次 use 安装且常驻；多实例共享同一份流） ──
const rows = ref<CollabRow[]>([])
const chains = ref<AgentChainItem[]>([])
const chainsLoaded = ref(false)
const chainsFailed = ref(false)
let rowSeq = 0
let listenersInstalled = false

function pushRow(row: CollabRow): void {
  rows.value = [row, ...rows.value].slice(0, COLLAB_STREAM_MAX_ROWS)
}

/** 链清单全量回填（挂载进大屏 / chain.triggered / 大屏 refreshAll 三触发点；
 * 失败静默保旧——值班正盯的清单闪空比短暂陈旧更糟，useChangeStream 同姿态） */
async function refreshChains(): Promise<void> {
  try {
    const res = await agentChainApi.list()
    chains.value = (res?.data || []) as AgentChainItem[]
    chainsFailed.value = false
    chainsLoaded.value = true
  } catch {
    chainsFailed.value = true
  }
}

function installListeners(): void {
  if (listenersInstalled) return
  listenersInstalled = true
  // 定向消息到达：「A → B 留言」行（载荷只带首行摘要与元数据，无正文）
  window.addEventListener(OPS_TERMINAL_MESSAGE, (e: Event) => {
    const d = (e as CustomEvent<TerminalMessageDetail>).detail || {}
    if (!d.to) return
    pushRow({
      kind: 'message',
      id: `collab-${++rowSeq}`,
      at: typeof d.at === 'number' ? d.at : Date.now(),
      fromId: String(d.from ?? ''),
      toId: String(d.to),
      summary: String(d.summary ?? ''),
    })
  })
  // 收件箱已读：「B 已读 N 条」行（读事实广播，徽标清除的同一事件源）
  window.addEventListener(OPS_TERMINAL_MESSAGE_READ, (e: Event) => {
    const d = (e as CustomEvent<TerminalMessageReadDetail>).detail || {}
    if (!d.sessionId) return
    pushRow({
      kind: 'read',
      id: `collab-${++rowSeq}`,
      at: Date.now(),
      sessionId: String(d.sessionId),
      count: typeof d.count === 'number' && d.count > 0 ? d.count : 1,
    })
  })
  // 接续链触发：「B 接续 A」行 + 链清单增量重读（棒数/冷却注记对账，免轮询）
  window.addEventListener(OPS_CHAIN_TRIGGERED, (e: Event) => {
    const d = (e as CustomEvent<ChainTriggeredDetail>).detail
    if (!d?.chainId || !d.sessionId) return
    pushRow({
      kind: 'chain',
      id: `collab-${++rowSeq}`,
      at: Date.now(),
      chainId: String(d.chainId),
      sourceId: String(d.sourceTerminalId ?? ''),
      nextId: String(d.sessionId),
      status: String(d.status ?? ''),
    })
    void refreshChains()
  })
}

/** 链触发棒数（展示口径）：triggerCount + 1——链源为第 1 棒，第 n 次触发拉起
 * 第 n+1 棒（服务端深度闸对「链源自身也是链拉起」的深链另有权威记账且未出
 * API；本口径与提案「triggerCount/lastSessionId（走到哪棒）」一致，纯函数供
 * 单测锁定） */
export function chainLegOf(triggerCount: number | undefined): number | null {
  if (typeof triggerCount !== 'number' || triggerCount < 1) return null
  return triggerCount + 1
}

export function useCollabStream() {
  installListeners()
  /** 链 ID → 链条目（chain 行棒数联查的 O(1) 索引；行渲染每次重算 ≤50 链，
   *  非热路径） */
  const chainsById = computed(() => {
    const m = new Map<string, AgentChainItem>()
    for (const c of chains.value) m.set(c.id, c)
    return m
  })
  return { rows, chains, chainsLoaded, chainsFailed, chainsById, refreshChains }
}

/** 仅供测试使用：清空流状态（用例隔离）。listenersInstalled 不复位——窗口
 * 监听是单例常驻面，复位会让下次 use 重复安装（一次事件入 N 行） */
export function resetCollabStreamForTest(): void {
  rows.value = []
  chains.value = []
  chainsLoaded.value = false
  chainsFailed.value = false
}
