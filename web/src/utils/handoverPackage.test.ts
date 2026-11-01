import { describe, expect, it } from 'vitest'
import {
  buildHandoverMarkdown,
  handoverDurationText,
  HANDOVER_MAX_CARDS,
  HANDOVER_MAX_SESSIONS,
  type HandoverCardRow,
  type HandoverDocInput,
  type HandoverSessionRow,
} from './handoverPackage'

// 值班交接包聚合器（P-20261005-148）单测：拼版形状/空态段落恒在/截断注记/
// 时长文案四块。t 用直查桩表（无 vue-i18n 依赖，键→模板字符串映射）

const STRINGS: Record<string, string> = {
  'monitor.shift.none': '（无）',
  'monitor.shift.sessProj': '（项目：{name}）',
  'monitor.shift.currentStep': '当前步骤：{step}',
  'monitor.shift.durLt1m': '不足 1 分钟',
  'monitor.shift.durM': '{m} 分钟',
  'monitor.shift.durHM': '{h} 小时 {m} 分',
  'handover.doc.title': '# 值班交接包（{time}）',
  'handover.doc.snapshotNote': '> 静态快照：生成于 {time}。',
  'handover.doc.sensitiveNote': '> 注意：含敏感摘要。',
  'handover.doc.sectionSessions': '在跑会话（{n}）',
  'handover.doc.sectionApprovals': '待裁决审批（{n}）',
  'handover.doc.sectionAsks': '待回答提问（{n}）',
  'handover.doc.sectionDaily': '当日日报（{date}）',
  'handover.doc.sectionHeat': '今日活动',
  'handover.doc.runtime': '运行 {dur}',
  'handover.doc.idleMinutes': '静默 {n} 分钟',
  'handover.doc.idleWaitApproval': '等待裁决 {n} 分钟',
  'handover.doc.moreSessions': '（另有 {n} 个会话未列出）',
  'handover.doc.moreApprovals': '（另有 {n} 条审批未列出）',
  'handover.doc.moreAsks': '（另有 {n} 条提问未列出）',
  'handover.doc.moreDaily': '（另有 {n} 个项目未列出）',
  'handover.doc.dailyLine': '提交 {commits} · 会话 {sessions} · tokens {tokens} · 命令 {cmds}',
  'handover.doc.dailyMissing': '当日日报尚未归档',
  'handover.doc.dailyPointer': '完整日报见通知中心「日报存档」（{date}）。',
  'handover.doc.heatLine': '今日：提交 {commits} · 会话 {sessions} · 命令 {commands}',
  'handover.doc.heatMissing': '今日暂无活动数据',
}

function t(key: string, params?: Record<string, unknown>): string {
  const tpl = STRINGS[key] ?? ''
  if (!params) return tpl
  return Object.entries(params).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), tpl)
}

function sessRow(over: Partial<HandoverSessionRow> = {}): HandoverSessionRow {
  return {
    name: 'sess-a',
    runtime: 'claude',
    projectName: 'proj',
    durationText: '2 小时 3 分',
    idleMinutes: 0,
    pendingApproval: false,
    currentStep: '',
    ...over,
  }
}

function cardRow(over: Partial<HandoverCardRow> = {}): HandoverCardRow {
  return {
    agentLabel: 'claude',
    summary: 'reset --hard main',
    sessionName: 'sess-a',
    ...over,
  }
}

function input(over: Partial<HandoverDocInput> = {}): HandoverDocInput {
  return {
    generatedAt: new Date(2026, 9, 12, 18, 0, 0),
    dateKey: '2026-10-12',
    sessions: [],
    approvals: [],
    asks: [],
    daily: [],
    heat: null,
    ...over,
  }
}

describe('buildHandoverMarkdown', () => {
  it('空态：五段标题恒在 + 各段落「（无）」/ 缺档注记，不猜缺失', () => {
    const md = buildHandoverMarkdown(input(), t)
    expect(md).toContain('# 值班交接包（')
    expect(md).toContain('静态快照：生成于')
    expect(md).toContain('## 在跑会话（0）')
    expect(md).toContain('## 待裁决审批（0）')
    expect(md).toContain('## 待回答提问（0）')
    expect(md).toContain('## 当日日报（2026-10-12）')
    expect(md).toContain('## 今日活动')
    expect(md).toContain('（无）')
    expect(md).toContain('当日日报尚未归档')
    expect(md).toContain('今日暂无活动数据')
    // 段落序：会话 → 审批 → 提问 → 日报 → 热力
    const idx = ['在跑会话', '待裁决审批', '待回答提问', '当日日报', '今日活动'].map(s => md.indexOf(s))
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(idx.every(i => i >= 0)).toBe(true)
  })

  it('在跑会话行：名加粗 + runtime/项目/时长/静默段拼版 + 当前步骤子行', () => {
    const md = buildHandoverMarkdown(input({
      sessions: [
        sessRow({ idleMinutes: 7, currentStep: '运行测试套件' }),
        sessRow({ name: 'sess-b', runtime: '', projectName: '', durationText: '', idleMinutes: 3, pendingApproval: true }),
      ],
    }), t)
    expect(md).toContain('- **sess-a**（claude · （项目：proj） — 运行 2 小时 3 分 · 静默 7 分钟）')
    expect(md).toContain('  - 当前步骤：运行测试套件')
    // 空段不拼：runtime/项目/时长缺省只留静默；pending 归因「等待裁决」
    expect(md).toContain('- **sess-b**（等待裁决 3 分钟）')
    expect(md).not.toContain('sess-b**（·')
  })

  it('审批/提问行：agent 标签 + op/target 摘要 + 会话名注记', () => {
    const md = buildHandoverMarkdown(input({
      approvals: [cardRow(), cardRow({ agentLabel: 'codex', summary: 'rm -rf build', sessionName: '' })],
      asks: [cardRow({ summary: '要推送 force 到 main 吗' })],
    }), t)
    expect(md).toContain('1. [claude] reset --hard main · sess-a')
    expect(md).toContain('2. [codex] rm -rf build')
    expect(md).toContain('1. [claude] 要推送 force 到 main 吗 · sess-a')
  })

  it('日报/热力段：项目行拼版 + tokens 压缩 + today 格数值', () => {
    const md = buildHandoverMarkdown(input({
      daily: [{ projectName: 'proj', commits: 3, sessions: 2, tokens: 12_345_678, cmds: 45 }],
      heat: { commits: 3, sessions: 5, commands: 120 },
    }), t)
    expect(md).toContain('- proj：提交 3 · 会话 2 · tokens 12.3M · 命令 45')
    expect(md).toContain('完整日报见通知中心「日报存档」（2026-10-12）。')
    expect(md).toContain('今日：提交 3 · 会话 5 · 命令 120')
  })

  it('截断注记：会话/审批/提问/日报超上限只列前 N 条并注记余量', () => {
    const sessions = Array.from({ length: HANDOVER_MAX_SESSIONS + 3 }, (_, i) => sessRow({ name: `s${i}` }))
    const approvals = Array.from({ length: HANDOVER_MAX_CARDS + 2 }, (_, i) => cardRow({ summary: `op${i}` }))
    const md = buildHandoverMarkdown(input({ sessions, approvals, asks: approvals }), t)
    expect(md).toContain('（另有 3 个会话未列出）')
    expect(md).toContain('（另有 2 条审批未列出）')
    expect(md).toContain('（另有 2 条提问未列出）')
    expect(md).not.toContain('s22')
    expect(md).toContain(`op${HANDOVER_MAX_CARDS - 1}`)
    expect(md).not.toContain(`op${HANDOVER_MAX_CARDS} `)
  })
})

describe('handoverDurationText', () => {
  it('时长分档与未知占位（与交接班摘要 shiftDur 同口径）', () => {
    expect(handoverDurationText(null, t)).toBe('')
    expect(handoverDurationText(Number.NaN, t)).toBe('')
    const now = Date.now()
    expect(handoverDurationText(now - 30_000, t)).toBe('不足 1 分钟')
    expect(handoverDurationText(now - 5 * 60_000, t)).toBe('5 分钟')
    expect(handoverDurationText(now - (2 * 3600 + 3 * 60) * 1000, t)).toBe('2 小时 3 分')
  })
})
