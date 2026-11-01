import { describe, expect, it } from 'vitest'
import {
  buildDiagCompareMarkdown, DIAG_METRICS, diskUsagePct, formatMetricValue,
  isOutlierValue, median, pickOutlierCells, sortDiagRows,
  type DiagCompareRow,
} from './diagCompare'
import type { DiagSnapshot } from '../api/domains/remote'


/** 快照便捷构造（未给字段 = 未采集，与服务端 omitempty 缺省同形） */
function snap(partial: Partial<DiagSnapshot>): DiagSnapshot {
  return { ...partial }
}

function row(hostId: string, name: string, s?: Partial<DiagSnapshot>, error?: string): DiagCompareRow {
  return {
    hostId,
    name,
    ok: !error,
    durationMs: 10,
    ...(error ? { error } : {}),
    ...(s ? { snapshot: snap(s) } : {}),
  }
}

const diskAvail = DIAG_METRICS.find(d => d.key === 'diskAvail')!
const diskUsage = DIAG_METRICS.find(d => d.key === 'diskUsage')!
const memUsed = DIAG_METRICS.find(d => d.key === 'memUsed')!
const load1 = DIAG_METRICS.find(d => d.key === 'load1')!
const cpu = DIAG_METRICS.find(d => d.key === 'cpu')!
const failedServices = DIAG_METRICS.find(d => d.key === 'failedServices')!

describe('median', () => {
  it('奇数个取中位，偶数个取两中位均值，不改写入参', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    const src = [2, 1]
    median(src)
    expect(src).toEqual([2, 1])
  })

  it('空集 NaN，单元素即自身', () => {
    expect(median([])).toBeNaN()
    expect(median([7])).toBe(7)
  })
})

describe('diskUsagePct 派生列', () => {
  it('总量/可用齐备时算百分比并四舍五入', () => {
    expect(diskUsagePct(snap({ diskAvailMB: 2500, diskTotalMB: 10000 }))).toBe(75)
    expect(diskUsagePct(snap({ diskAvailMB: 2501, diskTotalMB: 10000 }))).toBe(75)
    expect(diskUsagePct(snap({ diskAvailMB: 2499, diskTotalMB: 10000 }))).toBe(75)
  })

  it('缺项/零总/负数/超总（数据异常）不猜，返回 undefined', () => {
    expect(diskUsagePct(snap({}))).toBeUndefined()
    expect(diskUsagePct(snap({ diskAvailMB: 100 }))).toBeUndefined()
    expect(diskUsagePct(snap({ diskAvailMB: 0, diskTotalMB: 1000 }))).toBeUndefined()
    expect(diskUsagePct(snap({ diskAvailMB: -5, diskTotalMB: 1000 }))).toBeUndefined()
    expect(diskUsagePct(snap({ diskAvailMB: 2000, diskTotalMB: 1000 }))).toBeUndefined()
  })
})

describe('isOutlierValue', () => {
  it('绝对阈值优先：全体都满也照标（磁盘使用率 ≥90%）', () => {
    // 三台全 95%：中位数 95，相对规则不触发；绝对线命中
    const collected = [95, 95, 95]
    expect(isOutlierValue(diskUsage, collected, 95)).toBe(true)
  })

  it('存在失败服务恒离群；0 台服务正常不标', () => {
    expect(isOutlierValue(failedServices, [0, 1, 0], 1)).toBe(true)
    expect(isOutlierValue(failedServices, [0, 0, 0], 0)).toBe(false)
  })

  it('相对偏离：坏方向超倍率且过绝对差下限才算（内存）', () => {
    // 中位数 2000：3.5× 中位数且差 5000 ≥ 512 → 离群
    expect(isOutlierValue(memUsed, [2000, 2000, 7000], 7000)).toBe(true)
    // 1.2× 中位数且差 400 < 512：小数值噪声不标
    expect(isOutlierValue(memUsed, [2000, 2000, 2400], 2400)).toBe(false)
    // 差 800 ≥ 512 但仅 1.4× 中位数：倍率不够不标
    expect(isOutlierValue(memUsed, [2000, 2000, 2800], 2800)).toBe(false)
  })

  it('好方向（磁盘可用）偏离才是坏：偏低超 2/3 中位数且差 ≥512MB 标，偏高不标', () => {
    expect(isOutlierValue(diskAvail, [20000, 20000, 4000], 4000)).toBe(true)
    // 偏低但差距 480 < 512：不标
    expect(isOutlierValue(diskAvail, [20000, 20000, 19520], 19520)).toBe(false)
    // 可用比典型大（好方向）：永不因相对偏离标
    expect(isOutlierValue(diskAvail, [20000, 20000, 40000], 40000)).toBe(false)
  })

  it('负载/CPU：双门槛联动（中位 0.4，1.8 高出 1.4 ≥ 0.5 且 4.5×）', () => {
    expect(isOutlierValue(load1, [0.4, 0.4, 1.8], 1.8)).toBe(true)
    // 高出 0.3 < 0.5 下限：不标
    expect(isOutlierValue(load1, [0.4, 0.4, 0.7], 0.7)).toBe(false)
    // 中位 10% vs 35%：差 25 ≥ 20 且 3.5× → 标
    expect(isOutlierValue(cpu, [10, 10, 35], 35)).toBe(true)
  })

  it('采集值不足 2 台不做相对判定，绝对阈值仍生效', () => {
    expect(isOutlierValue(memUsed, [1000], 8000)).toBe(false)
    expect(isOutlierValue(diskUsage, [50], 95)).toBe(true)
  })
})

describe('pickOutlierCells', () => {
  it('逐指标收集采集值，命中位以 hostId:key 回报；未采集主机跳过', () => {
    const rows: DiagCompareRow[] = [
      row('h1', 'web-1', { diskAvailMB: 20000, diskTotalMB: 25000, memUsedMB: 2000, load1: 0.4, cpuPercent: 10, failedServices: 0 }),
      row('h2', 'db-1', { diskAvailMB: 20000, diskTotalMB: 25000, memUsedMB: 2000, load1: 0.4, cpuPercent: 10, failedServices: 0 }),
      // 磁盘将满 + 负载异常的离群主机（使用率 88% vs 典型 20% 也属相对离群）
      row('h3', 'cache-1', { diskAvailMB: 3000, diskTotalMB: 25000, memUsedMB: 2100, load1: 3.0, cpuPercent: 12, failedServices: 2 }),
      // 采集失败主机：无快照，不参与任何指标
      row('h4', 'down-1', undefined, 'dial: connection refused'),
    ]
    const cells = pickOutlierCells(rows)
    expect(cells.has('h3:diskAvail')).toBe(true)
    expect(cells.has('h3:load1')).toBe(true)
    expect(cells.has('h3:failedServices')).toBe(true)
    expect(cells.has('h3:diskUsage')).toBe(true)
    // 其余主机无离群位
    expect(cells.has('h1:diskAvail')).toBe(false)
    expect(cells.has('h2:load1')).toBe(false)
    expect([...cells].every(c => c.startsWith('h3:'))).toBe(true)
  })

  it('使用率接近典型值（20% vs 20%）不误标，绝对线未命中', () => {
    const rows: DiagCompareRow[] = [
      row('a', 'a', { diskAvailMB: 20000, diskTotalMB: 25000 }),
      row('b', 'b', { diskAvailMB: 17500, diskTotalMB: 25000 }),
    ]
    expect(pickOutlierCells(rows).has('b:diskUsage')).toBe(false)
  })

  it('磁盘使用率绝对线：全体 95% 全表标', () => {
    const rows: DiagCompareRow[] = [
      row('a', 'a', { diskAvailMB: 500, diskTotalMB: 10000 }),
      row('b', 'b', { diskAvailMB: 500, diskTotalMB: 10000 }),
    ]
    const cells = pickOutlierCells(rows)
    expect(cells.has('a:diskUsage')).toBe(true)
    expect(cells.has('b:diskUsage')).toBe(true)
  })

  it('单主机无对比面：无相对离群，未命中绝对线时全表干净', () => {
    // 使用率 25%（<90%）：唯一主机不构成「偏离全体」
    const cells = pickOutlierCells([row('only', 'only', { diskAvailMB: 15000, diskTotalMB: 20000 })])
    expect(cells.size).toBe(0)
  })
})

describe('formatMetricValue', () => {
  it('未采集显 —（零值哨兵不当 0），各指标按口径格式化', () => {
    expect(formatMetricValue(diskAvail, undefined)).toBe('—')
    expect(formatMetricValue(diskAvail, snap({ diskAvailMB: 23552 }))).toBe('23.0 GB')
    expect(formatMetricValue(diskAvail, snap({ diskAvailMB: 512 }))).toBe('512 MB')
    expect(formatMetricValue(diskUsage, snap({ diskAvailMB: 7500, diskTotalMB: 10000 }))).toBe('25%')
    expect(formatMetricValue(load1, snap({ load1: 0.52 }))).toBe('0.52')
    expect(formatMetricValue(cpu, snap({ cpuPercent: 5.8 }))).toBe('5.8%')
    expect(formatMetricValue(failedServices, snap({ failedServices: 0 }))).toBe('0')
    expect(formatMetricValue(failedServices, snap({}))).toBe('—')
  })
})

describe('sortDiagRows', () => {
  it('可对比在前（组内按名称），失败主机沉底', () => {
    const sorted = sortDiagRows([
      row('z', 'zeta', undefined, 'dial failed'),
      row('b', 'beta', { memUsedMB: 1 }),
      row('a', 'alpha', undefined, 'auth failed'),
      row('c', 'carol', { memUsedMB: 2 }),
    ])
    expect(sorted.map(r => r.name)).toEqual(['beta', 'carol', 'alpha', 'zeta'])
  })

  it('空表安全', () => {
    expect(sortDiagRows([])).toEqual([])
  })
})

describe('buildDiagCompareMarkdown', () => {
  const labels = {
    title: '多主机巡检对比',
    host: '主机',
    metrics: {
      diskAvail: '磁盘可用', diskUsage: '磁盘使用率', memUsed: '内存用量',
      load1: '负载 1m', cpu: 'CPU 占用', failedServices: '失败服务',
    },
    failedSection: '采集失败',
  }

  it('表头 + 每行一主机；失败主机单列一节带原因', () => {
    const md = buildDiagCompareMarkdown([
      row('h1', 'web-1', { diskAvailMB: 20000, memUsedMB: 2000, failedServices: 0 }),
      row('h2', 'down-1', undefined, 'dial: refused'),
    ], labels, new Date('2026-10-09T00:00:00Z'))
    expect(md).toContain('## 多主机巡检对比')
    expect(md).toContain('> 2026-10-09T00:00:00.000Z')
    expect(md).toContain('| 主机 | 磁盘可用 | 磁盘使用率 | 内存用量 | 负载 1m | CPU 占用 | 失败服务 |')
    expect(md).toContain('| web-1 | 19.5 GB | — | 2.0 GB | — | — | 0 |')
    expect(md).toContain('### 采集失败')
    expect(md).toContain('- down-1：dial: refused')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('主机名/错误原文中的竖线转义，不破坏表格结构', () => {
    const md = buildDiagCompareMarkdown([
      row('h1', 'web|1', { memUsedMB: 1 }, undefined),
      row('h2', 'err|x', undefined, 'a|b'),
    ], labels)
    expect(md).toContain('| web\\|1 |')
    expect(md).toContain('- err\\|x：a\\|b')
    // 表格行内未转义竖线数不受影响（按「非转义 |」切列 = 1 首列 + 7 指标列）
    const tableLine = md.split('\n').find(l => l.startsWith('| web'))
    expect(tableLine?.split(/(?<!\\)\|/).length).toBe(9)
  })

  it('全部失败：只有标题与失败节，不出空表', () => {
    const md = buildDiagCompareMarkdown([row('h1', 'a', undefined, 'x')], labels)
    expect(md).toContain('### 采集失败')
    expect(md).not.toContain('| --- |')
  })

  it('空表只有标题', () => {
    expect(buildDiagCompareMarkdown([], labels)).toBe('## 多主机巡检对比\n')
  })

  it('缺列名回退 metricKey（labels 与指标集漂移时不产出空表头）', () => {
    const md = buildDiagCompareMarkdown(
      [row('h1', 'a', { memUsedMB: 1 })],
      { ...labels, metrics: {} },
    )
    expect(md).toContain('| 主机 | diskAvail |')
  })
})
