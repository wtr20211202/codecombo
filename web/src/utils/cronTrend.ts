// cronTrend —— 定时任务指标时序的呈现侧纯函数（P-20261005-237）
//
// 服务端只存原始点位（cronmetric 环形 30 点），波动判定与迷你趋势坐标都在
// 这里收口：阈值粗放起步（较前均值偏差超半即标），调阈值只动本文件、
// 不迁移数据不换协议。服务端不做波动判定——agent 巡检直读原始点位
// 自行设阈，前端阈值只服务人读呈现。

/** 波动判定的先验点位下限：先验不足 2 点不判（单点基线的「偏差」是噪声） */
export const TREND_ANOMALY_MIN_PRIOR = 2

/** 波动阈值（粗放起步）：偏离先验均值超过 50% 判为异常波动点 */
export const TREND_ANOMALY_RATIO = 0.5

/**
 * 逐点波动标记：返回与 values 等长的布尔数组（true = 异常波动点）。
 * 判定 = |v − mean(prior)| > |mean(prior)| × RATIO；均值取绝对值兜负值
 * （指标语义是「偏离倍数」，负值指标同样成立）；头部点位先验不足恒 false。
 * 长度不足/空输入返回等长 false 数组，绝不抛错（渲染路径直连）
 */
export function anomalyFlags(values: number[]): boolean[] {
  return values.map((v, i) => {
    if (i < TREND_ANOMALY_MIN_PRIOR) return false
    let sum = 0
    for (let j = 0; j < i; j++) sum += values[j]!
    const mean = sum / i
    if (mean === 0) return v !== 0 // 零基线：出现任何非零值即偏离
    return Math.abs(v - mean) > Math.abs(mean) * TREND_ANOMALY_RATIO
  })
}

/** 当前/latest 点是否波动（无点为 false）——列表行内标记的判定入口 */
export function latestIsAnomaly(values: number[]): boolean {
  if (values.length === 0) return false
  return anomalyFlags(values)[values.length - 1]!
}

/**
 * 迷你趋势折线的 SVG points 属性值（viewBox 内归一化，等距 X 轴、Y 轴按
 * 值域线性映射，padding 留白防描边被视窗裁切）。单点退化（无可连折线）与
 * 空输入返回 ''——调用方按长度 ≥2 才渲染 svg。恒定值序列折叠成中线
 */
export function sparklinePoints(values: number[], width: number, height: number): string {
  const n = values.length
  if (n < 2 || width <= 0 || height <= 0) return ''
  const pad = 1
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const innerW = width - pad * 2
  const innerH = height - pad * 2
  const yOf = (v: number): number =>
    span === 0 ? height / 2 : pad + innerH - ((v - min) / span) * innerH
  return values
    .map((v, i) => `${(pad + (innerW * i) / (n - 1)).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(' ')
}

/** 数值短格式：整数原样、小数最多两位（指标单位由规则定义，前端不附加） */
export function formatTrendValue(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}
