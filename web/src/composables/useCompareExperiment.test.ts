import { describe, expect, it } from 'vitest'
import {
  applyPlanCounts, defaultRuntimesPair, formatTokens, isSameDirExperiment,
  openCompareExperiment, sideState,
} from './useCompareExperiment'
import type { CompareExperiment, CompareFileRow } from '../api/domains/compare'

/**
 * 对比实验组合式纯函数单测（P-20261003-46）：状态词法/默认运行时对/token 格式。
 * 组合式本体依赖 i18n/naive discrete api（jsdom 不可测边界），可测面收敛在导出
 * 纯函数——模块级单例 openCompareExperiment 的开合副作用一并覆盖。
 */
describe('sideState', () => {
  it('done/failed/error 词法映射终结态', () => {
    expect(sideState('done')).toBe('done')
    expect(sideState('failed')).toBe('failed')
    expect(sideState('error: dir does not exist')).toBe('error')
  })
  it('空回执一律等待（含会话已消亡的诚实降级）', () => {
    expect(sideState(undefined)).toBe('waiting')
    expect(sideState('')).toBe('waiting')
    expect(sideState('running')).toBe('waiting')
  })
})

describe('defaultRuntimesPair', () => {
  it('取前两个可用的一等运行时', () => {
    expect(defaultRuntimesPair([
      { name: 'codex', available: true },
      { name: 'claude', available: true },
      { name: 'dsh', available: true },
    ])).toEqual({ a: 'codex', b: 'claude' })
  })
  it('跳过不可用与 shell/auto', () => {
    expect(defaultRuntimesPair([
      { name: 'shell', available: true },
      { name: 'auto', available: true },
      { name: 'claude', available: false },
      { name: 'codex', available: true },
    ])).toEqual({ a: 'codex', b: 'auto' })
  })
  it('无可用运行时回落 auto 对（提交前由 sameRuntime 校验拦截）', () => {
    expect(defaultRuntimesPair([{ name: 'claude', available: false }])).toEqual({ a: 'auto', b: 'auto' })
    expect(defaultRuntimesPair([])).toEqual({ a: 'auto', b: 'auto' })
  })
})

describe('formatTokens', () => {
  it('千/百万缩写', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_340)).toBe('12.3k')
    expect(formatTokens(1_234_567)).toBe('1.2M')
  })
  it('无数据空串（无数据 ≠ 零消耗，不渲染 0）', () => {
    expect(formatTokens(undefined)).toBe('')
    expect(formatTokens(Number.NaN)).toBe('')
  })
})

describe('openCompareExperiment 单例开合', () => {
  it('打开并支持携带选中实验（开合事实模块级共享）', async () => {
    const { show } = await import('./useCompareExperiment').then(m => m.useCompareExperiment())
    show.value = false
    openCompareExperiment('cmp-1')
    expect(show.value).toBe(true)
    show.value = false
    expect(show.value).toBe(false)
  })
})

// ── 采用落盘二阶段（P-20261004-72）：行动计划计数与服务端 planApplyRows 同构 ──

const planRows: CompareFileRow[] = [
  { path: 'a-only.ts', inA: true, inB: false, statusA: 'M' },
  { path: 'b-only.ts', inA: false, inB: true, statusB: 'M' },
  { path: 'b-new.ts', inA: false, inB: true, statusB: '?' },
  { path: 'both.ts', inA: true, inB: true, statusA: 'M', statusB: 'A' },
]

describe('applyPlanCounts', () => {
  it('分目录形态：采用 A → B 独有 tracked 回滚 / untracked 删除', () => {
    expect(applyPlanCounts(planRows, 'a', false)).toEqual({
      kept: 1, rolledBack: 1, deleted: 1, noop: 1,
    })
  })
  it('同目录形态：他侧独有全部落无操作（已在采用基线），零破坏动作', () => {
    expect(applyPlanCounts(planRows, 'a', true)).toEqual({
      kept: 1, rolledBack: 0, deleted: 0, noop: 3,
    })
  })
  it('采用 B 镜像对称（B 独有保留，A 独有回滚）', () => {
    expect(applyPlanCounts(planRows, 'b', false)).toEqual({
      kept: 2, rolledBack: 1, deleted: 0, noop: 1,
    })
  })
  it('空清单全零', () => {
    expect(applyPlanCounts([], 'a', false)).toEqual({ kept: 0, rolledBack: 0, deleted: 0, noop: 0 })
  })
})

describe('isSameDirExperiment', () => {
  it('双侧目录一致（含缺省同空）= 同目录；分目录 worktree 为 false', () => {
    const mk = (a?: string, b?: string): CompareExperiment => ({
      id: 'cmp-1', prompt: 'p', status: 'ready', createdAt: '2026-10-08T00:00:00Z',
      a: { sessionId: '1', dir: a }, b: { sessionId: '2', dir: b },
    })
    expect(isSameDirExperiment(mk('/w', '/w'))).toBe(true)
    expect(isSameDirExperiment(mk())).toBe(true)
    expect(isSameDirExperiment(mk('/wa', '/wb'))).toBe(false)
  })
})
