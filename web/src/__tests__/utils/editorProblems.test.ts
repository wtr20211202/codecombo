import { describe, it, expect } from 'vitest'
import {
  aggregateProblems,
  markerResourcePath,
  normalizeDiagnosticCode,
  diagnosticSourceOf,
  diagnosticOriginText,
  pickDiagnosticMarker,
  filterProblemGroups,
  MARKER_SEVERITY,
} from '../../../src/utils/editorProblems'

/** 构造 RawProblemMarker 纯对象（不拉起 monaco） */
function mk(overrides: Partial<{
  path: string
  line: number
  col: number
  severity: number
  message: string
  source: string
}>) {
  return {
    resource: { path: overrides.path ?? '/src/a.ts' },
    startLineNumber: overrides.line ?? 1,
    startColumn: overrides.col ?? 1,
    severity: overrides.severity ?? MARKER_SEVERITY.Error,
    message: overrides.message ?? 'err',
    source: overrides.source,
  }
}

describe('aggregateProblems', () => {
  it('按严重级排序：error 先于 warning，同文件条目归入同组', () => {
    const agg = aggregateProblems([
      mk({ path: '/src/a.ts', line: 5, severity: MARKER_SEVERITY.Warning }),
      mk({ path: '/src/a.ts', line: 2, severity: MARKER_SEVERITY.Error }),
      mk({ path: '/src/b.ts', line: 9, severity: MARKER_SEVERITY.Error }),
    ])
    expect(agg.total).toBe(3)
    expect(agg.errorCount).toBe(2)
    expect(agg.warningCount).toBe(1)
    expect(agg.groups.map((g) => g.path)).toEqual(['src/a.ts', 'src/b.ts'])
    // 组内：error 行在前，warning 在后
    expect(agg.groups[0]!.items.map((i) => i.line)).toEqual([2, 5])
    expect(agg.groups[0]!.items[0]!.severity).toBe('error')
  })

  it('路径剥掉模型 URI 的首段斜杠（file:///${相对路径} 约定的逆向）', () => {
    const agg = aggregateProblems([mk({ path: '/web/src/main.ts' })])
    expect(agg.groups[0]!.path).toBe('web/src/main.ts')
  })

  it('文件组按最高严重级排序：error 文件靠前于 warning-only 文件', () => {
    const agg = aggregateProblems([
      mk({ path: '/z/warn-only.ts', line: 1, severity: MARKER_SEVERITY.Warning }),
      mk({ path: '/a/has-error.ts', line: 3, severity: MARKER_SEVERITY.Warning }),
      mk({ path: '/a/has-error.ts', line: 4, severity: MARKER_SEVERITY.Error }),
    ])
    expect(agg.groups.map((g) => g.path)).toEqual(['a/has-error.ts', 'z/warn-only.ts'])
  })

  it('同严重级按行列升序', () => {
    const agg = aggregateProblems([
      mk({ line: 10, col: 2 }),
      mk({ line: 3, col: 30 }),
      mk({ line: 3, col: 5 }),
    ])
    expect(agg.groups[0]!.items.map((i) => [i.line, i.col])).toEqual([[3, 5], [3, 30], [10, 2]])
  })

  it('空输入返回全零聚合', () => {
    const agg = aggregateProblems([])
    expect(agg).toEqual({ groups: [], errorCount: 0, warningCount: 0, infoCount: 0, total: 0 })
  })

  it('info/hint 计入 total 与 infoCount，排序在 error/warning 之后', () => {
    const agg = aggregateProblems([
      mk({ line: 7, severity: MARKER_SEVERITY.Info }),
      mk({ line: 8, severity: MARKER_SEVERITY.Hint }),
      mk({ line: 9, severity: MARKER_SEVERITY.Error }),
    ])
    expect(agg.total).toBe(3)
    expect(agg.infoCount).toBe(2)
    expect(agg.errorCount).toBe(1)
    expect(agg.groups[0]!.items.map((i) => i.severity)).toEqual(['error', 'info', 'hint'])
  })

  it('markerResourcePath：无前导斜杠原样返回（防御非预期形态）', () => {
    expect(markerResourcePath({ path: 'bare.ts' })).toBe('bare.ts')
    expect(markerResourcePath({})).toBe('')
  })
})

describe('诊断「问智能体」载荷字段归一（P-20261006-2）', () => {
  it('normalizeDiagnosticCode：字符串透传、{value} 对象取 value、空值归一 undefined', () => {
    expect(normalizeDiagnosticCode('2322')).toBe('2322')
    expect(normalizeDiagnosticCode({ value: 'no-unused-vars' })).toBe('no-unused-vars')
    expect(normalizeDiagnosticCode('')).toBeUndefined()
    expect(normalizeDiagnosticCode({ value: '' })).toBeUndefined()
    expect(normalizeDiagnosticCode(undefined)).toBeUndefined()
  })

  it('diagnosticSourceOf：source 优先 owner 兜底（ts.worker 只设 owner），全缺省 undefined', () => {
    expect(diagnosticSourceOf({ source: 'eslint', owner: 'typescript' })).toBe('eslint')
    expect(diagnosticSourceOf({ source: undefined, owner: 'typescript' })).toBe('typescript')
    expect(diagnosticSourceOf({ source: '', owner: '' })).toBeUndefined()
    expect(diagnosticSourceOf({})).toBeUndefined()
  })

  it('diagnosticOriginText：与 Monaco marker hover 同款渲染式，全缺省空串（不产悬空括号）', () => {
    expect(diagnosticOriginText('ts', '2322')).toBe('ts(2322)')
    expect(diagnosticOriginText('eslint', undefined)).toBe('eslint')
    expect(diagnosticOriginText(undefined, '2322')).toBe('(2322)')
    expect(diagnosticOriginText(undefined, undefined)).toBe('')
  })

  it('aggregateProblems 透传 owner 与字符串化 code（面板条目载荷）', () => {
    const agg = aggregateProblems([{
      resource: { path: '/src/a.ts' },
      startLineNumber: 1,
      startColumn: 24,
      severity: MARKER_SEVERITY.Error,
      message: 'Type X is not assignable',
      owner: 'typescript',
      code: { value: '2322' },
    }])
    expect(agg.groups[0]!.items[0]!.owner).toBe('typescript')
    expect(agg.groups[0]!.items[0]!.code).toBe('2322')
  })
})

describe('filterProblemGroups 显示层过滤（P-20261005-171）', () => {
  /** 固定三态样本：a.ts 1 error + 1 warning，b.css 1 warning（aggregateProblems 实产形态） */
  function sampleGroups() {
    return aggregateProblems([
      mk({ path: '/src/a.ts', line: 3, severity: MARKER_SEVERITY.Error, message: 'Type X is not assignable' }),
      mk({ path: '/src/a.ts', line: 7, severity: MARKER_SEVERITY.Warning, message: 'Unknown property.' }),
      mk({ path: '/web/style.css', line: 2, severity: MARKER_SEVERITY.Warning, message: 'Unknown property.' }),
    ]).groups
  }

  it('无过滤 = 原样透传，matched = 全量条目数', () => {
    const r = filterProblemGroups(sampleGroups(), '', null)
    expect(r.matched).toBe(3)
    expect(r.groups.map((g) => g.path)).toEqual(['src/a.ts', 'web/style.css'])
    expect(r.groups[0]!.items).toHaveLength(2)
  })

  it('纯空白文本视同不过滤（与面板 trim 口径一致）', () => {
    expect(filterProblemGroups(sampleGroups(), '   ', null).matched).toBe(3)
  })

  it('严重级 chip：仅错误→1 条、仅警告→2 条，被滤空的文件组整组剔除', () => {
    const errs = filterProblemGroups(sampleGroups(), '', 'error')
    expect(errs.matched).toBe(1)
    expect(errs.groups.map((g) => g.path)).toEqual(['src/a.ts'])
    expect(errs.groups[0]!.items[0]!.line).toBe(3)

    const warns = filterProblemGroups(sampleGroups(), '', 'warning')
    expect(warns.matched).toBe(2)
    expect(warns.groups.map((g) => g.path)).toEqual(['src/a.ts', 'web/style.css'])
    expect(warns.groups[0]!.items.map((i) => i.line)).toEqual([7])
  })

  it('文本过滤：message 命中（大小写不敏感），不匹配级别不豁免', () => {
    const r = filterProblemGroups(sampleGroups(), 'UNKNOWN PROPERTY', null)
    expect(r.matched).toBe(2)
    const miss = filterProblemGroups(sampleGroups(), 'not assignable', 'warning')
    expect(miss.matched).toBe(0)
    expect(miss.groups).toEqual([])
  })

  it('文本过滤：path 子串同样命中；两维 AND 正交叠加', () => {
    expect(filterProblemGroups(sampleGroups(), 'a.ts', null).matched).toBe(2)
    expect(filterProblemGroups(sampleGroups(), 'style', null).matched).toBe(1)
    // AND：路径命中 a.ts（2 条）∩ 仅错误（1 条）= 1 条
    const both = filterProblemGroups(sampleGroups(), 'a.ts', 'error')
    expect(both.matched).toBe(1)
    expect(both.groups[0]!.items[0]!.severity).toBe('error')
  })

  it('组序与组内序沿用聚合产出，不因过滤重排', () => {
    const r = filterProblemGroups(sampleGroups(), '', 'warning')
    expect(r.groups[0]!.items[0]!.line).toBe(7)
    expect(r.groups[1]!.items[0]!.line).toBe(2)
  })
})

describe('pickDiagnosticMarker 多诊断叠加行动作归属（P-20261006-2）', () => {
  const mk = (line: number, col: number, endLine = line, endCol = col, message = `m${col}`) => ({
    startLineNumber: line, startColumn: col, endLineNumber: endLine, endColumn: endCol, message,
  })

  it('第一档：精确同区间（marker hover「Quick Fix...」以被悬停 marker 自身区间触发）', () => {
    const a = mk(1, 24, 1, 40)
    const b = mk(1, 1, 1, 10)
    expect(pickDiagnosticMarker([b, a], mk(1, 24, 1, 40))).toBe(a)
  })

  it('第二档：包含请求起点（光标落在波浪线内，含起止单字符边界）', () => {
    const a = mk(1, 24, 1, 40)
    expect(pickDiagnosticMarker([a], mk(1, 30, 1, 30))).toBe(a)
    expect(pickDiagnosticMarker([a], mk(1, 24, 1, 24))).toBe(a)
    expect(pickDiagnosticMarker([a], mk(1, 40, 1, 40))).toBe(a)
  })

  it('第三档：区间相交（拖选横跨多条诊断取首条）', () => {
    const a = mk(1, 5, 1, 10)
    const b = mk(1, 20, 1, 30)
    expect(pickDiagnosticMarker([a, b], mk(1, 8, 1, 25))).toBe(a)
  })

  it('跨行区间与同文件无诊断处：包含与相交均不中返回 null（无诊断处不出入口）', () => {
    const multi = mk(2, 5, 5, 10)
    expect(pickDiagnosticMarker([multi], mk(3, 7, 3, 7))).toBe(multi)
    expect(pickDiagnosticMarker([multi], mk(1, 1, 1, 1))).toBeNull()
    expect(pickDiagnosticMarker([mk(1, 5, 1, 10)], mk(1, 12, 1, 12))).toBeNull()
    expect(pickDiagnosticMarker([], mk(1, 1, 1, 1))).toBeNull()
  })
})
