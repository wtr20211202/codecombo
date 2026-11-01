/**
 * 会话回放深链（P-20261003-154）：/project?session=<id>&turn=<N> 让「看那个
 * 会话的第 47 轮结论」可链接表达——?file= 文件深链（P-20261002-49）的会话域扩展。
 *
 * URL 约定（复制端 SessionTimeline.copyTurnLink 与消费端 useSessionReplayDeepLink
 * 共用本模块单一事实源）：
 *   /project?project=<pid>&session=<claude 会话 id>&turn=<N>
 * - turn 从 1 计（第 N 个时间线条目）——与文件深链 line=N 的「从 1 计」位号
 *   语义一致，人话「第 47 轮」即 turn=47；消费端换算 0-based 索引喂 P-132
 *   进度条同款定位（jumpToIndex 内含越界钳到尾条：链接生成后会话被「加载更多
 *   窗口」收缩/截断时保底仍能打开，停在最后可及条目）
 * - project 可选（会话归属项目上下文定位，?file= 深链同语义）：消费端先切项目
 *   再开回放。会话时间线按 id 全局可寻址，项目缺失/已删除不拦截打开——与
 *   ?file= 的「整条放弃」刻意不同：文件路径相对项目根，落错项目会读到同名
 *   异实文件；会话 id 无此歧义面，项目切换只是上下文对齐
 */

/** cwd 归一化比较（cwd → 归属项目反查的兜底 pass）：分隔符统一 + 去尾分隔符 +
 * 小写。自 useApprovalActions 同名私有函数收编为本模块单一事实源——两处
 * （审批回放目标桥接 / 此轮链接归属项目反查）语义必须同演化 */
export function normCwd(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 深链 turn 查询参数：仅接受 ≥1 整数，其余形态（缺省/非数值/小数/数组重复参）
 * 一律忽略按「只开会话不定位」消费；越界（超出时间线总条数）不在此拒——由
 * jumpToIndex 钳到尾条兜底（见模块头注释）。与 utils/presentAtoms 的深链
 * line/col 防呆（parseFileDeepLinkQuery 内 numParam）同守卫口径 */
export function turnParam(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 ? n : undefined
}

/** 拼「此轮链接」：origin + /project 深链（参数序 project → session → turn，
 * 与 ?file= 深链的 project → file 同款：定位域参数在前、位置参数在后）。
 * projectId/turn 缺省时省略对应参数——turn 缺省 = 只开会话回放不定位 */
export function buildSessionDeepLinkUrl(
  origin: string,
  opts: { sessionId: string; turn?: number; projectId?: string },
): string {
  let link = `${origin}/project?session=${encodeURIComponent(opts.sessionId)}`
  if (opts.projectId) link += `&project=${encodeURIComponent(opts.projectId)}`
  if (opts.turn !== undefined) link += `&turn=${opts.turn}`
  return link
}

/** 会话 cwd → 归属项目 id 反查（复制「此轮链接」时携带 project 参数用）：
 * 先精确匹配，落空走 normCwd 归一化兜底（win 反斜杠/尾分隔符/大小写差异，
 * useApprovalActions.resolveReplayTarget 两 pass 同语义）。不归属任何项目
 * 返回空串——调用方省略 project 参数，深链仍完整可用（会话 id 全局可寻址） */
export function projectIdForCwd(
  projects: ReadonlyArray<{ id: string; path: string }>,
  cwd: string,
): string {
  if (!cwd) return ''
  const exact = projects.find(p => p.path === cwd)
  if (exact) return exact.id
  const norm = normCwd(cwd)
  return projects.find(p => normCwd(p.path) === norm)?.id ?? ''
}
