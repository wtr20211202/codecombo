import { ref } from 'vue'
import type { ClaudeSessionInfo, ClaudeTimelineEntry } from '../api/domains/claude'
import { instanceFetch } from '../api/instanceFetch'
import { useI18n } from './useI18n'
import { useRelayLaunch } from './useRelayLaunch'
import { useContextWarnStore } from '../stores/contextWarn'
import { isLowRemaining, pickRelaySummary, RELAY_TAIL_ENTRIES } from '../utils/sessionRelay'

/**
 * 跨实例会话接力（P-20261003-218）：会话中心「从实例接力」——把其他实例上某
 * Claude 会话的尾部结论注入**本实例**新开会话的 launchArgs 前言。多实例分工
 * 场景（实例 A 写前端、实例 B 写后端）下，A 的会话知识可以带进 B 的新会话。
 *
 * 复用 P-114 接力链：遮蔽/装箱/创建/提示收口 useRelayLaunch（共用发射段），
 * 摘要提取走 utils/sessionRelay（尾部窗口最后一条 assistant 文本，结论优先
 * 弃过程）；服务端 timeline 两跳取尾窗（limit=1 探 total 再取 [total-N,
 * total)），远端指纹缓存语义与本机相同（同一套服务端代码）。
 *
 * 与本机接力的两处刻意差异：
 * - **只读边界（任务书②）**：对远端实例只发 instanceFetch GET（列表 + timeline），
 *   零写回——不写策展、不动远端终端、不发任何 POST/PUT/DELETE 到 /proxy/*。
 *   数据通道沿 P-125 跨实例聚合同款（instanceFetch：本机 = 同源 /api，远程 =
 *   回环代理 /proxy/<id>/api 带锁令牌）
 * - **dir 不携带**：远端会话 cwd 是远端机器上的路径，本机多半不存在，而
 *   createAgentTerminal 会校验目录存在——携带必失败。新会话落服务默认目录，
 *   知识接力不隐含工作目录迁移（要本机目录由用户在会话里自行指定）
 *
 * - 活跃守卫与本机接力同口径（P-20261003-141）：结论未定型的活跃行不接力，
 *   上下文低余量（isLowRemaining）例外放开——换代入口不该被保守守卫拦死
 * - 失败面：远端不可达 / 时间线取不到 / 无 assistant 结论 → 如实提示放弃，
 *   不注空前言开会话（与本机接力同一纪律）
 */
export function useInstanceRelay() {
  const { t } = useI18n()
  const { launchRelay } = useRelayLaunch()
  // 警示阈值设备本地档（P-20261006-33）：与本机接力/警示标同源，仅警示时机语义
  const contextWarn = useContextWarnStore()

  /** 单飞守卫：同时只跑一个接力（弹层行内徽标 is-busy 反馈取数中） */
  const relayingId = ref('')

  /**
   * 从指定实例接力一个会话：成功返回**本实例**新会话 id（调用方负责激活 +
   * 打开管理页的宿主接线），放弃/失败返回 null（提示已就地给出）。
   * instanceName 仅用于成功提示文案（「已从『某实例』接力…」）。
   */
  async function relayFrom(instanceId: string, instanceName: string, s: ClaudeSessionInfo): Promise<string | null> {
    if (relayingId.value) return null
    // 活跃会话结论未定型不接力（弹层行内入口同此隐藏）；低余量例外同 P-141
    if (s.active && !isLowRemaining(s.pressure, contextWarn.pct)) return null
    relayingId.value = s.id
    try {
      const total = await fetchTailTotal(instanceId, s.id)
      const summary = total > 0 ? await fetchTailSummary(instanceId, s.id, total) : ''
      return await launchRelay({
        name: t('claudeSessions.instanceRelay.name', { title: s.title.slice(0, 30) }),
        summary,
        // dir 不携带（见文件头「dir 不携带」注记）；新会话落**本实例**
        okText: t('claudeSessions.instanceRelay.ok', { instance: instanceName, title: s.title.slice(0, 30) }),
      })
    } finally {
      relayingId.value = ''
    }
  }

  /** 探远端尾窗总条数（limit=1 最小页，total 在响应体 data 字段）；失败按 0
   *  走无结论放弃路径（远端不可达的失败提示由弹层列表面覆盖，读摘要这里静默
   *  归零与 useClaudeRelay.fetchTailTotal 同口径）。只读边界：GET only */
  async function fetchTailTotal(instanceId: string, sessionId: string): Promise<number> {
    try {
      const res = await instanceFetch<{ data?: { total?: number } }>(
        instanceId, 'GET', `/claude/sessions/${encodeURIComponent(sessionId)}/timeline?limit=1`)
      return res?.data?.total ?? 0
    } catch {
      return 0
    }
  }

  /** 取远端尾部窗口条目并挑最后一条 assistant 结论；取页失败同样归空串放弃 */
  async function fetchTailSummary(instanceId: string, sessionId: string, total: number): Promise<string> {
    try {
      const offset = Math.max(0, total - RELAY_TAIL_ENTRIES)
      const res = await instanceFetch<{ data?: { entries?: ClaudeTimelineEntry[] } }>(
        instanceId, 'GET',
        `/claude/sessions/${encodeURIComponent(sessionId)}/timeline?limit=${RELAY_TAIL_ENTRIES}&offset=${offset}`)
      return pickRelaySummary(res?.data?.entries ?? [])
    } catch {
      return ''
    }
  }

  return { relayingId, relayFrom }
}
