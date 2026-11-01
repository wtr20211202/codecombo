import { nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import { useApprovalsStore } from '../stores/approvals'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useProjectStore } from '../stores/project'
import { usePanelLayout } from './usePanelLayout'
import { claudeApi, type ClaudeSessionInfo } from '../api/domains/claude'
import type { ApprovalHorizon } from '../api/domains/opsconfirm'
import { OPS_ACTIVATE_TERMINAL, type ActivateTerminalDetail } from '../utils/opsEvents'
import { normCwd } from '../utils/sessionDeepLink'

/**
 * 审批裁决动作（自 ApprovalCards 抽出，供多处宿主复用）：
 * - decide：允许一次 / 拒绝 / 完全允许 → approvals.resolve（API + 本地清账），
 *   结果 toast 与全局卡片堆文案一致
 * - jumpToSession：「查看发起会话」统一广播 OPS_ACTIVATE_TERMINAL，归属路由由
 *   各终端形态消费——系统/被接管会话归智能体终端（useAgentTerminal 监听器：
 *   选中 + 展开面板），项目会话归底部终端（对齐悬浮列表 jumpToProjectSession
 *   语义：切项目上下文 → 开底部终端面板 → 非项目页先路由；TerminalView 挂载
 *   注册监听后广播，经其待激活队列在 tab 就位时应用）。会话已结束（列表对账后
 *   无此 id）降级提示，不再派发。locateQuery（P-20261005-9）为跨会话输出检索
 *   点选携带的定位词，随广播 detail 透传由 terminalOutputLocate 轮询消费；
 *   返回值 = 是否真正派发了激活（false = 会话已结束放弃跳转），调用方据此决定
 *   是否跟进定位等后手，不对未打开的会话空轮询
 * - agentLabel：发起方智能体类型 → 展示标签（未知值原样展示）
 * - resolveReplayTarget：「查看会话回放」（P-20261002-82）目标解析——审批
 *   sessionId（终端会话）经工作目录桥接到 Claude transcript 对话，失败 toast
 *   降级；弹层宿主见 claude/SessionReplayModal
 *
 * 调用方须处于 NMessageProvider 内（useMessage 依赖注入）。
 */

// 智能体类型显示名（runtime 注册名 → 展示标签；未知值原样展示）
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'DSH',
  shell: 'Shell',
}

/** runtime 注册名 → 展示标签（未知值原样展示；空来源显示 unknownLabel 占位）。
 * 独立导出供提问卡（useAskActions）复用同一映射——审批/提问都是 agent 发起的
 * 用户交互，来源展示口径必须一致 */
export function agentLabelOf(agent: string | undefined, unknownLabel: string): string {
  if (!agent) return unknownLabel
  return AGENT_LABELS[agent] ?? agent
}

// cwd 归一化比较（回放目标匹配的兜底 pass）自 P-20261003-154 起收口
// utils/sessionDeepLink.normCwd——与回放深链的 cwd→归属项目反查共享同一实现，
// 语义必须同演化（分隔符统一 + 去尾分隔符 + 小写；仅精确匹配落空时启用）

/** 审批时刻最贴近的 Claude 会话（纯函数，独立导出供单测）：候选按「审批
 *  时刻与对话活跃窗口 [firstAt, lastAt] 的距离」取最小——时刻落在窗口内
 *  距离 0（正是当时跑着的对话）；全体都在窗口外取边界最近。无时刻（审批
 *  记录缺 createdAt）退化为最近活动的一条 */
export function pickClaudeConversation(pool: ClaudeSessionInfo[], at?: string): ClaudeSessionInfo | null {
  if (pool.length === 0) return null
  const target = at ? new Date(at).getTime() : NaN
  if (Number.isNaN(target)) {
    return pool.reduce((a, b) => (new Date(b.lastAt).getTime() > new Date(a.lastAt).getTime() ? b : a))
  }
  let best = pool[0]!
  let bestDist = Number.POSITIVE_INFINITY
  for (const s of pool) {
    const first = new Date(s.firstAt).getTime()
    const last = new Date(s.lastAt).getTime()
    const dist = target < first ? first - target : target > last ? target - last : 0
    if (dist < bestDist) {
      bestDist = dist
      best = s
    }
  }
  return best
}

export function useApprovalActions() {
  const { t } = useI18n()
  const message = useMessage()
  const router = useRouter()
  const approvals = useApprovalsStore()

  function agentLabel(agent?: string): string {
    return agentLabelOf(agent, t('agentTerminal.approvalAgentUnknown'))
  }

  /** decide：裁决落账。reason=拒绝理由（P-20261003-21，可选仅 deny 语义）——
   *  拒绝按钮经卡片内联理由输入行传入（ApprovalCards），键盘 3 直选与
   *  值班大屏一键拒绝传空串 = 原行为（无理由拒绝）。
   *  horizon=放行时限三选一（P-20261003-316：session|24h|always，携带时优先于
   *  always），档位裁决按档分语 toast */
  async function decide(id: string, allow: boolean, always = false, reason = '', horizon: ApprovalHorizon | '' = '') {
    try {
      await approvals.resolve(id, allow, always, reason, horizon)
      if (horizon === 'session') {
        message.success(t('approval.tier.sessionApplied'))
      } else if (horizon === '24h') {
        message.success(t('approval.tier.h24Applied'))
      } else if (horizon === 'always' || always) {
        message.success(t('agentTerminal.approvalAlwaysSet'))
      } else {
        message.info(allow ? t('agentTerminal.approvalAllowed') : t('agentTerminal.approvalDenied'))
      }
    } catch {
      message.error(t('agentTerminal.approvalResolveFailed'))
    }
  }

  async function jumpToSession(id?: string, locateQuery?: string): Promise<boolean> {
    if (!id) return false
    const sessionsStore = useTerminalSessionsStore()
    if (!sessionsStore.loaded) await sessionsStore.refresh()
    const session = sessionsStore.sessions.find(s => s.id === id)
    if (!session) {
      message.warning(t('agentTerminal.approvalSessionEnded'))
      return false
    }
    if (session.kind !== 'agent' && !sessionsStore.managerAttached.has(id)) {
      // 切换守卫取消（未保存草稿确认选「取消」，P-20261003-105）→ 放弃跳转
      if (session.projectId && (await useProjectStore().selectProjectExplicit(session.projectId)) === false) return false
      const layout = usePanelLayout()
      layout.showBottomPanel.value = true
      // 打标跳转意图：路由进项目页后挂载期 ui-state 恢复（上次保存的 bottomTab）
      // 异步落地晚于本赋值，无此标记会把终端 tab 翻回旧值 → TerminalView 卸载
      layout.pendingBottomTab.value = 'terminal'
      layout.bottomTab.value = 'terminal'
      if (router.currentRoute.value.name !== 'project') await router.push({ name: 'project' })
      // TerminalView 随 terminal tab 挂载（v-if），渲染冲刷后才注册激活监听
      await nextTick()
    }
    window.dispatchEvent(new CustomEvent<ActivateTerminalDetail>(OPS_ACTIVATE_TERMINAL, { detail: { id, locateQuery } }))
    return true
  }

  /** 「查看会话回放」目标解析（P-20261002-82）：审批记录的 sessionId 是终端
   *  会话 id，Claude 回放时间线吃的是本地 transcript 的会话 UUID，两者无直接
   *  映射存储——经终端会话的工作目录桥接：拉会话列表（项目会话按项目目录圈定，
   *  agent 会话全局最近 200 条）后按 cwd 匹配，再按审批时刻选最贴近的一条。
   *  失败路径统一 toast 降级（会话已结束 / 目录下无对话 / 读取失败），返回 null */
  async function resolveReplayTarget(sessionId?: string, at?: string): Promise<ClaudeSessionInfo | null> {
    if (!sessionId) return null
    const sessionsStore = useTerminalSessionsStore()
    if (!sessionsStore.loaded) await sessionsStore.refresh()
    const ts = sessionsStore.sessions.find(s => s.id === sessionId)
    if (!ts?.path) {
      message.warning(t('agentTerminal.approvalSessionEnded'))
      return null
    }
    try {
      const res = (await claudeApi.sessions(
        ts.projectId ? { projectId: ts.projectId, limit: 200 } : { limit: 200 },
      )) as unknown as { data?: { sessions?: ClaudeSessionInfo[] } }
      const list = res?.data?.sessions ?? []
      const exact = list.filter(s => s.cwd === ts.path)
      const pool = exact.length > 0 ? exact : list.filter(s => normCwd(s.cwd) === normCwd(ts.path))
      if (pool.length === 0) {
        message.warning(t('approval.replay.notFound'))
        return null
      }
      return pickClaudeConversation(pool, at)
    } catch {
      message.error(t('approval.replay.loadFail'))
      return null
    }
  }

  return { agentLabel, decide, jumpToSession, resolveReplayTarget }
}
