import { safeStorage } from './storage'

// 命令面板 usage 记录（P-20261002-107）：执行命令即计数，safeStorage 持久化
// （localStorage 被隐私模式屏蔽时降级内存兜底，与会内其他存储一致不阻断）。
// frecency 排序（P-20261005-200）：最近窗口档优先 + 次数权重——空查询置顶组
// 与查询路径模糊分序的同权重破平均走 compareCmdFrecency；键数封顶防无限膨胀、
// 条目超 TTL 过期清理（与 useWorkspaceSnapshot 的封顶先例同思路）

export interface CmdUsageEntry { count: number; lastAt: number }
export type CmdUsageMap = Record<string, CmdUsageEntry>

export const CMD_USAGE_STORAGE_KEY = 'sc.palette.commandUsage'
// 旧「最近命令」键（MRU id 数组，P-20261002-107 之前）：一次性迁移为
// count=1 的 usage 条目后移除，老用户的置顶组不因升级清零
export const LEGACY_RECENT_STORAGE_KEY = 'sc.palette.recentCommands'

/** 键数上限：LRU——超出时淘汰 lastAt 最小（最久未用）的键 */
export const CMD_USAGE_MAX_KEYS = 50

// ---- frecency 窗口（P-20261005-200）----
// 档位是粗粒度窗口而非时间戳线性序：同档内仍按 count 权重排（24h 内的高频
// 命令不会被偶发的最近一次使用挤掉），跨档才由「最近窗口优先」接管
/** 热档：24h 内用过 */
export const FRECENCY_HOT_MS = 24 * 60 * 60 * 1000
/** 温档：7 天内用过 */
export const FRECENCY_WARM_MS = 7 * 24 * 60 * 60 * 1000
/** 过期窗：超过即视为失效偏好，load 期清理（置顶组不被月前旧习惯占据） */
export const CMD_USAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 最近窗口档位：2=热（24h 内）1=温（7 天内）0=冷（更久/无记录） */
export function recencyTier(lastAt: number, now: number): number {
  const age = now - lastAt
  if (age <= FRECENCY_HOT_MS) return 2
  if (age <= FRECENCY_WARM_MS) return 1
  return 0
}

/** frecency 降序比较器（Array.sort 用：负值 = a 排前）：最近窗口档 → 次数 →
 *  lastAt 逐级破平。无记录条目按零使用（0 档）参与比较——查询路径里模糊分
 *  同分的命令先落用过的，零使用命令互相之间同权重，稳定排序回落静态注册序 */
export function compareCmdFrecency(
  a: CmdUsageEntry | undefined,
  b: CmdUsageEntry | undefined,
  now: number,
): number {
  const ta = a ? recencyTier(a.lastAt, now) : 0
  const tb = b ? recencyTier(b.lastAt, now) : 0
  return tb - ta || (b?.count ?? 0) - (a?.count ?? 0) || (b?.lastAt ?? 0) - (a?.lastAt ?? 0)
}

function parseUsage(raw: string | null): CmdUsageMap {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: CmdUsageMap = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<CmdUsageEntry> | null
      if (e && typeof e.count === 'number' && Number.isFinite(e.count) && e.count > 0
        && typeof e.lastAt === 'number' && Number.isFinite(e.lastAt)) {
        out[id] = { count: e.count, lastAt: e.lastAt }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 读取 usage map；损坏条目逐条丢弃，超 TTL 的过期条目按失效偏好丢弃（P-200
 *  ④「过期窗」——只丢陈旧数据不转换格式，读路径幂等，旧版本写入的存量完全
 *  可读）。新键无数据时迁移旧「最近命令」数组（越靠前越新 → lastAt 递减），
 *  保证升级后首次打开置顶组即为原最近序 */
export function loadCmdUsage(now = Date.now()): CmdUsageMap {
  const stored = parseUsage(safeStorage.getItem(CMD_USAGE_STORAGE_KEY))
  const usage: CmdUsageMap = {}
  for (const [id, e] of Object.entries(stored)) {
    if (now - e.lastAt <= CMD_USAGE_TTL_MS) usage[id] = e
  }
  const legacy = parseLegacyIds()
  if (legacy.length > 0) {
    if (Object.keys(usage).length === 0) {
      legacy.forEach((id, i) => { usage[id] = { count: 1, lastAt: now - i } })
      saveCmdUsage(usage)
    }
    safeStorage.removeItem(LEGACY_RECENT_STORAGE_KEY)
  }
  return usage
}

function parseLegacyIds(): string[] {
  try {
    const raw = safeStorage.getItem(LEGACY_RECENT_STORAGE_KEY)
    const arr = raw ? JSON.parse(raw) : null
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function saveCmdUsage(usage: CmdUsageMap): void {
  safeStorage.setItem(CMD_USAGE_STORAGE_KEY, JSON.stringify(usage))
}

/** 记一次执行：count+1、lastAt 刷新（纯函数，返回新 map）。
 *  新键使总数超上限时按 LRU 淘汰最久未用键——已存在键只刷新 lastAt，
 *  高频命令不会被挤出。maxKeys 供文件层（P-20261005-222）放宽上限复用 */
export function recordCmdUsage(
  usage: CmdUsageMap, id: string, now = Date.now(), maxKeys = CMD_USAGE_MAX_KEYS,
): CmdUsageMap {
  const prev = usage[id]
  if (prev) return { ...usage, [id]: { count: prev.count + 1, lastAt: now } }
  const next: CmdUsageMap = { ...usage, [id]: { count: 1, lastAt: now } }
  if (Object.keys(next).length > maxKeys) {
    let victim = ''
    let oldest = Infinity
    for (const [k, e] of Object.entries(next)) {
      if (e.lastAt < oldest) {
        oldest = e.lastAt
        victim = k
      }
    }
    delete next[victim]
  }
  return next
}

/** frecency 最高的前 N 个命令 id：最近窗口档优先、次数权重、lastAt 破平
 *  （均为降序，见 compareCmdFrecency） */
export function topFrequentCmdIds(usage: CmdUsageMap, n: number, now = Date.now()): string[] {
  return Object.entries(usage)
    .sort(([, a], [, b]) => compareCmdFrecency(a, b, now))
    .slice(0, n)
    .map(([id]) => id)
}

// ---- 文件层 frecency（P-20261005-222）----
// Quick Open 文件层与命令层同机制不同数据面：打开成功即计数，读侧做同分带
// 破平与空查询置顶段。与命令层分存储键防两层互踩；条目键 = `${projectId}:${path}`
// （projectId 为服务端 uuid 不含冒号，首冒号切分即得作用域；path 为项目相对
// POSIX 路径）——文件清单按项目取数，usage 也必须按项目隔离，同相对路径跨
// 项目不互染。上限放宽到 200（命令 id 全局 50 个够用，文件路径多项目并行
// 工作很容易超），LRU/TTL 语义与命令层同一套

export const FILE_USAGE_STORAGE_KEY = 'sc.palette.fileUsage'
export const FILE_USAGE_MAX_KEYS = 200

export function fileUsageKeyOf(projectId: string, path: string): string {
  return `${projectId}:${path}`
}

/** 读全量原始 map（不滤过期）：removeFileUsage 的操作面——清理与过期正交，
 *  若按 TTL 滤后删除会把「已过期但还没被读侧清掉」的条目误判为不存在而跳过 */
function parseFileUsageMap(): CmdUsageMap {
  return parseUsage(safeStorage.getItem(FILE_USAGE_STORAGE_KEY))
}

/** 读全量 map，超 TTL 条目按失效偏好丢弃（P-200 同过期窗）；损坏数据沿用
 *  parseUsage 逐条丢弃，读路径幂等 */
function loadFileUsageMap(now: number): CmdUsageMap {
  const stored = parseFileUsageMap()
  const usage: CmdUsageMap = {}
  for (const [k, e] of Object.entries(stored)) {
    if (now - e.lastAt <= CMD_USAGE_TTL_MS) usage[k] = e
  }
  return usage
}

/** 读取当前项目的文件 usage：键剥掉项目前缀，返回 path → entry（跨项目条目
 *  不外泄；projectPath 轮换/projectId 重建只影响旧条目认领，TTL 内自然过期） */
export function loadFileUsage(projectId: string, now = Date.now()): CmdUsageMap {
  if (!projectId) return {}
  const prefix = `${projectId}:`
  const out: CmdUsageMap = {}
  for (const [k, e] of Object.entries(loadFileUsageMap(now))) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = e
  }
  return out
}

/** 记一次文件打开（openFile 成功链收口处调用）。load→record→save 每次落盘：
 *  打开是低频用户动作，≤200 条 JSON 往返成本可忽略，换无缓存的一致性 */
export function recordFileUsage(projectId: string, path: string, now = Date.now()): void {
  if (!projectId || !path) return
  const next = recordCmdUsage(loadFileUsageMap(now), fileUsageKeyOf(projectId, path), now, FILE_USAGE_MAX_KEYS)
  safeStorage.setItem(FILE_USAGE_STORAGE_KEY, JSON.stringify(next))
}

/** 打开失败（文件已删/改名）即清记录：失效路径留在置顶段/同分带里每次都
 *  落空，与 useRecentFiles.removeRecent 同口径（记录侧自清理，展示侧另有
 *  「不在清单内自然落选」双保险） */
export function removeFileUsage(projectId: string, path: string): void {
  if (!projectId || !path) return
  const usage = parseFileUsageMap()
  const key = fileUsageKeyOf(projectId, path)
  if (!(key in usage)) return
  delete usage[key]
  safeStorage.setItem(FILE_USAGE_STORAGE_KEY, JSON.stringify(usage))
}
