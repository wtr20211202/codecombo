// 重复命令聚合（P-20261003-199）：terminal-history 现成条目的纯前端频次统计。
// 服务端每项目历史为 500 条 LRU（server/store/terminal_history.go TerminalHistoryMax），
// 单次聚合上限有界，全量遍历 + Map 计数即 O(n)，无需服务端新端点。
// 语义：同一命令文本（精确匹配；服务端入库已 trim）在窗口期内出现 ≥ minCount 次
// 视为「重复命令」，按次数降序（同数按最近使用新者在前）取前 topN 条。

/** 频次参数（任务书定档常量起步）：次数≥3 / 近 7 天窗 / 最多 20 条 */
export const REPEAT_COMMAND_MIN_COUNT = 3
export const REPEAT_COMMAND_WINDOW_DAYS = 7
export const REPEAT_COMMAND_TOP_N = 20

/** 聚合输入的最小结构面（HistoryPanel.HistoryEntry 结构兼容即入参） */
export interface HistoryLikeEntry {
  command: string
  at: string
}

export interface RepeatCommandStat {
  command: string
  /** 窗口期内出现次数（≥ minCount） */
  count: number
  /** 窗口期内最近一次的条目时间原文（RFC3339，列表展示直接 formatTime） */
  lastUsedAt: string
}

export interface RepeatCommandOptions {
  /** 「现在」锚点（默认 new Date()；测试注入固定时点） */
  now?: Date
  minCount?: number
  windowDays?: number
  topN?: number
}

export function aggregateRepeatedCommands(
  entries: readonly HistoryLikeEntry[],
  opts: RepeatCommandOptions = {},
): RepeatCommandStat[] {
  const nowMs = (opts.now ?? new Date()).getTime()
  const minCount = opts.minCount ?? REPEAT_COMMAND_MIN_COUNT
  const windowMs = (opts.windowDays ?? REPEAT_COMMAND_WINDOW_DAYS) * 24 * 60 * 60 * 1000
  const topN = opts.topN ?? REPEAT_COMMAND_TOP_N
  const cutoff = nowMs - windowMs

  const byCmd = new Map<string, { count: number; lastMs: number; lastAt: string }>()
  for (const e of entries) {
    const t = new Date(e.at).getTime()
    // 非法时间戳跳过；略超前于 now 的条目（服务端落盘时钟毛刺）仍属「最近」，不排除
    if (!Number.isFinite(t) || t < cutoff) continue
    const cur = byCmd.get(e.command)
    if (!cur) {
      byCmd.set(e.command, { count: 1, lastMs: t, lastAt: e.at })
    } else {
      cur.count++
      if (t > cur.lastMs) {
        cur.lastMs = t
        cur.lastAt = e.at
      }
    }
  }

  return [...byCmd.entries()]
    .filter(([, v]) => v.count >= minCount)
    .sort((a, b) => b[1].count - a[1].count || b[1].lastMs - a[1].lastMs)
    .slice(0, topN)
    .map(([command, v]) => ({ command, count: v.count, lastUsedAt: v.lastAt }))
}
