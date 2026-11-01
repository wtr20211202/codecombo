/**
 * 文件树同名族嵌套显示（P-20261006-21）——VS Code explorer.fileNesting 惯例的树降噪。
 *
 * 组件化项目同名族常见（foo.vue + foo.test.ts + foo.css / index.ts + index.spec.ts），
 * 平铺占树高度；本模块把「子文件归属主文件」做成纯函数归组，供 FileTreeView 在
 * 渲染面折叠/展开。纯渲染组织层：文件清单 API、目录结构面（files 数组与目录展开）
 * 都不动，agent 与搜索看到的仍是全量平铺。
 *
 * 语义约定（与任务书四族一一对应）：
 *  - 测试/样式/声明族：子文件名命中 NESTING_CHILD_RULES → 折叠进同目录同基名的主文件；
 *  - 同基名其他扩展族：同目录同基名的「可作主文件」≥2 个时，扩展名优先级次位折叠进首位；
 *  - 主文件资格：不再命中任何子规则、且扩展名在 NESTING_MAIN_EXT_PRIORITY 表内
 *    （README.md / 纯点文件等永不参与竞争，避免误折叠）；
 *  - 单层嵌套（VS Code 同惯例）：已作子文件的条目不再收纳自己的子文件。
 */

/** 树条目的归组所需最小结构（FileEntry 结构兼容，避免 utils 反向依赖 composables） */
export interface NestEntry {
  name: string
  path: string
  isDir: boolean
}

/**
 * 嵌套模式表（任务书⑤：常量表便于增补）。pattern 带一个捕获组 = 基名
 * （子文件名剥掉特征后缀后剩下的部分，如 foo.test.ts → foo）。增补新族只需
 * 追加一条 { id, pattern }，主文件资格与展开交互自动跟随。
 */
export interface NestingRule {
  id: string
  pattern: RegExp
}

export const NESTING_CHILD_RULES: readonly NestingRule[] = [
  // 测试族：foo.test.ts / foo.spec.ts（ts/js/tsx/jsx 及 cjs/mjs 变体）
  { id: 'test', pattern: /^(.+)\.(?:test|spec)\.[cm]?[jt]sx?$/i },
  // 样式族：foo.css / foo.scss（组件同名样式）
  { id: 'style', pattern: /^(.+)\.(?:css|scss)$/i },
  // 声明族：foo.d.ts / foo.d.mts / foo.d.cts
  { id: 'dts', pattern: /^(.+)\.d\.[cm]?ts$/i },
]

/**
 * 同基名族的主文件扩展名优先级（越前越主）：index.ts + index.js → js 折叠进 ts。
 * 不在表内的扩展名不参与主/子竞争（保守：html+ts、md+ts 等组合保持平铺）。
 */
export const NESTING_MAIN_EXT_PRIORITY: readonly string[] = [
  '.vue', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
]

/** 命中子规则则返回 { base }，否则 null。规则序即优先序（首条命中即用）。 */
export function matchChildRule(name: string): { rule: NestingRule; base: string } | null {
  for (const rule of NESTING_CHILD_RULES) {
    const m = rule.pattern.exec(name)
    if (m && m[1]) return { rule, base: m[1] }
  }
  return null
}

/** 扩展名优先级（不可竞争返回 -1）；取尾段（foo.d.ts 的尾段是 .ts，本身是子文件不参与） */
function mainExtRank(name: string): number {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return -1 // 无点或点文件（.env）——排除
  return NESTING_MAIN_EXT_PRIORITY.indexOf(lower.slice(dot))
}

export interface NestGrouping {
  /** 子文件 path → 主文件 path（单层：主文件自身不是任何条目的子文件） */
  childToMain: Map<string, string>
  /** 主文件 path → 直接子文件条目（保持平铺原序，供展开时按序插入） */
  mainToChildren: Map<string, NestEntry[]>
}

function parentDirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function baseKeyOf(name: string, childBase: string | null): string {
  if (childBase !== null) return childBase
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

/**
 * 对一层平铺清单做同名族归组。组键 = 父目录 + 基名（目录内邻居才能成族，
 * \u0000 分隔防「a/b + c」与「a + b/c」拼 key 歧义）。
 * 量级考量：单趟分桶 O(n) + 每桶内小规模排序（桶 = 同基名兄弟，个位数），
 * 只在清单/开关变化时重算（computed 缓存），虚拟列表切片渲染不感知。
 */
export function buildNestGroups(entries: NestEntry[]): NestGrouping {
  const childToMain = new Map<string, string>()
  const mainToChildren = new Map<string, NestEntry[]>()

  interface Bucket { mains: NestEntry[]; children: NestEntry[] }
  const buckets = new Map<string, Bucket>()
  const bucketOf = (key: string): Bucket => {
    let b = buckets.get(key)
    if (!b) { b = { mains: [], children: [] }; buckets.set(key, b) }
    return b
  }

  for (const e of entries) {
    if (e.isDir) continue
    const m = matchChildRule(e.name)
    const key = parentDirOf(e.path) + '\u0000' + baseKeyOf(e.name, m ? m.base : null)
    const b = bucketOf(key)
    if (m) b.children.push(e)
    else if (mainExtRank(e.name) >= 0) b.mains.push(e)
    // 两边都不占（如 README.md）：不入桶，永不折叠也不收纳
  }

  /** 桶内主文件 = 扩展名优先级最高者（并列保平铺序） */
  const topMain = (mains: NestEntry[]): NestEntry | null => {
    let best: NestEntry | null = null
    let bestRank = Number.MAX_SAFE_INTEGER
    for (const m of mains) {
      const r = mainExtRank(m.name)
      if (r < bestRank) { best = m; bestRank = r }
    }
    return best
  }

  for (const b of buckets.values()) {
    const main = topMain(b.mains)
    if (!main) continue
    // 测试/样式/声明族子文件 → 主文件
    for (const c of b.children) childToMain.set(c.path, main.path)
    // 同基名其他扩展族：其余候选主文件折叠进首位（单层——子文件不再收纳）
    for (const m of b.mains) {
      if (m.path !== main.path) childToMain.set(m.path, main.path)
    }
  }

  for (const e of entries) {
    const main = childToMain.get(e.path)
    if (!main) continue
    let kids = mainToChildren.get(main)
    if (!kids) { kids = []; mainToChildren.set(main, kids) }
    kids.push(e)
  }
  return { childToMain, mainToChildren }
}

/**
 * 按归组 + 展开态产出展示行：折叠族的子行不单独出现，展开的主行在自身之后
 * 按平铺原序插入子行（虚拟列表行数变化天然支持——固定行高不变）。
 * 注意子行不按平铺位出现（Card.css 字母序可能排在 Card.vue 前），只随主行展开插入。
 */
export function applyNestGroups<T extends NestEntry>(
  entries: T[],
  g: NestGrouping,
  expanded: ReadonlySet<string>,
): T[] {
  const out: T[] = []
  for (const e of entries) {
    if (g.childToMain.has(e.path)) continue // 子行只随主行展开插入
    out.push(e)
    const kids = g.mainToChildren.get(e.path)
    if (kids && expanded.has(e.path)) out.push(...(kids as T[]))
  }
  return out
}
