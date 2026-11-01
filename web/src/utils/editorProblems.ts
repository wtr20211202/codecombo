// 编辑器诊断聚合（P-20261003-297「问题面板」）纯函数层
//
// monaco.editor.getModelMarkers({}) 的全量 markers → 按文件分组 + 严重级排序
// （error 先）的条目树。刻意不 import monaco-editor：本文件被 StatusBar（主包）
// 与 ProblemsPanel（底栏 chunk）共同引用，monaco 命名空间经结构化类型传入，
// 编辑器 chunk 的懒加载约束不被破坏（markers 数据源在 useEditorProblems 接线）。
//
// 量级：markers 数 = 打开文件数 × 诊断数（编辑器场景 < 数千），全量重算
// + 列表直渲染即可，无需虚拟化/增量 diff。

/** monaco.MarkerSeverity 数值（与 monaco-editor 常量同值，避免引入依赖） */
export const MARKER_SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const

export type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint'

/** 单条诊断条目（路径已归一为项目相对正斜杠路径） */
export interface ProblemItem {
  path: string
  line: number
  col: number
  severity: ProblemSeverity
  message: string
  /** 诊断来源（如 'ts'），缺省不展示 */
  source?: string
  /** marker 归属方（如 ts.worker 设的 'typescript'；source 缺省时的来源兜底） */
  owner?: string
  /** 稳定错误码（字符串化透传；对象形态取 value），供「问智能体」结构化载荷 */
  code?: string
}

/** 按文件分组的条目组（组内已按严重级/行列排序） */
export interface ProblemFileGroup {
  path: string
  items: ProblemItem[]
}

export interface ProblemAggregate {
  groups: ProblemFileGroup[]
  errorCount: number
  warningCount: number
  infoCount: number
  total: number
}

/** 聚合输入的结构化最小形态（兼容 monaco.editor.IMarker + URI），
 *  单测可构造纯对象，不必拉起 monaco */
export interface RawProblemMarker {
  resource: { path: string; scheme?: string }
  startLineNumber: number
  startColumn: number
  /** monaco.MarkerSeverity 数值 */
  severity: number
  message: string
  source?: string
  owner?: string
  /** monaco IMarkerData.code 原始形态（字符串或 { value, target } 链接对象） */
  code?: string | { value: string }
}

/** marker code 字段字符串化：对象形态（带文档链接）取 value，空串归一为
 *  undefined——载荷面只关心可编程引用的码值本身 */
export function normalizeDiagnosticCode(code: string | { value: string } | undefined): string | undefined {
  if (typeof code === 'string') return code || undefined
  if (code && typeof code === 'object' && code.value) return code.value
  return undefined
}

/** 诊断来源的生效值：marker.source（语言服务显式声明的，如 eslint）优先，
 *  缺省回落 owner（marker 写入方，如 ts.worker 的 'typescript'）——两者都缺
 *  才视为无来源 */
export function diagnosticSourceOf(m: { source?: string; owner?: string }): string | undefined {
  return m.source || m.owner || undefined
}

/** 来源+错误码的人读组合文本（Monaco marker hover 的同款渲染式：
 *  `source(code)` / `source` / `(code)`，全缺省空串——prompt 组装端据此
 *  选带来源/无来源两套模板，不产悬空括号伪影） */
export function diagnosticOriginText(source: string | undefined, code: string | undefined): string {
  if (source && code) return `${source}(${code})`
  if (source) return source
  if (code) return `(${code})`
  return ''
}

function severityOf(n: number): ProblemSeverity {
  if (n >= MARKER_SEVERITY.Error) return 'error'
  if (n >= MARKER_SEVERITY.Warning) return 'warning'
  if (n >= MARKER_SEVERITY.Info) return 'info'
  return 'hint'
}

const SEVERITY_ORDER: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 }

/** 模型 URI → 项目相对路径：编辑器侧模型以 `file:///${相对路径}` 构造
 *  （MonacoEditor.vue 同约定），URI.path 形如 `/src/foo.ts`，剥掉首段斜杠。
 *  非预期形态（无 path / 非文件协议派生）原样返回，交给上层按路径展示 */
export function markerResourcePath(resource: { path?: string }): string {
  const p = resource.path || ''
  return p.startsWith('/') ? p.slice(1) : p
}

/** 全量 markers → 分组聚合。排序：严重级（error 先）→ 路径 → 行列，
 *  同文件条目天然相邻；文件组按其组内最高严重级排，error 文件靠前。
 *  scheme 非 file 的模型（DiffEditor 匿名 `inmemory://` 等）不入列——
 *  其 path 无项目语义，混入会成幽灵分组 */
export function aggregateProblems(markers: RawProblemMarker[]): ProblemAggregate {
  const items: ProblemItem[] = markers
    .filter((m) => m.resource.scheme === undefined || m.resource.scheme === 'file')
    .map((m) => ({
      path: markerResourcePath(m.resource),
      line: m.startLineNumber,
      col: m.startColumn,
      severity: severityOf(m.severity),
      message: m.message,
      source: m.source,
      owner: m.owner,
      code: normalizeDiagnosticCode(m.code),
    }))
  items.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.path.localeCompare(b.path)
    || a.line - b.line
    || a.col - b.col)

  const groups: ProblemFileGroup[] = []
  const byPath = new Map<string, ProblemFileGroup>()
  const agg: ProblemAggregate = { groups, errorCount: 0, warningCount: 0, infoCount: 0, total: items.length }
  for (const it of items) {
    if (it.severity === 'error') agg.errorCount++
    else if (it.severity === 'warning') agg.warningCount++
    else agg.infoCount++
    let g = byPath.get(it.path)
    if (!g) {
      g = { path: it.path, items: [] }
      byPath.set(it.path, g)
      groups.push(g)
    }
    g.items.push(it)
  }
  return agg
}

// ── 显示层过滤（P-20261005-171「问题面板严重级过滤」）──
//
// 只作用于面板列表显示：aggregate 本体是 StatusBar 徽标与面板摘要共享的
// 全量口径（徽标答「有多少」、过滤答「找哪个」，互不越界），故过滤是
// aggregate 之后的一次纯裁剪，绝不回写。

/** 严重级过滤作用域：null = 不过滤；'error'/'warning' = 仅看该级
 *  （二态 chip，激活其一即排除其余级别，再点回落 null） */
export type ProblemSeverityScope = 'error' | 'warning' | null

/** 过滤分组树：文本子串（message/path 命中其一即可，大小写不敏感——
 *  toLowerCase 对 CJK 是恒等变换，无区域陷阱）AND 严重级 chip，两维正交
 *  叠加。条目全被滤掉的文件组整组剔除（空组壳没意义）；组序与组内序沿用
 *  aggregateProblems 的产出，不重排。matched = 过滤后条目总数（头部 n/全量
 *  计数用）。量级：O(条目数) 每次过滤输入变化重跑一次，编辑器场景 < 数千，
 *  无 memo 必要。入参取结构化只读形（消费方是 useEditorProblems 的
 *  readonly(state) 深只读代理，ProblemFileGroup 的可变 items 形不兼容），
 *  输出恒为新建可变结构 */
export function filterProblemGroups(
  groups: readonly { readonly path: string; readonly items: readonly ProblemItem[] }[],
  text: string,
  severity: ProblemSeverityScope,
): { groups: ProblemFileGroup[]; matched: number } {
  const needle = text.trim().toLowerCase()
  const out: ProblemFileGroup[] = []
  let matched = 0
  for (const g of groups) {
    const items = g.items.filter((it) =>
      (severity === null || it.severity === severity)
      && (needle === ''
        || it.message.toLowerCase().includes(needle)
        || it.path.toLowerCase().includes(needle)))
    if (items.length === 0) continue
    out.push({ path: g.path, items })
    matched += items.length
  }
  return { groups: out, matched }
}

// ── 诊断「问智能体」的 marker 归属裁决（P-20261006-2）──
//
// monaco 0.55.1 的 provideCodeActions 只回传 { only, trigger }，context.markers
// 不填充（esm/vs/editor/contrib/codeAction/browser/codeAction.js getCodeActions
// 构造处实测）——provider 需对 getModelMarkers({ resource }) 自取全量 markers，
// 与触发请求的 range 求归属。三档优先序：hover「Quick Fix...」路径以被悬停
// marker 自身区间触发（精确同区间）> 光标/选区起点落在波浪线内 > 区间相交；
// 全不中返回 null = 无诊断处不出入口（天然门槛，不越权代答同文件其他诊断）。

export interface DiagnosticRangeLike {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

function markerContainsPosition(m: DiagnosticRangeLike, line: number, col: number): boolean {
  if (line < m.startLineNumber || line > m.endLineNumber) return false
  if (line === m.startLineNumber && col < m.startColumn) return false
  if (line === m.endLineNumber && col > m.endColumn) return false
  return true
}

function markerIntersectsRange(m: DiagnosticRangeLike, r: DiagnosticRangeLike): boolean {
  const aBefore = m.endLineNumber < r.startLineNumber
    || (m.endLineNumber === r.startLineNumber && m.endColumn < r.startColumn)
  const bBefore = r.endLineNumber < m.startLineNumber
    || (r.endLineNumber === m.startLineNumber && r.endColumn < m.startColumn)
  return !aBefore && !bBefore
}

/** 多诊断叠加行的动作归属（取当前 hover/光标所在 marker，见上注） */
export function pickDiagnosticMarker<T extends DiagnosticRangeLike>(
  markers: readonly T[],
  range: DiagnosticRangeLike,
): T | null {
  for (const m of markers) {
    if (m.startLineNumber === range.startLineNumber && m.startColumn === range.startColumn
      && m.endLineNumber === range.endLineNumber && m.endColumn === range.endColumn) return m
  }
  for (const m of markers) {
    if (markerContainsPosition(m, range.startLineNumber, range.startColumn)) return m
  }
  for (const m of markers) {
    if (markerIntersectsRange(m, range)) return m
  }
  return null
}
