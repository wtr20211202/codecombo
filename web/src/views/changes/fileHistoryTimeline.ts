/**
 * 文件历史聚合时间线（P-20261008-11）的纯合流逻辑：git 提交流（logApi.getFileLog）
 * 与本地保存快照流（fileHistoryApi.list，P-20261002-130）按时间降序穿插成单列。
 *
 * 时间窗对齐口径：本地历史是滚动保留（每项目 512 条/50MB 逐最旧逐出），服务端
 * 返回的窗口即「可恢复范围」——合流（全部来源）视图内提交只取同窗（≥ 最旧快照
 * 时刻），更早的提交不混列、只回告条数供「更早提交见 Git 历史」注记（点击切
 * 「只看 Git」看全量）。无快照时窗口不存在 → 提交全量照列（= 既有纯 git 视图，
 * 无本地历史的文件零行为变化）。排序键统一 epoch ms（提交为 ISO date 字符串、
 * 快照为毫秒数）；同时刻（同秒提交+保存）git 在前——提交是更持久的里程碑。
 */

export interface GitTimelineEntry {
  kind: 'git'
  hash: string
  shortHash: string
  message: string
  author: string
  ts: number
}

export interface LocalTimelineEntry {
  kind: 'local'
  /** 快照版本寻址串（UnixNano hex，前端不拆不拼） */
  id: string
  size: number
  ts: number
}

export type TimelineEntry = GitTimelineEntry | LocalTimelineEntry

/** logApi.getFileLog 条目的消费面字段（其余字段不参与合流） */
export interface RawGitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  date?: string | null
}

/** fileHistoryApi.list 条目（FileVersion 镜像） */
export interface RawLocalVersion {
  id: string
  ts: number
  size: number
}

export interface BuiltTimeline {
  entries: TimelineEntry[]
  /** 窗口外更早提交条数（0 = 无「更早提交」注记） */
  olderCommits: number
}

export function buildTimeline(commits: RawGitCommit[], versions: RawLocalVersion[]): BuiltTimeline {
  const entries: TimelineEntry[] = versions.map(v => ({
    kind: 'local',
    id: v.id,
    size: v.size,
    ts: v.ts,
  }))
  const windowStart = versions.length > 0 ? Math.min(...versions.map(v => v.ts)) : null

  let olderCommits = 0
  for (const c of commits) {
    const ts = c.date ? new Date(c.date).getTime() : NaN
    if (windowStart !== null && (!Number.isFinite(ts) || ts < windowStart)) {
      olderCommits++
      continue
    }
    entries.push({
      kind: 'git',
      hash: c.hash,
      shortHash: c.shortHash,
      message: c.message,
      author: c.author,
      ts: Number.isFinite(ts) ? ts : 0,
    })
  }

  // 降序；稳定排序下同时刻以比较器显式定序（git 在前），不依赖插入顺序
  entries.sort((a, b) => {
    if (a.ts !== b.ts) return b.ts - a.ts
    if (a.kind !== b.kind) return a.kind === 'git' ? -1 : 1
    return 0
  })
  return { entries, olderCommits }
}
