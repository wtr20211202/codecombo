/**
 * 人类深链与呈现原语的前端消费面（P-20261022-3）：与
 * server/agentops/capabilities.go 原子能力注册表（手册/人类深链表/防御性路由
 * 别名的单一事实源）对偶——深链参数集、视图枚举、别名收口规则在此收口为
 * 纯函数 + 常量，双侧字段增删由镜像单测读
 * server/agentops/testdata/present-atoms.json 对账（漂移即红）。
 *
 * 纯函数零依赖（vue-router query 值以 unknown 形态出入），供三处消费：
 * - useLayoutViews.consumeFileQuery（深链消费防呆收口，行为与原内联版逐字等价）
 * - router /project/:id/files 别名重定向（query 换算）
 * - useFileDeepLink「复制文件链接」（产出侧与消费侧同参同形）
 */

/** 文件深链 query 参数全集（快照 deepLinks[file].params 同序——字典序） */
export const FILE_DEEPLINK_PARAMS = ['col', 'diff', 'file', 'line', 'project'] as const

/** 主区视图深链取值域（快照 deepLinks[view].viewValues 同序——字典序；
 * 消费在 useLayoutViews.consumeViewQuery） */
export const VIEW_DEEPLINK_VIEWS = ['dashboard', 'remote', 'shares'] as const

/** 文件深链目标（parseFileDeepLinkQuery 产出形态 = useLayoutViews 消费形态） */
export interface FileDeepLinkTarget {
  file: string
  project: string
  line?: number
  col?: number
  diff?: boolean
}

/** 深链 line/col 查询参数防呆：仅接受 ≥1 整数，其余形态（缺省/非数值/数组
 * 重复参）一律忽略按无行打开；越界行号（超出文件行数）由行定位轮询的
 * 「超时停在顶部」兜底 */
function numParam(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 ? n : undefined
}

/**
 * 解析文件深链 query（useLayoutViews.consumeFileQuery 委托本函数）：
 * file 必填非空字符串（否则 null = 非深链，调用方早退）；project 缺省空串
 * （= 当前项目）；line/col 过 numParam；diff 仅认 '1'。行为与原
 * useLayoutViews 内联版逐字等价（P-20261002-49 深链语义零变化）。
 * 未声明的 query 参数原样忽略（file/line/col 等之外的键不参与解析，与
 * present-atoms 快照 params 全集对账）
 */
export function parseFileDeepLinkQuery(query: Record<string, unknown>): FileDeepLinkTarget | null {
  const file = query.file
  if (typeof file !== 'string' || !file) return null
  return {
    file,
    project: typeof query.project === 'string' ? query.project : '',
    line: numParam(query.line),
    col: numParam(query.col),
    diff: query.diff === '1',
  }
}

/**
 * 拼文件深链 query 对象（产出侧：useFileDeepLink 复制链接、agent navigate
 * {file} 形态的落链等）——与 parseFileDeepLinkQuery 消费同参同形（双向锁死）。
 * project 空串不携带（消费侧空串语义 = 当前项目）；line/col 缺省不携带；
 * diff 携带 '1'
 */
export function buildFileDeepLinkQuery(target: Omit<FileDeepLinkTarget, 'project'> & { project?: string }): Record<string, string> {
  const query: Record<string, string> = { file: target.file }
  if (target.project) query.project = target.project
  if (target.line !== undefined) query.line = String(target.line)
  if (target.col !== undefined) query.col = String(target.col)
  if (target.diff) query.diff = '1'
  return query
}

/**
 * 防御性路由别名 `/project/:id/files` 的 query 换算（P-20261022-3）：agent
 * 编造的「自然形态」深链（path 参数指文件）收口为正确文件深链——
 * `?path=X&line=N&col=M` → `?file=X&project=<id>&line=N&col=M`。
 * 只读重定向幂等安全；仅此一条别名，不做泛化别名面（防别名面膨胀）。
 * 纯函数供 router redirect 与镜像单测直调
 */
export function projectFilesAliasRedirect(
  params: Record<string, string | string[]>,
  query: Record<string, unknown>,
): { path: string; query: Record<string, string> } {
  const file = typeof query.path === 'string' ? query.path : ''
  // 无 path 参数的编造形态：不带 query 落项目页（file 空串在消费侧本就早退，
  // 这里直接产出干净 URL 免得 ?file= 尾巴留在地址栏）
  if (!file) return { path: '/project', query: {} }
  const out = buildFileDeepLinkQuery({
    file,
    project: typeof params.id === 'string' ? params.id : '',
    line: numParam(query.line),
    col: numParam(query.col),
  })
  return { path: '/project', query: out }
}
