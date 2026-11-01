import { describe, it, expect } from 'vitest'
import {
  buildWeeklyReportDraft,
  fmtTokensCompact,
  type WeeklyReportDay,
} from '@/utils/weeklyReport'

const labels = { title: '周报', commits: '提交', sessions: '智能会话', tokens: 'Token', cmds: '终端命令' }

function day(partial: Partial<WeeklyReportDay>): WeeklyReportDay {
  return { date: '2026-10-05', projects: [], instanceLine: '', ...partial }
}

describe('fmtTokensCompact', () => {
  it('三级口径：原始 / k / M', () => {
    expect(fmtTokensCompact(999)).toBe('999')
    expect(fmtTokensCompact(1000)).toBe('1k')
    expect(fmtTokensCompact(45_230)).toBe('45.2k')
    expect(fmtTokensCompact(452_000)).toBe('452k')
    expect(fmtTokensCompact(1_234_567)).toBe('1.2M')
  })
})

describe('buildWeeklyReportDraft', () => {
  const days: WeeklyReportDay[] = [
    day({
      date: '2026-10-05',
      projects: [
        {
          projectName: 'alpha',
          commits: 3,
          commitSubjects: ['feat: 新增过滤', 'fix: 修正计数'],
          sessions: 2,
          tokens: 45_230,
          cmds: 120,
        },
        { projectName: 'beta', commits: 0, sessions: 1, tokens: 999, cmds: 8 },
      ],
      instanceLine: '审批 完成 2 / 进行中 1 · 部署 成功 1 / 失败 0',
    }),
    day({
      date: '2026-10-06',
      projects: [{ projectName: 'alpha', commits: 1, commitSubjects: ['docs: 补充说明'], sessions: 0, tokens: 0, cmds: 0 }],
    }),
  ]

  it('按日分节：日期标题升序保持调用方给序，事实行含四项与项目名', () => {
    const d = buildWeeklyReportDraft(days, labels)
    expect(d.empty).toBe(false)
    expect(d.dayCount).toBe(2)
    expect(d.markdown).toContain('# 周报')
    expect(d.markdown.indexOf('## 2026-10-05')).toBeLessThan(d.markdown.indexOf('## 2026-10-06'))
    expect(d.markdown).toContain('**alpha** — 提交 3 · 智能会话 2 · Token 45.2k · 终端命令 120')
    expect(d.markdown).toContain('**beta** — 提交 0 · 智能会话 1 · Token 999 · 终端命令 8')
  })
  it('提交主题逐行入列表；无主题项目不出空列表', () => {
    const d = buildWeeklyReportDraft(days, labels)
    expect(d.markdown).toContain('- feat: 新增过滤')
    expect(d.markdown).toContain('- fix: 修正计数')
    expect(d.markdown).toContain('- docs: 补充说明')
  })
  it('实例级事实行成引用块，缺省日不输出', () => {
    const d = buildWeeklyReportDraft(days, labels)
    expect(d.markdown).toContain('> 审批 完成 2 / 进行中 1 · 部署 成功 1 / 失败 0')
  })
  it('主题行首尾空白剔除，空白主题不丢进草稿', () => {
    const d = buildWeeklyReportDraft(
      [day({ projects: [{ projectName: 'a', commits: 2, commitSubjects: ['  有空白  ', '   '], sessions: 0, tokens: 0, cmds: 0 }] })],
      labels,
    )
    expect(d.markdown).toContain('- 有空白')
    expect(d.markdown).not.toContain('-    \n')
  })
  it('全部为空（空数组/无项目日）返回 empty 且 markdown 为空', () => {
    expect(buildWeeklyReportDraft([], labels)).toEqual({ markdown: '', empty: true, dayCount: 0 })
    const d = buildWeeklyReportDraft([day({ date: '2026-10-05' }), day({ date: '2026-10-06' })], labels)
    expect(d.empty).toBe(true)
    expect(d.markdown).toBe('')
  })
  it('无日期键的残缺日不产出分节（防御服务端脏行）', () => {
    const d = buildWeeklyReportDraft([day({ date: '', projects: [{ projectName: 'a', commits: 1, sessions: 0, tokens: 0, cmds: 0 }] })], labels)
    expect(d.empty).toBe(true)
  })
})
