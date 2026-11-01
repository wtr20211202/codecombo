// 周报草稿拼接（P-20261003-135）：日报存档（P-20261003-4）多选日期合成为
// 按日分节的 markdown 草稿——与 changelog（P-20261003-27）同族的聚合出口，
// 数据面纯前端（存档查询口已有）。纯函数零依赖：数据由调用方经
// reportApi.dailyDetail 逐日拉取后传入，i18n 标签由调用方注入（草稿会被
// 粘贴到团队工具，跟随界面语言），方便单测与后续 agent 润色链路复用。

/** token 紧凑展示：与日报面板/会话列表徽标同一口径（服务端
 * formatTokensCompact 的前端镜像）。日报面板自此改从本文件共用（草稿侧
 * 同样需要），ClaudeSessionPicker 的同款副本暂不动（独立域，避免扩散改动） */
export function fmtTokensCompact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`
  }
  return `${Math.round((n / 1_000_000) * 10) / 10}M`
}

/** 单日单项目事实（DailyReportEntry 的草稿投影：只留拼草稿要用的字段） */
export interface WeeklyReportProjectStat {
  projectName: string
  commits: number
  commitSubjects?: string[]
  sessions: number
  tokens: number
  cmds: number
}

/** 单日分节：projects 保持调用方给序（服务端同日按项目 ID 升序）；instanceLine
 * 为实例级事实行（审批/部署，无项目归属），调用方按 locale 拼好传入，空串 =
 * 该日无存档事实、不输出 */
export interface WeeklyReportDay {
  date: string
  projects: WeeklyReportProjectStat[]
  instanceLine?: string
}

export interface WeeklyReportLabels {
  /** 草稿一级标题（「周报」/「Weekly Report」） */
  title: string
  commits: string
  sessions: string
  tokens: string
  cmds: string
}

export interface WeeklyReportDraft {
  markdown: string
  /** 所选日期全部无事实（一个项目行都没有）：调用方按空态渲染、复制/下载禁用 */
  empty: boolean
  /** 实际产出分节的天数（有项目事实的天） */
  dayCount: number
}

/** 聚合为按日分节的 markdown 草稿：
 * `# 周报` + 每日 `## <date>` + 每项目事实行 + 提交主题列表 + 实例级事实引用行。
 * 全部为空时返回 empty（markdown 置空）。days 顺序即输出顺序（调用方决定
 * 升序/降序；周报叙事惯例升序），零日/空日不产出分节 */
export function buildWeeklyReportDraft(
  days: WeeklyReportDay[],
  labels: WeeklyReportLabels,
): WeeklyReportDraft {
  const out: string[] = [`# ${labels.title}`, '']
  let dayCount = 0
  for (const day of days) {
    if (!day.date || day.projects.length === 0) continue
    dayCount++
    out.push(`## ${day.date}`, '')
    for (const p of day.projects) {
      const stats = [
        `${labels.commits} ${p.commits}`,
        `${labels.sessions} ${p.sessions}`,
        `${labels.tokens} ${fmtTokensCompact(p.tokens)}`,
        `${labels.cmds} ${p.cmds}`,
      ].join(' · ')
      out.push(`**${p.projectName}** — ${stats}`, '')
      for (const s of p.commitSubjects || []) {
        const subject = (s || '').trim()
        if (subject) out.push(`- ${subject}`)
      }
      if (p.commitSubjects?.length) out.push('')
    }
    if (day.instanceLine) out.push(`> ${day.instanceLine}`, '')
  }
  if (dayCount === 0) return { markdown: '', empty: true, dayCount: 0 }
  return { markdown: out.join('\n').trimEnd() + '\n', empty: false, dayCount }
}
