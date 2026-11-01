// 变更树「按改动量排序 + 行数热力」纯函数（P-20261003-239）：把 numstat 数据面
//（GET /projects/:id/numstat，P-20261003-219 复制摘要同源）的逐文件增删行数
// 转成两个审阅焦点信号——① 树内排序键（改动多的在前）② 0~4 档热力梯度。
// 档位口径与实例活动热力图（P-20261003-37 ActivityHeatmapCard）一致：按峰值
// 归一 ceil 分四档、零行不发光；色阶本身在 commit-panel.css 走主题变量
// color-mix 派生（对比度域归主题治理，与 P-37 同约定），本文件只管分档。
// 只做纯计算（changeSummary 同范式，可独立单测）；取数与树接线在
// composables/useChangeTree。

import type { ChangeSummaryStat } from './changeSummary'

/** 热力档位：0 = 无行数量（零行/二进制/numstat 未覆盖不发光），1~4 = 递增 */
export type ChangeHeatLevel = 0 | 1 | 2 | 3 | 4

/**
 * 行数 → 热力档（0~4）：按当前变更集峰值归一 ceil 分四档（P-37 同式——ceil
 * 保证非零行至少 1 档；峰值 0（全是零行改动）或零行 → 0 档；超峰值钳 4 档）
 */
export function heatLevel(lines: number, peak: number): ChangeHeatLevel {
  if (lines <= 0 || peak <= 0) return 0
  return Math.min(4, Math.ceil((lines / peak) * 4)) as ChangeHeatLevel
}

/** 行热力视图：挂在树文件节点上，CommitChangeTree 渲染行首梯度条 + tooltip */
export interface ChangeNodeHeat {
  additions: number
  deletions: number
  level: ChangeHeatLevel
}

/**
 * 文件节点热力视图：numstat 未覆盖（冲突未合并等）/二进制（不数行，P-219
 * 同「宁缺毋谎」口径——没有行数量就不虚构热度）/零行 → undefined 不渲染。
 * peak 由调用方按全量变更集计算（过滤只裁剪显示不重标定色阶）
 */
export function nodeHeat(
  stat: Pick<ChangeSummaryStat, 'additions' | 'deletions' | 'binary'> | undefined,
  peak: number,
): ChangeNodeHeat | undefined {
  if (!stat || stat.binary) return undefined
  const level = heatLevel(stat.additions + stat.deletions, peak)
  if (level === 0) return undefined
  return { additions: stat.additions, deletions: stat.deletions, level }
}

/** 树节点的排序视图：volume = 改动行数（文件=自身；目录=子树合计，接线侧算好） */
export interface VolumeNode {
  name: string
  isDir: boolean
  volume: number
}

/**
 * 「按改动量」同级比较器：volume 降序在前，同量按名升序（确定性兜底——比较器
 * 不稳定会让行序在重渲染间抖动）。「目录先于文件」的树结构不变量由调用方的
 * isDir 分支先行保证，不进本比较器
 */
export function compareByVolumeDesc(a: VolumeNode, b: VolumeNode): number {
  if (b.volume !== a.volume) return b.volume - a.volume
  return a.name.localeCompare(b.name)
}
