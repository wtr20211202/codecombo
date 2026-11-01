/**
 * 批量诊断横向对比切片（P-20261004-58 纯函数）：
 * 多主机结构化摘要 → 指标列（含派生的磁盘使用率）→ 离群判定 →
 * 对比表高亮位与 markdown 巡检报告。对比表（RemoteDiagCompareDialog）与
 * 报告复制共用同一套指标定义与格式化，避免两处口径漂移。
 *
 * 离群判定不搞统计黑盒，两条线命中其一即离群：
 * 1. 绝对阈值（运维经验线）：磁盘使用率 ≥90%、存在失败服务——全体都高也照标；
 * 2. 中位数相对偏离：偏离全体中位数（坏方向）且「相对倍率 + 绝对差下限」
 *    双门槛同时成立——倍率防中位数很大时钝化，绝对差下限防小数值噪声
 *    （512MB / 15 个百分点 / 0.5 负载的量级由各指标定义给出）。
 * 采集值不足 2 台不做相对判定（没有「全体」可言），绝对阈值仍然生效。
 */
import type { DiagBatchResult, DiagSnapshot } from '../api/domains/remote'
import { formatMB } from './diagFormat'

/** 单台主机一行（对比表行模型 = 批量诊断结果本体，不另造形状） */
export type DiagCompareRow = DiagBatchResult

/** 指标列定义：取值 / 方向 / 离群门槛 / 展示格式（纯数据，i18n 由组件解析） */
export interface DiagMetricDef {
  key: 'diskAvail' | 'diskUsage' | 'memUsed' | 'load1' | 'cpu' | 'failedServices'
  /** i18n key：既有三指标复用 diag.hist.*（与单主机对比条同源），新列挂 remoteOps.diagCompare.col* */
  labelKey: string
  /** 从快照取值；undefined = 未采集（零值哨兵语义，显 — 不当 0） */
  get: (s: DiagSnapshot) => number | undefined
  /** true = 越大越坏（内存/负载/CPU/失败服务）；false = 越小越坏（磁盘可用） */
  badWhenUp: boolean
  /** 相对偏离的绝对差下限（按指标口径：MB / 百分点 / 负载值） */
  floor: number
  /** 坏方向相对中位数的倍率门槛：badWhenUp 时 v ≥ med×ratio；否则 v ≤ med×ratio（<1） */
  ratio: number
  /** 绝对阈值线（命中恒离群，与样本量无关） */
  abs?: (v: number) => boolean
  format: (v: number) => string
}

/** 派生磁盘使用率（%）：总量/可用齐备且可用 ≤ 总量才可算（负数/超总=数据异常不猜） */
export function diskUsagePct(s: DiagSnapshot): number | undefined {
  const avail = s.diskAvailMB
  const total = s.diskTotalMB
  if (!avail || !total || total <= 0 || avail < 0 || avail > total) return undefined
  return Math.round(((total - avail) / total) * 100)
}

/** 指标列集（表格列序即此数组序） */
export const DIAG_METRICS: DiagMetricDef[] = [
  {
    key: 'diskAvail',
    labelKey: 'diag.hist.diskAvail',
    get: s => (s.diskAvailMB && s.diskAvailMB > 0 ? s.diskAvailMB : undefined),
    badWhenUp: false,
    floor: 512, // 不足 512MB 的差距不构成「将满」信号
    ratio: 0.67, // 可用 ≤ 中位数的 2/3 视为显著偏低
    format: formatMB,
  },
  {
    key: 'diskUsage',
    labelKey: 'remoteOps.diagCompare.colDiskUsage',
    get: diskUsagePct,
    badWhenUp: true,
    floor: 15, // 高于中位数 ≥15 个百分点
    ratio: 1.25,
    abs: v => v >= 90, // 运维经验线：使用率 ≥90% 恒离群（全体都满也全标）
    format: v => `${v}%`,
  },
  {
    key: 'memUsed',
    labelKey: 'diag.hist.memUsed',
    get: s => (s.memUsedMB && s.memUsedMB > 0 ? s.memUsedMB : undefined),
    badWhenUp: true,
    floor: 512,
    ratio: 1.5,
    format: formatMB,
  },
  {
    key: 'load1',
    labelKey: 'diag.hist.load1',
    get: s => (s.load1 && s.load1 > 0 ? s.load1 : undefined),
    badWhenUp: true,
    floor: 0.5,
    ratio: 1.5,
    format: v => v.toFixed(2),
  },
  {
    key: 'cpu',
    labelKey: 'remoteOps.diagCompare.colCpu',
    get: s => (s.cpuPercent && s.cpuPercent > 0 ? s.cpuPercent : undefined),
    badWhenUp: true,
    floor: 20,
    ratio: 1.5,
    format: v => `${v}%`,
  },
  {
    key: 'failedServices',
    labelKey: 'remoteOps.diagCompare.colFailedServices',
    get: s => (s.failedServices === undefined ? undefined : s.failedServices),
    badWhenUp: true,
    floor: 1,
    ratio: 1.5,
    abs: v => v >= 1, // 存在失败服务即值得看（条数本身不关键）
    format: v => String(v),
  },
]

/** 中位数（偶数个取两中位均值；不改写入参；空集 NaN） */
export function median(values: number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const hi = sorted[mid] ?? 0
  const lo = sorted[mid - 1] ?? 0
  return sorted.length % 2 ? hi : (lo + hi) / 2
}

/** 单值离群判定（collected = 该指标全体采集值，含 v 自身） */
export function isOutlierValue(def: DiagMetricDef, collected: number[], v: number): boolean {
  if (def.abs?.(v)) return true
  if (collected.length < 2) return false
  const med = median(collected)
  if (def.badWhenUp) return v - med >= def.floor && v >= med * def.ratio
  return med - v >= def.floor && v <= med * def.ratio
}

/** 全表离群位：返回 "hostId:metricKey" 集合（表格高亮与 markdown 标记共用） */
export function pickOutlierCells(rows: DiagCompareRow[]): Set<string> {
  const out = new Set<string>()
  for (const def of DIAG_METRICS) {
    const collected: number[] = []
    const cells: { hostId: string; v: number }[] = []
    for (const r of rows) {
      if (!r.snapshot) continue
      const v = def.get(r.snapshot)
      if (v === undefined) continue
      collected.push(v)
      cells.push({ hostId: r.hostId, v })
    }
    for (const { hostId, v } of cells) {
      if (isOutlierValue(def, collected, v)) out.add(`${hostId}:${def.key}`)
    }
  }
  return out
}

/** 单元格文本：无快照/未采集显 —（零值哨兵，不当 0 展示） */
export function formatMetricValue(def: DiagMetricDef, s: DiagSnapshot | undefined): string {
  if (!s) return '—'
  const v = def.get(s)
  return v === undefined ? '—' : def.format(v)
}

/** 表格行序：可对比主机在前（组内按名称），失败主机沉底——
 *  离群扫描的视线动线是先比数值、后看失败原因 */
export function sortDiagRows(rows: DiagCompareRow[]): DiagCompareRow[] {
  const byName = (a: DiagCompareRow, b: DiagCompareRow) => a.name.localeCompare(b.name)
  const comparable = rows.filter(r => r.ok).sort(byName)
  const failed = rows.filter(r => !r.ok).sort(byName)
  return [...comparable, ...failed]
}

export interface DiagReportLabels {
  title: string
  host: string
  /** metricKey → 本地化列名（组件侧 t() 预解析，纯函数不碰 i18n） */
  metrics: Record<string, string>
  failedSection: string
}

/** 巡检报告 markdown：指标表（每行一主机）+ 失败主机清单。
 *  主机名/错误原文中的竖线转义防破坏表格结构；无快照的可对比主机照常成行
 *  （整行 — 是诚实的「未采集」），采集失败主机单列一节带原因 */
export function buildDiagCompareMarkdown(
  rows: DiagCompareRow[],
  labels: DiagReportLabels,
  generatedAt?: Date,
): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|')
  const hostLabel = (r: DiagCompareRow) => esc(r.name || r.hostId)
  const lines: string[] = [`## ${esc(labels.title)}`]
  if (generatedAt) lines.push('', `> ${generatedAt.toISOString()}`)
  const tableRows = rows.filter(r => r.ok)
  if (tableRows.length > 0) {
    lines.push(
      '',
      `| ${esc(labels.host)} | ${DIAG_METRICS.map(d => esc(labels.metrics[d.key] || d.key)).join(' | ')} |`,
      `| --- | ${DIAG_METRICS.map(() => '---').join(' | ')} |`,
    )
    for (const r of tableRows) {
      lines.push(`| ${hostLabel(r)} | ${DIAG_METRICS.map(d => esc(formatMetricValue(d, r.snapshot))).join(' | ')} |`)
    }
  }
  const failedRows = rows.filter(r => !r.ok)
  if (failedRows.length > 0) {
    lines.push('', `### ${esc(labels.failedSection)}`)
    for (const r of failedRows) lines.push(`- ${hostLabel(r)}：${esc(r.error || '')}`)
  }
  return `${lines.join('\n')}\n`
}
