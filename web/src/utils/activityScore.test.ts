// 活动热度纯函数单测（P-20261004-98）：权重/分档/合计的口径钉子——单实例
// 热力卡（P-20261003-37）与联邦活动卡（P-20261004-98）共用同一份实现，任一
// 侧口径漂移在此先红
import { describe, expect, it } from 'vitest'
import { activityLevel, activityScore, activityTotals } from './activityScore'

describe('activityScore 三项加权和', () => {
  it('权重 会话×3 > 提交×2 > 命令×1', () => {
    expect(activityScore({ commits: 1, sessions: 1, commands: 1 })).toBe(6)
    expect(activityScore({ commits: 0, sessions: 2, commands: 0 })).toBe(6)
    expect(activityScore({ commits: 3, sessions: 0, commands: 0 })).toBe(6)
  })

  it('缺行/null 计 0', () => {
    expect(activityScore(null)).toBe(0)
    expect(activityScore(undefined)).toBe(0)
    expect(activityScore({ commits: 0, sessions: 0, commands: 0 })).toBe(0)
  })
})

describe('activityLevel 峰值归一分档', () => {
  it('ceil 保证非零活动至少 1 档，峰值档 4 封顶', () => {
    expect(activityLevel(1, 100)).toBe(1)
    expect(activityLevel(50, 100)).toBe(2)
    expect(activityLevel(99, 100)).toBe(4)
    expect(activityLevel(100, 100)).toBe(4)
    expect(activityLevel(200, 100)).toBe(4)
  })

  it('零分/零峰值 → 0 档（空窗口不发光）', () => {
    expect(activityLevel(0, 100)).toBe(0)
    expect(activityLevel(10, 0)).toBe(0)
  })
})

describe('activityTotals 三项合计', () => {
  it('多行累加，缺行计零', () => {
    expect(activityTotals([
      { commits: 1, sessions: 2, commands: 3 },
      { commits: 10, sessions: 0, commands: 7 },
    ])).toEqual({ commits: 11, sessions: 2, commands: 10 })
    expect(activityTotals([])).toEqual({ commits: 0, sessions: 0, commands: 0 })
  })

  it('合计的分 = 逐行分的和（加权线性，联邦行汇总直用合计）', () => {
    const series = [
      { commits: 1, sessions: 1, commands: 1 },
      { commits: 2, sessions: 3, commands: 4 },
    ]
    const totals = activityTotals(series)
    const perRow = series.reduce((acc, e) => acc + activityScore(e), 0)
    expect(activityScore(totals)).toBe(perRow)
  })
})
