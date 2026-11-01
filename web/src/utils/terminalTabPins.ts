/**
 * 终端会话 tab 置顶（P-20261004-53）纯函数：置顶集的持久化形态防御与
 * 「置顶分组」显示序投影。置顶状态（会话 id 集合）归属 terminal-sessions
 * store（safeStorage 持久化、会话消亡即剪枝），本模块不持状态。
 *
 * 与编辑器 pinned tab（openfiles/tabs.ts 物理搬移到组首）的口径差异：终端
 * tabs 数组跨项目共享且被快照对账/拖拽重排持续写，置顶序走纯显示层投影——
 * 不动物理数组，对账/拖拽零干扰，取消置顶即回原相对位。
 */

/** 恢复持久化置顶集：形态防御——非 JSON/非数组/含非字符串项整体丢弃
 *  （损坏回落空集，不抛错不让脏数据进显示序） */
export function parsePinnedIds(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

/** 置顶分组显示序：置顶稳定 partition 到队首（置顶组内、未置顶组内各保持
 *  原相对序）。空集原数组拷贝返回；O(n) 两遍扫描无排序（tabs 变化即重算的
 *  投影路径，量级 = 当前项目会话数，几十封顶） */
export function pinnedFirstOrder<T extends { id: string }>(list: readonly T[], pinned: ReadonlySet<string>): T[] {
  if (pinned.size === 0) return [...list]
  const head: T[] = []
  const tail: T[] = []
  for (const t of list) (pinned.has(t.id) ? head : tail).push(t)
  return head.length > 0 ? [...head, ...tail] : tail
}
