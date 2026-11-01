// 审批模式自学习检测（P-20261006-28）纯函数面：近 7 天内同 op 前缀「手动允许
// ≥3 次」且无对应规则覆盖 → 建议在审批卡旁升格为审批规则（P-35）。只对重复
// 允许建议（信任方向单向——拒绝模式不计入不建议）；检测源是既有裁决记录列表
// （GET /ops-confirm?status=allowed，服务端 30 天保留窗 module.go
// agentApprovalRetention 覆盖 7 天检测窗），纯前端零新增端点。检测粒度：
// op 前缀足够——target 含路径等高变异不建议细化，防过宽规则误放（提案风险
// 注记）；派生前缀只是预填默认值，用户在规则表单确认粒度后才落库。

/** 检测窗（提案定值 7 天） */
export const APPROVAL_PATTERN_WINDOW_MS = 7 * 24 * 3600 * 1000

/** 建议阈值（提案定值：近 7 天手动允许 ≥3 次） */
export const APPROVAL_PATTERN_THRESHOLD = 3

/** 「落库即终态」与「人工裁决」的间隔分界：全局放行档位/规则 allow 命中在
 *  创建处理器内同步落终态（server/api/ai/opsconfirm.go CreateAgentApproval，
 *  createdAt≈resolvedAt，毫秒级）；人工裁决至少经卡面渲染 + 人手点击。分界
 *  两侧误判代价不对称：误判「自动」→ 计数偏少 → 少建议（宁漏不计，与既有
 *  审批面守卫同方向）；反向误判 → 计数虚高 → 建议提前且「已允许 N 次」不实 */
export const AUTO_ALLOW_GAP_MS = 1000

/** 检测输入的最小记录面（ApprovalRecord 的结构子集：纯函数只依赖这几个字段，
 *  单测免造全量记录） */
export interface ApprovalPatternRecord {
  op: string
  status?: string
  ruleHit?: string
  createdAt?: string
  resolvedAt?: string
}

/** 规则覆盖判定的最小规则面（AgentApprovalRule 的结构子集） */
export interface ApprovalPatternRule {
  opPattern?: string
}

/** 检测产出：建议固化的 op 前缀（规则表单预填值）与近窗手动允许次数（文案 N） */
export interface ApprovalPatternSuggestion {
  pattern: string
  count: number
}

/**
 * 从完整 op 派生建议固化的前缀（规则预填默认值，用户可在表单改粒度）：
 * git 开头取前两 token（git push / git reset——子命令才是语义边界，单 token
 * 「git」前缀会连 reset --hard 一并放行）；其余取首 token（files.write 等
 * 命名空间形、守护路由标签形如「批量替换」的首 token 已足够特异）。无有效
 * token 返回空串（调用方按不可检测处理，不出建议）。
 */
export function deriveOpPrefix(op: string): string {
  const tokens = op.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  if (tokens.length >= 2 && tokens[0]!.toLowerCase() === 'git') {
    return `${tokens[0]} ${tokens[1]}`
  }
  return tokens[0]!
}

/** 是否「人工允许」的记录：allowed 终态 + 未命中规则（ruleHit 空。ask 效果
 *  规则命中后仍走卡流、人工放行的记录 ruleHit 非空——已有规则覆盖的操作本
 *  就不该再建议，与此处排除同向）+ 裁决间隔超过自动落库分界（排除全局档位
 *  自动放行的记录）。时间戳缺失/坏值按不可判处理（不计入，宁漏不计） */
export function isManualAllow(a: ApprovalPatternRecord): boolean {
  if (a.status !== 'allowed' || !!a.ruleHit) return false
  if (!a.createdAt || !a.resolvedAt) return false
  const created = Date.parse(a.createdAt)
  const resolved = Date.parse(a.resolvedAt)
  if (!Number.isFinite(created) || !Number.isFinite(resolved)) return false
  return resolved - created > AUTO_ALLOW_GAP_MS
}

/**
 * 任一规则的 opPattern 前缀命中该 op（大小写不敏感，与 server/config/
 * approval_rules.go ResolveApprovalDecision 同口径）即视为「已有规则覆盖」，
 * 不再建议——无论命中规则的 effect 与路径条件：配过规则（哪怕只是路径受限
 * 或 ask 留档）说明用户已会用规则面；且规则表有序取首个命中，新增规则排在
 * 表尾会被更早命中的规则短路，「创建规则」的建议反而误导。路径受限规则按
 * 覆盖处理是保守方向（少建议，宁漏不计）
 */
export function ruleCoversOp(rules: ApprovalPatternRule[], op: string): boolean {
  const opNorm = op.trim().toLowerCase()
  if (!opNorm) return true
  return rules.some((r) => {
    const p = (r.opPattern ?? '').trim().toLowerCase()
    return !!p && opNorm.startsWith(p)
  })
}

/** 近窗手动允许计数：派生前缀同组（大小写不敏感归一，与服务端 op 前缀匹配
 *  同口径）且裁决时刻落在检测窗内 */
export function countManualAllows(
  records: ApprovalPatternRecord[],
  prefix: string,
  now = Date.now(),
  windowMs = APPROVAL_PATTERN_WINDOW_MS,
): number {
  const key = prefix.trim().toLowerCase()
  if (!key) return 0
  let n = 0
  for (const a of records) {
    if (!isManualAllow(a)) continue
    const at = Date.parse(a.resolvedAt!)
    if (!Number.isFinite(at) || now - at > windowMs) continue
    if (deriveOpPrefix(a.op).trim().toLowerCase() === key) n++
  }
  return n
}

/**
 * 单个 pending op 的建议检测：派生前缀有效 + 无规则覆盖 + 近窗手动允许达
 * 阈值时返回建议；否则 null（含拒绝记录——isManualAllow 已按状态排除，拒绝
 * 模式天然不建议）。now/windowMs/threshold 参数化供单测时间旅行
 */
export function detectAllowPattern(
  records: ApprovalPatternRecord[],
  op: string,
  rules: ApprovalPatternRule[],
  now = Date.now(),
  windowMs = APPROVAL_PATTERN_WINDOW_MS,
  threshold = APPROVAL_PATTERN_THRESHOLD,
): ApprovalPatternSuggestion | null {
  const prefix = deriveOpPrefix(op)
  if (!prefix) return null
  if (ruleCoversOp(rules, op)) return null
  const count = countManualAllows(records, prefix, now, windowMs)
  return count >= threshold ? { pattern: prefix, count } : null
}

// ---- 节流存储（提案：同模式 7 天只建议一次） ----

/** 节流存储键（safeStorage 单键 JSON map：pattern 小写 → 首次建议展示时刻
 *  ISO）。单键而非 per-pattern 键：safeStorage 无键枚举面，单键整体读回/
 *  过期清理/e2e 清场都只动一个键 */
export const APPROVAL_SUGGEST_SHOWN_KEY = 'sc.approvalRuleSuggestShown'

/** 节流窗（提案定值：同模式 7 天只建议一次） */
export const APPROVAL_SUGGEST_THROTTLE_MS = 7 * 24 * 3600 * 1000

/** 节流表条目上限：op 长尾的防御性封顶（每条 ≤128 字符 pattern + 时刻，
 *  50 条 KB 量级封顶），超限裁最旧——与审批规则表上限（ApprovalMaxRules=50）
 *  同思路 */
export const SHOWN_MAP_MAX = 50

export type ApprovalShownMap = Record<string, string>

/** 读节流表：坏 JSON/坏条目跳过（存储面脏数据不抛错，检测静默降级为不节流） */
export function loadShownMap(get: (key: string) => string | null): ApprovalShownMap {
  const raw = get(APPROVAL_SUGGEST_SHOWN_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: ApprovalShownMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && k && typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** 写节流表：先清已出节流窗的条目（no-op 也会在下次写入时自然瘦身），再按
 *  「时刻新者留存」封顶——条目爆炸防御。isolate 惰性写：调用方持有返回 map
 *  落存储（读侧失败静默，语义降级为会话内节流） */
export function saveShownMap(
  map: ApprovalShownMap,
  now = Date.now(),
  windowMs = APPROVAL_SUGGEST_THROTTLE_MS,
): ApprovalShownMap {
  const fresh: ApprovalShownMap = {}
  for (const [k, iso] of Object.entries(map)) {
    const at = Date.parse(iso)
    if (Number.isFinite(at) && now - at <= windowMs) fresh[k] = iso
  }
  const entries = Object.entries(fresh)
  if (entries.length > SHOWN_MAP_MAX) {
    entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    for (const [k] of entries.slice(SHOWN_MAP_MAX)) delete fresh[k]
  }
  return fresh
}

/** 模式是否在节流窗内（7 天内展示过即不再建议；key 小写归一与写入侧一致） */
export function isPatternThrottled(
  map: ApprovalShownMap,
  pattern: string,
  now = Date.now(),
  windowMs = APPROVAL_SUGGEST_THROTTLE_MS,
): boolean {
  const iso = map[pattern.trim().toLowerCase()]
  if (!iso) return false
  const at = Date.parse(iso)
  return Number.isFinite(at) && now - at <= windowMs
}
