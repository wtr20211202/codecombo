/**
 * 会话中心按 runtime 分组投影（P-20261003-238）：把系统会话列表按 runtime
 * 注册名归组，供侧栏分组视图渲染组头（标签 + 计数）与组内行。纯展示层投影
 * ——不动分组持久化数据（自定义分组/项目树是另一维度，平铺视图照旧）。
 *
 * 归组键：runtime 注册名，空值归 'shell'——runtime 缺失的会话（旧版本创建、
 * meta 未落库、项目会话）底层交互面都是 shell，分组是浏览辅助不是归因断言
 * （「这条会话由谁跑的」的归因面是行 tooltip 的 RuntimeVersion，P-20261003-134）。
 *
 * 组序：内置智能体运行时（claude/codex/dsh）固定在前，其后自定义/未登记运行时
 * 按首现顺序（清单来自会话列表，宿主已按排序模式排好），shell 殿后——「按类
 * 浏览」的主体是智能体会话，纯终端是兜底类。组内顺序 = 传入顺序（排序语义
 * 归 sortMode，本函数不二次排序）。
 */

/** 归组输入的最小结构面（AgentTermSession 等会话形态均满足，零依赖引入） */
export interface RuntimeGroupSession {
  id: string
  name: string
  /** runtime 注册名；空 = 旧会话/项目会话（归 shell 组） */
  runtime?: string
}

/** 分组投影结果：key = 归组键（归一化后），sessions 保持传入顺序（元素类型随入参） */
export interface RuntimeSessionGroup<T extends RuntimeGroupSession = RuntimeGroupSession> {
  key: string
  sessions: T[]
}

/** 空值归一的兜底组键（shell 是一等纯终端选项，不是「未知」占位） */
export const RUNTIME_FALLBACK_KEY = 'shell'

/** 内置智能体运行时的固定组序（providers_builtin.go 注册面同源；shell 殿后） */
const KNOWN_AGENT_RUNTIMES = ['claude', 'codex', 'dsh'] as const

export function groupSessionsByRuntime<T extends RuntimeGroupSession>(sessions: T[]): RuntimeSessionGroup<T>[] {
  const byKey = new Map<string, T[]>()
  for (const s of sessions) {
    const key = s.runtime || RUNTIME_FALLBACK_KEY
    const list = byKey.get(key)
    if (list) list.push(s)
    else byKey.set(key, [s])
  }
  // 组序装配：内置智能体运行时在前（有成员才占组），自定义按首现，shell 殿后
  const out: RuntimeSessionGroup<T>[] = []
  const seen = new Set<string>()
  const push = (key: string) => {
    const list = byKey.get(key)
    if (!list || seen.has(key)) return
    seen.add(key)
    out.push({ key, sessions: list })
  }
  for (const key of KNOWN_AGENT_RUNTIMES) push(key)
  for (const key of byKey.keys()) {
    if (key !== RUNTIME_FALLBACK_KEY) push(key)
  }
  push(RUNTIME_FALLBACK_KEY)
  return out
}

// ============== runtime 筛选芯片（P-20261004-84） ==============
// 与上方分组投影共用同一键空间（归组键/组序/空值归一），芯片清单与命中判定
// 不另立口径——「分组视图组头」与「筛选芯片」是同一 runtime 维度的两种呈现，
// 分叉即漂移（防三处漂移纪律：侧栏筛选区/分组视图/未来宿主全走本文件纯函数）。

/** 芯片候选清单：当前会话集合出现的 runtime 去重，序沿分组投影（内置在前/
 *  自定义首现/shell 殿后）。无成员的 runtime 不产芯片（动态清单），调用方
 *  传全量会话集合而非过滤后集合——过滤态收窄芯片会把「退出筛选的路」收走 */
export function runtimeFilterOptions<T extends RuntimeGroupSession>(sessions: T[]): string[] {
  return groupSessionsByRuntime(sessions).map(g => g.key)
}

/** 筛选命中判定：选中集为空 = 不过滤恒真；多选 OR 语义（命中任一选中
 *  runtime）。会话 runtime 空值归一 shell——与分组投影同款兜底（项目会话/
 *  旧会话都是 shell 交互面），调用方对无 runtime 字段的会话形态（如项目
 *  分组条目）直接传 undefined 即可，不必自行补键 */
export function sessionMatchesRuntimeFilter(runtime: string | undefined, selected: ReadonlySet<string>): boolean {
  if (selected.size === 0) return true
  return selected.has(runtime || RUNTIME_FALLBACK_KEY)
}
