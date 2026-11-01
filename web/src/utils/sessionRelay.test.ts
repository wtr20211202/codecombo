import { describe, expect, it } from 'vitest'
import { isLowRemaining, LOW_REMAINING_PCT, pickRelaySummary, RELAY_TAIL_ENTRIES } from './sessionRelay'
import type { ClaudeSessionPressure, ClaudeTimelineEntry } from '../api/domains/claude'

/** 构造时间线条目的便捷工厂（只给测试关心的字段） */
function e(kind: ClaudeTimelineEntry['kind'], text: string): ClaudeTimelineEntry {
  return { kind, at: '', text }
}

/** 压力估算工厂（只给测试关心的字段，形态对齐 server/claudesessions.Pressure） */
function p(percent: number): ClaudeSessionPressure {
  return { estimatedTokens: 0, windowTokens: 200_000, percent, estimated: true }
}

describe('pickRelaySummary（P-20261003-114 会话接力）', () => {
  it('取最后一条 assistant 文本（结论优先弃过程）', () => {
    const entries = [
      e('user', '修一下构建'),
      e('assistant', '定位到是 webpack 配置问题'),
      e('tool', 'D:\\x\\build.gradle'), // 过程性条目不入选
      e('result', 'ok'),
      e('assistant', '已修复，测试全绿，下一步是发布 0.0.2'),
    ]
    expect(pickRelaySummary(entries)).toBe('已修复，测试全绿，下一步是发布 0.0.2')
  })

  it('末尾是 user 指令 / tool 混排时回溯到此前最近的 assistant 文本', () => {
    const entries = [
      e('assistant', '最终结论：切换到 vite 后构建时长减半'),
      e('user', '好的，明天继续'),
      e('tool', 'git status'),
      e('result', 'clean'),
    ]
    expect(pickRelaySummary(entries)).toBe('最终结论：切换到 vite 后构建时长减半')
  })

  it('跳过空正文 / 纯空白的 assistant 条目', () => {
    const entries = [
      e('assistant', '  '),
      e('assistant', '\n'),
      e('assistant', '  实质结论  '),
    ]
    expect(pickRelaySummary(entries)).toBe('实质结论')
  })

  it('窗口内没有 assistant 文本（纯工具会话）返回空串，由调用方如实放弃', () => {
    const entries = [e('user', '跑构建'), e('tool', 'npm run build'), e('result', 'ok')]
    expect(pickRelaySummary(entries)).toBe('')
  })

  it('空窗口返回空串', () => {
    expect(pickRelaySummary([])).toBe('')
  })

  it('尾部回溯窗口常量在合理量级（覆盖收尾一段、远小于服务端条目上限）', () => {
    expect(RELAY_TAIL_ENTRIES).toBeGreaterThanOrEqual(30)
    expect(RELAY_TAIL_ENTRIES).toBeLessThanOrEqual(200)
  })
})

describe('isLowRemaining（P-20261003-141 上下文低余量警示）', () => {
  it('余量不足阈值：占用 97.5% → 警示', () => {
    expect(isLowRemaining(p(97.5))).toBe(true)
  })

  it('恰好压线不警示：占用 90%（余量恰 10%）→ 严格小于语义', () => {
    expect(LOW_REMAINING_PCT).toBe(10)
    expect(isLowRemaining(p(90))).toBe(false)
  })

  it('余量充足：占用 85% / 30% → 不警示', () => {
    expect(isLowRemaining(p(85))).toBe(false)
    expect(isLowRemaining(p(30))).toBe(false)
  })

  it('超窗（估算 >100%）→ 警示（服务端允许窗口溢出如实上报）', () => {
    expect(isLowRemaining(p(102.4))).toBe(true)
  })

  it('无压力数据恒不警示（「无数据」≠「将满」，与服务端 ok=false 语义同纪律）', () => {
    expect(isLowRemaining(undefined)).toBe(false)
  })
})

describe('isLowRemaining 阈值注入（P-20261006-33 用户可调警示线）', () => {
  it('缺省参数 = 出厂档 10：与显式传 LOW_REMAINING_PCT 完全同判', () => {
    // 余量 15%（占用 85%）：出厂档不警示
    expect(isLowRemaining(p(85))).toBe(false)
    expect(isLowRemaining(p(85), LOW_REMAINING_PCT)).toBe(false)
    // 余量 8%（占用 92%）：出厂档警示
    expect(isLowRemaining(p(92))).toBe(true)
    expect(isLowRemaining(p(92), LOW_REMAINING_PCT)).toBe(true)
  })

  it('注入矩阵：占用 88%（余量 12%）× 阈值 5/10/15/20 → 仅 ≥15 警示', () => {
    expect(isLowRemaining(p(88), 5)).toBe(false)
    expect(isLowRemaining(p(88), 10)).toBe(false)
    expect(isLowRemaining(p(88), 15)).toBe(true)
    expect(isLowRemaining(p(88), 20)).toBe(true)
  })

  it('自定义阈值同样严格小于：余量恰等于阈值不警示（压线语义与出厂档同纪律）', () => {
    expect(isLowRemaining(p(80), 20)).toBe(false)
    expect(isLowRemaining(p(80.1), 20)).toBe(true)
  })

  it('自定义阈值下无压力数据仍恒不警示（注入不改变「无数据」纪律）', () => {
    expect(isLowRemaining(undefined, 30)).toBe(false)
  })
})
