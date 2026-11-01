// cronTrend 单测（P-20261005-237）：波动标记矩阵 / 迷你趋势坐标 / 数值短格式
import { describe, expect, it } from 'vitest'
import {
  TREND_ANOMALY_MIN_PRIOR,
  TREND_ANOMALY_RATIO,
  anomalyFlags,
  formatTrendValue,
  latestIsAnomaly,
  sparklinePoints,
} from './cronTrend'

describe('anomalyFlags', () => {
  it('先验不足的头部点位恒不标', () => {
    expect(anomalyFlags([])).toEqual([])
    expect(anomalyFlags([5])).toEqual([false])
    expect(anomalyFlags([5, 50])).toEqual([false, false]) // 先验仅 1 点
  })

  it('第三点起按 50% 偏差阈值判定', () => {
    // [3.5, 4.0, 12]：第三点先验均值 3.75，|12−3.75| > 1.875 → 波动
    expect(anomalyFlags([3.5, 4, 12])).toEqual([false, false, true])
    // 稳定序列无标记
    expect(anomalyFlags([10, 10.5, 9.8, 10.2])).toEqual([false, false, false, false])
    // 渐进漂移：每步偏差都在阈值内则不标（3→4 相对均值 3 偏差 1 = 33% < 50%）
    expect(anomalyFlags([3, 4, 5])[2]).toBe(false)
    // 回落形态同样可标（负向波动）
    expect(anomalyFlags([10, 10, 2])[2]).toBe(true)
  })

  it('负值指标与零基线不抛错、语义成立', () => {
    // 负值指标：均值 −10，偏离 6 > 5 → 标
    expect(anomalyFlags([-10, -10, -16])[2]).toBe(true)
    // 零基线：先验全零出现非零值即偏离
    expect(anomalyFlags([0, 0, 5])[2]).toBe(true)
    // 回到先验均值不标（偏差为零）
    expect(anomalyFlags([4, 6, 5])[2]).toBe(false)
  })
})

describe('latestIsAnomaly', () => {
  it('空序列 false，末点判定复用 anomalyFlags', () => {
    expect(latestIsAnomaly([])).toBe(false)
    expect(latestIsAnomaly([3.5, 4, 12])).toBe(true)
    expect(latestIsAnomaly([3.5, 4, 4.2])).toBe(false)
  })
})

describe('sparklinePoints', () => {
  it('点数 <2 或非法尺寸返回空（调用方不渲染 svg）', () => {
    expect(sparklinePoints([], 60, 16)).toBe('')
    expect(sparklinePoints([1], 60, 16)).toBe('')
    expect(sparklinePoints([1, 2], 0, 16)).toBe('')
  })

  it('等距 X 轴、Y 轴值域线性映射、恒定值折叠中线', () => {
    const pts = sparklinePoints([0, 10], 60, 16)
    expect(pts).toBe('1.0,15.0 59.0,1.0') // padding=1：低值在下、高值在上
    const flat = sparklinePoints([7, 7, 7], 60, 16)
    expect(flat.split(' ').every(p => p.endsWith(',8.0'))).toBe(true) // 中线 height/2
    const four = sparklinePoints([0, 5, 10, 15], 61, 21)
    const xs = four.split(' ').map(p => Number(p.split(',')[0]))
    expect(xs).toEqual([1, 20.7, 40.3, 60]) // 等距：1 + innerW(59)*i/(n-1)
  })
})

describe('formatTrendValue', () => {
  it('整数原样、小数至多两位', () => {
    expect(formatTrendValue(42)).toBe('42')
    expect(formatTrendValue(3.5)).toBe('3.5')
    expect(formatTrendValue(1 / 3)).toBe('0.33')
  })
})

describe('阈值常量契约', () => {
  it('粗放起步阈值不被无意改动（调整阈值应显式改这里并复核用例）', () => {
    expect(TREND_ANOMALY_MIN_PRIOR).toBe(2)
    expect(TREND_ANOMALY_RATIO).toBe(0.5)
  })
})
