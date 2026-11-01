/**
 * 值班交接包聚合器（P-20261005-148）：把「现场」散在四处的进行时事实——
 * 在跑会话、待裁决审批、待回答提问、当日日报、热力图今日格——聚合成一份
 * 给人读的 markdown 交接文档。与交接班摘要（P-20261003-8，纯文本水位快照）
 * 的分工：摘要是零摩擦复制的一屏速览；交接包是结构化文档，多日报/热力两段
 * 与「静态快照」注记，出口多一条 24h 片段分享短链。
 *
 * - 本模块刻意无 IO、无 Pinia、无 vue-i18n 依赖：文案经注入的 translate
 *   函数解析（宿主传 i18n.global.t 形状的函数），纯函数直测（handoverPackage.test.ts）
 * - 敏感面：审批 op/target/提问正文/步骤摘要是 agent 拼的自由文本，宿主在
 *   装配行数据前经 maskApprovalSecrets 兜底遮蔽（P-114 修正案复用约定），
 *   本模块不做内容审查；文档头自带静态快照与敏感度注记，随分享内容出域
 * - 分节上限：交接包走片段分享通道（32KiB 上限），超长清单按档截断并注记
 *   （HANDOVER_MAX_* 常量），保证常态值守规模下不触顶
 */
import { fmtTokensCompact } from './weeklyReport'

/** 翻译函数形状（vue-i18n global.t 兼容子集；插值用命名参数） */
export type HandoverTranslate = (key: string, params?: Record<string, unknown>) => string

/** 在跑会话清单上限：片段分享 32KiB 下的可读档（超出截断 + 注记） */
export const HANDOVER_MAX_SESSIONS = 20
/** 审批/提问卡各自上限（同上） */
export const HANDOVER_MAX_CARDS = 20
/** 当日日报项目行上限 */
export const HANDOVER_MAX_DAILY_PROJECTS = 12

/** 在跑会话行（宿主装配：时长/静默分钟数已在宿主侧算好，本模块只拼版） */
export interface HandoverSessionRow {
  name: string
  /** 底层运行时（agent 会话；shell/未知为空串——空则不拼 runtime 段） */
  runtime: string
  projectName: string
  /** 已运行时长文案（宿主经 monitor.shift.dur* 键组好；未知为空串不拼） */
  durationText: string
  /** 静默分钟数（sessionIdleMinutes 口径，0 = 不拼静默段） */
  idleMinutes: number
  /** 有 pending 审批：静默归因为「等待裁决」（P-198 特化同款语义） */
  pendingApproval: boolean
  /** 当前步骤摘要（任务进度归属；空串不拼） */
  currentStep: string
}

/** 审批/提问卡行（op/target/question 已由宿主遮蔽；agent 为展示标签） */
export interface HandoverCardRow {
  agentLabel: string
  /** 审批 op + target 摘要（一行） */
  summary: string
  /** 发起会话名（对不上会话表为空串不拼） */
  sessionName: string
}

/** 当日日报单项目行（DailyReportEntry 投影；tokens 原始值，fmtTokensCompact 压缩） */
export interface HandoverDailyRow {
  projectName: string
  commits: number
  sessions: number
  tokens: number
  cmds: number
}

/** 热力图今日格（ActivityDayEntry 同构；null = 今日尚无活动档） */
export interface HandoverHeatCell {
  commits: number
  sessions: number
  commands: number
}

export interface HandoverDocInput {
  generatedAt: Date
  /** 档位日期 YYYY-MM-DD（日报/热力段落标题用） */
  dateKey: string
  sessions: HandoverSessionRow[]
  approvals: HandoverCardRow[]
  asks: HandoverCardRow[]
  daily: HandoverDailyRow[]
  heat: HandoverHeatCell | null
}

/** 单项时长文案（与 MonitorView.shiftDur 同口径：复用 monitor.shift.dur* 键，
 *  收进本模块让两出口共用一份拼版） */
export function handoverDurationText(createdAtMs: number | null, t: HandoverTranslate): string {
  if (createdAtMs === null || !Number.isFinite(createdAtMs)) return ''
  const min = Math.max(0, Math.floor((Date.now() - createdAtMs) / 60_000))
  if (min < 1) return t('monitor.shift.durLt1m')
  const h = Math.floor(min / 60)
  if (h < 1) return t('monitor.shift.durM', { m: min })
  return t('monitor.shift.durHM', { h, m: min % 60 })
}

/** 会话行尾部状态段：已运行时长 + 静默/等裁决分钟数（就地拼一段，避免行内
 *  插值碎片化——静默与等裁决互斥，等裁决优先归因） */
function sessionStatusText(s: HandoverSessionRow, t: HandoverTranslate): string {
  const parts: string[] = []
  if (s.durationText) parts.push(t('handover.doc.runtime', { dur: s.durationText }))
  if (s.idleMinutes > 0) {
    parts.push(s.pendingApproval
      ? t('handover.doc.idleWaitApproval', { n: s.idleMinutes })
      : t('handover.doc.idleMinutes', { n: s.idleMinutes }))
  }
  return parts.join(' · ')
}

/** 交接包 markdown 全文（各段恒在——空清单落「（无）」段，接手人按段扫读
 *  不猜缺失是漏聚还是真空闲） */
export function buildHandoverMarkdown(input: HandoverDocInput, t: HandoverTranslate): string {
  const genTime = input.generatedAt.toLocaleString()
  const lines: string[] = [
    t('handover.doc.title', { time: genTime }),
    '',
    t('handover.doc.snapshotNote', { time: genTime }),
    '',
    t('handover.doc.sensitiveNote'),
    '',
    `## ${t('handover.doc.sectionSessions', { n: input.sessions.length })}`,
    '',
  ]
  if (input.sessions.length === 0) {
    lines.push(t('monitor.shift.none'))
  } else {
    for (const s of input.sessions.slice(0, HANDOVER_MAX_SESSIONS)) {
      const ctx = [
        s.runtime,
        s.projectName ? t('monitor.shift.sessProj', { name: s.projectName }) : '',
      ].filter(Boolean).join(' · ')
      const status = sessionStatusText(s, t)
      const meta = [ctx, status].filter(Boolean).join(' — ')
      lines.push(`- **${s.name}**${meta ? `（${meta}）` : ''}`)
      if (s.currentStep) lines.push(`  - ${t('monitor.shift.currentStep', { step: s.currentStep })}`)
    }
    if (input.sessions.length > HANDOVER_MAX_SESSIONS) {
      lines.push(t('handover.doc.moreSessions', { n: input.sessions.length - HANDOVER_MAX_SESSIONS }))
    }
  }

  lines.push('', `## ${t('handover.doc.sectionApprovals', { n: input.approvals.length })}`, '')
  if (input.approvals.length === 0) {
    lines.push(t('monitor.shift.none'))
  } else {
    input.approvals.slice(0, HANDOVER_MAX_CARDS).forEach((a, i) => {
      const sess = a.sessionName ? ` · ${a.sessionName}` : ''
      lines.push(`${i + 1}. [${a.agentLabel}] ${a.summary}${sess}`)
    })
    if (input.approvals.length > HANDOVER_MAX_CARDS) {
      lines.push(t('handover.doc.moreApprovals', { n: input.approvals.length - HANDOVER_MAX_CARDS }))
    }
  }

  lines.push('', `## ${t('handover.doc.sectionAsks', { n: input.asks.length })}`, '')
  if (input.asks.length === 0) {
    lines.push(t('monitor.shift.none'))
  } else {
    input.asks.slice(0, HANDOVER_MAX_CARDS).forEach((a, i) => {
      const agent = a.agentLabel ? `[${a.agentLabel}] ` : ''
      const sess = a.sessionName ? ` · ${a.sessionName}` : ''
      lines.push(`${i + 1}. ${agent}${a.summary}${sess}`)
    })
    if (input.asks.length > HANDOVER_MAX_CARDS) {
      lines.push(t('handover.doc.moreAsks', { n: input.asks.length - HANDOVER_MAX_CARDS }))
    }
  }

  lines.push('', `## ${t('handover.doc.sectionDaily', { date: input.dateKey })}`, '')
  if (input.daily.length === 0) {
    lines.push(t('handover.doc.dailyMissing'))
  } else {
    for (const d of input.daily.slice(0, HANDOVER_MAX_DAILY_PROJECTS)) {
      lines.push(`- ${d.projectName}：${t('handover.doc.dailyLine', {
        commits: d.commits,
        sessions: d.sessions,
        tokens: fmtTokensCompact(d.tokens),
        cmds: d.cmds,
      })}`)
    }
    if (input.daily.length > HANDOVER_MAX_DAILY_PROJECTS) {
      lines.push(t('handover.doc.moreDaily', { n: input.daily.length - HANDOVER_MAX_DAILY_PROJECTS }))
    }
  }
  lines.push('', t('handover.doc.dailyPointer', { date: input.dateKey }))

  lines.push('', `## ${t('handover.doc.sectionHeat')}`, '')
  const h = input.heat
  lines.push(h
    ? t('handover.doc.heatLine', { commits: h.commits, sessions: h.sessions, commands: h.commands })
    : t('handover.doc.heatMissing'))

  return lines.join('\n')
}
