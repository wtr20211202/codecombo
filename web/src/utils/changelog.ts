// 变更日志草稿生成（P-20261003-27）：tag..HEAD 区间提交按 conventional 前缀
// 分组聚合为 markdown 草稿。纯函数零依赖（数据面由调用方经 GetTags/log 区间
// 查询拉取），i18n 文案由调用方注入，方便单测与后续 agent 润色链路复用。

/** 草稿分区（顺序即输出顺序）；不在表内的规范前缀（chore/test/style…）与无
 * 前缀主题一律归 other，保证条目不丢 */
export const CHANGELOG_GROUPS = ['feat', 'fix', 'refactor', 'docs', 'perf', 'other'] as const
export type ChangelogGroup = (typeof CHANGELOG_GROUPS)[number]

/** 草稿条目源数据：subject 取提交主题行（%B 首行），hash 用于截短 */
export interface ChangelogCommit {
  hash: string
  subject: string
}

/** 解析主题行 → 所属分区 + 条目文本。
 * 容错规则：`type:` / `type(scope):` / `type(scope)!:` 识别为规范前缀，
 * type 命中分区表时条目去前缀（分区标题已表达类型）；其余（含未收录前缀、
 * 冒号缺失、空主题）原样归 other，不丢条目 */
export function parseSubject(subject: string): { group: ChangelogGroup; entry: string } {
  const text = subject.trim()
  const m = /^([A-Za-z]+)(\([^)]*\))?!?:\s*(.*)$/.exec(text)
  const type = m?.[1]?.toLowerCase()
  const entry = m?.[3]?.trim() ?? ''
  if (type && entry && (CHANGELOG_GROUPS as readonly string[]).includes(type)) {
    return { group: type as ChangelogGroup, entry }
  }
  return { group: 'other', entry: text }
}

export interface ChangelogDraftOptions {
  /** 区间标注（如 `v1.2.0..HEAD` / `最近 30 天`），进草稿头部引用行 */
  rangeLabel: string
  commits: ChangelogCommit[]
  /** 达到区间上限被截断时的标注文案（i18n 由调用方注入）；空串 = 不标注 */
  truncatedNote?: string
}

export interface ChangelogDraft {
  markdown: string
  /** 区间无提交：弹层展示空态、复制禁用 */
  empty: boolean
  truncated: boolean
}

/** 聚合为 markdown 草稿：`# Changelog` + 区间引用行 + `## 分区` + `- 短hash 条目`。
 * 空分区不输出；全部为空时返回 empty（markdown 置空） */
export function buildChangelogDraft(opts: ChangelogDraftOptions): ChangelogDraft {
  const truncated = !!opts.truncatedNote
  const sections = new Map<ChangelogGroup, string[]>()
  for (const c of opts.commits) {
    const subject = (c.subject || '').split('\n')[0]!
    if (!subject.trim()) continue
    const { group, entry } = parseSubject(subject)
    const short = (c.hash || '').substring(0, 8)
    const line = short ? `${short} ${entry}` : entry
    const bucket = sections.get(group)
    if (bucket) bucket.push(line)
    else sections.set(group, [line])
  }

  if (sections.size === 0) return { markdown: '', empty: true, truncated }

  const lines: string[] = ['# Changelog', '', `> ${opts.rangeLabel} · ${opts.commits.length} commits`, '']
  for (const group of CHANGELOG_GROUPS) {
    const bucket = sections.get(group)
    if (!bucket?.length) continue
    lines.push(`## ${group}`, '')
    for (const entry of bucket) lines.push(`- ${entry}`)
    lines.push('')
  }
  if (truncated) lines.push(`> ${opts.truncatedNote}`, '')
  return { markdown: lines.join('\n').trimEnd() + '\n', empty: false, truncated }
}
