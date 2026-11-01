// 变更树「复制变更摘要」文本构建（P-20261003-219）：把变更清单 + 逐文件
// +N/-M 行数（GET /projects/:id/numstat 数据面）转述为行式摘要，供贴给
// agent / 记录（「这次改了 N 个文件 M 行」）。
//
// 格式约定：头部总计数行（文件数 + 总增删）+ 每文件一行
// `- <状态字母> <path> +<add> -<del>`；二进制文件以「(binary)」标注代替行数；
// numstat 未覆盖的文件（冲突未合并等）只出状态字母不出行数——宁缺毋谎。
// 行数是示意口径（AgentMarksStat 同哲学），文本消费方只用作规模感知。
// 本文件只做纯拼装（agentMarksList 同范式，可独立单测），取数在
// composables/useChangeTree 的复制动作里按需发起。

import type { NumstatFile } from '../api/domains/git'

/** 摘要组装所需的最小文件面（FileStatus 的形状子集） */
export interface ChangeSummaryFile {
  path: string
  status: string
}

/** 逐文件行数（NumstatFile 的形状子集） */
export interface ChangeSummaryStat {
  additions: number
  deletions: number
  binary?: boolean
}

/** 极小翻译面（纯函数可测；组合式传 useI18n 的 t，gitStatusSummary 同款先例） */
export type ChangeSummaryTranslator = (key: string, params?: Record<string, unknown>) => string

/** FileStatus.status → git 短状态字母（语言中立，摘要行保持紧凑） */
export function changeStatusLetter(status: string): string {
  switch (status) {
    case 'Modified': return 'M'
    case 'Added': return 'A'
    case 'Deleted': return 'D'
    case 'Renamed': return 'R'
    case 'Copied': return 'C'
    case 'Unmerged': return 'U'
    case 'Untracked': return '?'
    default: return status.slice(0, 1).toUpperCase()
  }
}

/**
 * 组装变更摘要（纯函数）：文件按全路径字典序（agentMarksList 同款目录分组序），
 * 同路径去重——status porcelain 对「已暂存又改」的文件会出两条记录，摘要里
 * 一个文件一行（numstat HEAD 本就按路径合并了两侧增删）。返回 '' 仅当无文件
 * （调用方在空变更集下不触发复制）
 */
export function buildChangeSummary(
  files: ChangeSummaryFile[],
  statByPath: Map<string, ChangeSummaryStat>,
  branch: string,
  t: ChangeSummaryTranslator,
): string {
  // 按路径去重（保留首个：staged 记录在前，状态字母取暂存侧语义）
  const seen = new Set<string>()
  const uniq = files.filter((f) => {
    if (seen.has(f.path)) return false
    seen.add(f.path)
    return true
  })
  if (uniq.length === 0) return ''
  const sorted = [...uniq].sort((a, b) => a.path.localeCompare(b.path))

  let additions = 0
  let deletions = 0
  const lines = sorted.map(f => {
    const stat = statByPath.get(f.path)
    let statPart = ''
    if (stat) {
      if (stat.binary) {
        statPart = ` (${t('changes.summary.binary')})`
      } else {
        additions += stat.additions
        deletions += stat.deletions
        statPart = ` +${stat.additions} -${stat.deletions}`
      }
    }
    return `- ${changeStatusLetter(f.status)} ${f.path}${statPart}`
  })

  // 头部总计数行：分支名在场（归属 + agent 接手时的落点）才进模板
  const headParams = { branch, n: sorted.length, a: additions, d: deletions }
  const head = branch.trim()
  lines.unshift(head ? t('changes.summary.headBranch', headParams) : t('changes.summary.head', headParams))
  return lines.join('\n')
}

/** numstat 响应 → path 索引表（复制动作侧的合并准备，脏行防御性丢弃） */
export function toStatMap(rows: NumstatFile[] | undefined): Map<string, ChangeSummaryStat> {
  const map = new Map<string, ChangeSummaryStat>()
  for (const r of rows || []) {
    if (!r || typeof r.path !== 'string' || r.path === '') continue
    map.set(r.path, { additions: Number(r.additions) || 0, deletions: Number(r.deletions) || 0, binary: !!r.binary })
  }
  return map
}
