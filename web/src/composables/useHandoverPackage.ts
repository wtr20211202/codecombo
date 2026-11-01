import { ref } from 'vue'
import { useI18n } from './useI18n'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useApprovalsStore } from '../stores/approvals'
import { useAsksStore } from '../stores/asks'
import { useAssistantTaskStore } from '../stores/assistantTask'
import { useProjectStore } from '../stores/project'
import { opsConfirmApi } from '../api/domains/opsconfirm'
import type { ApprovalRecord } from '../api/domains/opsconfirm'
import { opsAskApi } from '../api/domains/opsask'
import type { AskRecord } from '../api/domains/opsask'
import { reportApi } from '../api/domains/report'
import {
  buildHandoverMarkdown,
  handoverDurationText,
  type HandoverCardRow,
  type HandoverDocInput,
  type HandoverSessionRow,
} from '../utils/handoverPackage'
import { sessionIdleMinutes } from '../utils/session-idle'
import { agentLabelOf } from './useApprovalActions'
import { maskApprovalSecrets, maskSensitive } from '../utils/sensitiveMask'

/**
 * 值班交接包数据装配（P-20261005-148）：generate() 冷启动补账 + 既有 store
 * 快照 + 日报/热力两路取数，产出 markdown 全文。大屏与通知中心两个入口共用：
 * Pinia store 是全局单例，本组合式的补账 upsert 与大屏挂载期 seedApprovals/
 * seedAsks 同构幂等（重复执行无害，重复生成只多三个幂等 GET——用户显式点按
 * 触发，无轮询）。
 *
 * - 审批/提问/会话数据以「store 现状 + 本次补账」为准（与值班大屏卡片同源，
 *   所见即所得）；日报/热力天粒度数据专程现拉（大屏卡片 ref 不跨宿主可达）
 * - 遮蔽链（P-114 修正案复用约定）：审批 op/target 与提问正文经
 *   maskApprovalSecrets 兜底（复制与分享两条出域通道一视同仁），会话步骤
 *   摘要经 maskSensitive 基础集打底——文档是要传阅的，宁可多遮一层
 */

/** YYYY-MM-DD（与热力图卡 dateKey 同口径：服务器与浏览器同机部署，本地时区） */
function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function useHandoverPackage() {
  const { t } = useI18n()
  const generating = ref(false)
  /** 最近一次生成的全文（null = 尚未生成/生成失败） */
  const doc = ref<string | null>(null)

  /** pending 补账（MonitorView.seedApprovals 同款：只 upsert pending，广播兜底增量） */
  async function seedApprovals(): Promise<void> {
    try {
      const res = (await opsConfirmApi.list({ status: 'pending' })) as unknown as { data?: ApprovalRecord[] }
      const approvals = useApprovalsStore()
      for (const a of res?.data ?? []) {
        if (a.status === 'pending') approvals.upsert(a)
      }
    } catch { /* 列表拉取失败不阻塞交接包生成（WS 广播兜底增量） */ }
  }

  /** 提问补账（同上） */
  async function seedAsks(): Promise<void> {
    try {
      const res = (await opsAskApi.list()) as unknown as { data?: AskRecord[] }
      const asks = useAsksStore()
      for (const a of res?.data ?? []) {
        if (a.status === 'pending') asks.upsert(a)
      }
    } catch { /* 同上 */ }
  }

  /** 在跑会话行装配：运行态 + 静默分钟 + 当前步骤（值班大屏 sessionCards/
   *  taskCards 同源口径；不含已关闭会话——交接包是进行时快照） */
  function buildSessionRows(): HandoverSessionRow[] {
    const sessionsStore = useTerminalSessionsStore()
    const assistantTask = useAssistantTaskStore()
    const approvals = useApprovalsStore()
    const projectStore = useProjectStore()
    const now = Date.now()
    return sessionsStore.sortedSessions
      .filter(s => sessionsStore.runningMap[s.id] === true || assistantTask.bySession[s.id]?.status === 'running')
      .map(s => {
        const task = assistantTask.bySession[s.id]
        const created = Date.parse(s.createdAt || '')
        return {
          name: s.name,
          runtime: s.runtime || '',
          projectName: projectStore.projects.find(p => p.id === s.projectId)?.name || '',
          durationText: handoverDurationText(Number.isFinite(created) ? created : null, t),
          idleMinutes: sessionIdleMinutes(sessionsStore.runningMap[s.id] === true, sessionsStore.activityMap[s.id], now),
          pendingApproval: approvals.pendingSessionIds.has(s.id),
          currentStep: task?.status === 'running' ? (task.step || '') : '',
        }
      })
  }

  /** 审批/提问卡行：op+target / question 一行摘要（遮蔽在装配侧统一做） */
  function buildApprovalRows(): HandoverCardRow[] {
    const approvals = useApprovalsStore()
    const sessionsStore = useTerminalSessionsStore()
    return [...approvals.pendingList]
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      .map(a => ({
        agentLabel: agentLabelOf(a.agent, t('agentTerminal.approvalAgentUnknown')),
        summary: `${a.op}${a.target ? ` ${maskApprovalSecrets(a.target)}` : ''}`,
        sessionName: (a.sessionId && sessionsStore.sessions.find(s => s.id === a.sessionId)?.name) || '',
      }))
  }

  function buildAskRows(): HandoverCardRow[] {
    const asks = useAsksStore()
    const sessionsStore = useTerminalSessionsStore()
    return [...asks.pendingList]
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      .map(a => ({
        agentLabel: agentLabelOf(a.agent, t('agentTerminal.approvalAgentUnknown')),
        summary: maskSensitive(a.question),
        sessionName: (a.terminalId && sessionsStore.sessions.find(s => s.id === a.terminalId)?.name) || '',
      }))
  }

  /** 当日日报行 + 热力图今日格：天粒度数据现拉（日报取近 14 天滤当日——存档
   *  倒序今天在最前，小窗口足够；热力取 7 天按日期键命中，今日尚无档落 null） */
  async function fetchDailyAndHeat(dateKey: string): Promise<Pick<HandoverDocInput, 'daily' | 'heat'>> {
    const [dailyRes, activityRes] = await Promise.all([
      reportApi.listDaily(14, { silent: true }).catch(() => null),
      reportApi.listActivity(7, { silent: true }).catch(() => null),
    ])
    const daily = (dailyRes?.data ?? [])
      .filter(e => e.date === dateKey)
      .map(e => ({
        projectName: e.projectName,
        commits: e.commits,
        sessions: e.sessions,
        tokens: e.tokens,
        cmds: e.cmds,
      }))
    const today = activityRes?.data?.find(e => e.date === dateKey)
    return {
      daily,
      heat: today ? { commits: today.commits, sessions: today.sessions, commands: today.commands } : null,
    }
  }

  /** 生成交接包全文：补账 → 装配 → 拼版。失败抛给调用方提示（doc 保持上次值） */
  async function generate(): Promise<string> {
    if (generating.value) return doc.value ?? ''
    generating.value = true
    try {
      const sessionsStore = useTerminalSessionsStore()
      const key = dateKeyOf(new Date())
      // 会话清单先对账（pending 补账与会话刷新并行；热力/日报同批）
      await Promise.all([sessionsStore.refresh(), seedApprovals(), seedAsks()])
      const { daily, heat } = await fetchDailyAndHeat(key)
      const input: HandoverDocInput = {
        generatedAt: new Date(),
        dateKey: key,
        sessions: buildSessionRows(),
        approvals: buildApprovalRows(),
        asks: buildAskRows(),
        daily,
        heat,
      }
      doc.value = buildHandoverMarkdown(input, t)
      return doc.value
    } finally {
      generating.value = false
    }
  }

  return { generating, doc, generate }
}
