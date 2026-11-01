import { ref } from 'vue'
import type { ClaudeSessionInfo } from '../api/domains/claude'
import { claudeApi, type ClaudeTimelineEntry } from '../api/domains/claude'
import { useI18n } from './useI18n'
import { useRelayLaunch } from './useRelayLaunch'
import { useContextWarnStore } from '../stores/contextWarn'
import { isLowRemaining, pickRelaySummary, RELAY_TAIL_ENTRIES } from '../utils/sessionRelay'
import { formatLedgerLine } from '../utils/sessionLedger'

/**
 * 会话接力（P-20261003-114）：取旧会话 timeline 尾部最后一条 assistant 结论，
 * 装箱进 launchArgs 前言「此前会话结论：<摘要>，请继续」新开 agent 会话——
 * 跨天任务的知识接力进全新上下文（与 --resume 同会话续跑互异）。发起链路
 * 复用 ask-agent 族既有语义（createAgent + dir=会话 cwd + 500 字节装箱）：
 * - timeline 两跳取尾窗：先 limit=1 探 total 再取 [total-N, total)，服务端
 *   mtime+size 指纹缓存下未变更会话两跳零重复解析（timeline.go P-116）
 * - 遮蔽/装箱/创建/提示收口 useRelayLaunch（P-20261003-218 起与跨实例接力
 *   共用的发射段；此前本文件内联，收编防双处漂移）
 * - 失败面：时间线取不到 / 无 assistant 结论 → 如实提示放弃，不注空前言
 *   开会话（那只是普通新会话，误导接力语义）
 * - 活跃守卫例外（P-20261003-141）：上下文低余量（isLowRemaining）的活跃行
 *   放开接力——警示标就是换代入口，「运行中」不再是拦截理由
 */
export function useClaudeRelay() {
  const { t } = useI18n()
  const { launchRelay } = useRelayLaunch()
  // 警示阈值设备本地档（P-20261006-33）：与行内警示标同源，仅警示时机语义
  const contextWarn = useContextWarnStore()

  /** 单飞守卫：同时只跑一个接力（行内徽标 is-busy 反馈取数中） */
  const relayingId = ref('')

  /** 发起接力：成功返回新会话 id（调用方负责激活 + 打开管理页的宿主接线），
   *  放弃/失败返回 null（提示已就地给出） */
  async function relay(s: ClaudeSessionInfo): Promise<string | null> {
    if (relayingId.value) return null
    // 活跃会话结论未定型不接力（行内入口同此隐藏）；例外：上下文低余量
    // （P-20261003-141）——警示行本就是主动换代入口，此场景取「到此为止」的
    // 尾部结论恰是接力所需，不能被保守守卫拦死
    if (s.active && !isLowRemaining(s.pressure, contextWarn.pct)) return null
    relayingId.value = s.id
    try {
      const total = await fetchTailTotal(s.id)
      const summary = total > 0 ? await fetchTailSummary(s.id, total) : ''
      // 台账附行（P-20261005-208 可选）：结构化台账拼「上次会话：…」引导语后
      // 作原子前言段——量化锚比自由文本多「干了多少」，结论仍是主体
      const ledgerLine = formatLedgerLine(s.ledger, t)
      return await launchRelay({
        name: t('claudeSessions.relay.name', { title: s.title.slice(0, 30) }),
        summary,
        ledgerLine: ledgerLine ? t('claudeSessions.ledger.relayLine', { line: ledgerLine }) : undefined,
        dir: s.cwd,
        okText: t('claudeSessions.relay.ok', { title: s.title.slice(0, 30) }),
      })
    } finally {
      relayingId.value = ''
    }
  }

  /** 探尾窗总条数（limit=1 最小页，total 在响应头字段）；失败按 0 走无结论
   *  放弃路径（createAgent 的错误提示体系覆盖不了读取面，就地如实提示） */
  async function fetchTailTotal(sessionId: string): Promise<number> {
    try {
      const res = await claudeApi.timeline(sessionId, { limit: 1 }) as unknown as { data?: { total?: number } }
      return res?.data?.total ?? 0
    } catch {
      return 0
    }
  }

  /** 取尾部窗口条目并挑最后一条 assistant 结论；取页失败同样归空串放弃 */
  async function fetchTailSummary(sessionId: string, total: number): Promise<string> {
    try {
      const offset = Math.max(0, total - RELAY_TAIL_ENTRIES)
      const res = await claudeApi.timeline(sessionId, { limit: RELAY_TAIL_ENTRIES, offset }) as unknown as { data?: { entries?: ClaudeTimelineEntry[] } }
      return pickRelaySummary(res?.data?.entries ?? [])
    } catch {
      return ''
    }
  }

  return { relayingId, relay }
}
