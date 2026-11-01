// 实例活动热度纯函数（P-20261003-37 / P-20261004-98）：把活动序列行的三项
// 数值（提交/会话/命令）转成两个可比较信号——① 加权和标量（活跃度汇总值，
// 跨实例对比的「哪台更闲/更忙」口径）② 0~4 档热力梯度。权重为可读性取舍非
// 精确度量（会话 > 提交 > 命令），单实例热力卡（ActivityHeatmapCard）与联邦
// 活动卡（FederationActivityCard）共用同一权重——单一事实源，禁两处漂移。
// 只做纯计算（changeHeat 同范式，可独立单测）；色阶归主题变量 color-mix 派生。

import type { ActivityDayEntry } from '../api/domains/report'

/** 活跃度权重：会话（agent 在干活）> 提交（产出落地）> 命令（人手敲） */
const W_COMMIT = 2
const W_SESSION = 3
const W_COMMAND = 1

/** 热力档位：0 = 无数据/零活动（缺行即空档），1~4 = 活跃度递增 */
export type ActivityHeatLevel = 0 | 1 | 2 | 3 | 4

/** 单行活跃度分：三项加权和（缺行 undefined/null 计 0） */
export function activityScore(e: Pick<ActivityDayEntry, 'commits' | 'sessions' | 'commands'> | null | undefined): number {
  if (!e) return 0
  return e.commits * W_COMMIT + e.sessions * W_SESSION + e.commands * W_COMMAND
}

/**
 * 活跃度分 → 热力档（0~4）：按峰值归一 ceil 分四档——ceil 保证非零活动至少
 * 1 档；peak ≤ 0（窗口全空）或零分 → 0 档；超峰值钳 4 档。peak 由调用方
 * 传入：单实例卡传本窗口峰值，联邦卡传跨行全局峰值（同尺才可比）
 */
export function activityLevel(score: number, peak: number): ActivityHeatLevel {
  if (score <= 0 || peak <= 0) return 0
  return Math.min(4, Math.ceil((score / peak) * 4)) as ActivityHeatLevel
}

/** 序列行三项合计（汇总值/摘要行的原始事实，缺行计零） */
export function activityTotals(series: readonly Pick<ActivityDayEntry, 'commits' | 'sessions' | 'commands'>[]): { commits: number; sessions: number; commands: number } {
  let commits = 0, sessions = 0, commands = 0
  for (const e of series) {
    commits += e.commits
    sessions += e.sessions
    commands += e.commands
  }
  return { commits, sessions, commands }
}
