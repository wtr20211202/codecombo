/**
 * 出域敏感闸响应解析（P-20261004-113）：会话导出 md/jsonl 与终端输出导出
 * 三面共用同一契约——命中且未确认时服务端回 200 JSON `{warnings, sensitiveHits}`，
 * `sensitiveHits` 只有 `{type, count}`（类型 + 计数，服务端结构上就不含原文）；
 * `confirm=1` 二段确认后真出附件。本模块只做纯解析/映射（零 UI 依赖，便于
 * 单测），弹层与重试循环在 composables/useEgressGate。
 *
 * warnings 稳定 token（与 server/api/shared/sensitivegate.go 对齐）：
 *   - sensitive-session：会话被人工标记敏感（P-20261003-155，override=1 放行）
 *   - sensitive-content：内容命中凭据形态/敏感文件名（confirm=1 放行）
 */

export const EGRESS_SESSION_WARNING = 'sensitive-session'
export const EGRESS_CONTENT_WARNING = 'sensitive-content'

/** 单类型命中（与 Go 侧 sensitive.Hit 同形：只有 type/count 两键） */
export interface EgressSensitiveHit {
  type: string
  count: number
}

/** 出域闸第一跳响应解析结果 */
export interface EgressGateInfo {
  /** 会话敏感标记闸命中（文案走「敏感会话出域确认」） */
  session: boolean
  /** 内容命中明细（类型 + 计数；空 = 无内容命中） */
  hits: EgressSensitiveHit[]
  /** 原始 warnings（未知 token 向前兼容：调用方仍视为需要确认的闸门） */
  warnings: string[]
}

/** 解析服务端警示响应体；非闸门形态（无 warnings 数组/空数组）返回 null */
export function parseEgressWarnings(body: unknown): EgressGateInfo | null {
  if (!body || typeof body !== 'object') return null
  const raw = body as { warnings?: unknown; sensitiveHits?: unknown }
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is string => typeof w === 'string')
    : []
  if (warnings.length === 0) return null
  const hits: EgressSensitiveHit[] = []
  if (Array.isArray(raw.sensitiveHits)) {
    for (const item of raw.sensitiveHits) {
      if (!item || typeof item !== 'object') continue
      const { type, count } = item as { type?: unknown; count?: unknown }
      if (typeof type === 'string' && type !== '' && typeof count === 'number' && Number.isFinite(count) && count > 0) {
        hits.push({ type, count })
      }
    }
  }
  return {
    session: warnings.includes(EGRESS_SESSION_WARNING),
    hits,
    warnings,
  }
}

// 服务端类型 token → i18n 键尾（terminal.sensitiveHitType.<key>）。未知类型
// 回退原文 token（服务端新增类型不破坏旧前端，不引入第二套注册表）
const HIT_TYPE_KEYS: Record<string, string> = {
  'platform-token': 'platformToken',
  'known-token': 'knownToken',
  'aws-access-key': 'awsAccessKey',
  'secret-assignment': 'secretAssignment',
  'url-credentials': 'urlCredentials',
  'private-key': 'privateKey',
  'bearer-token': 'bearerToken',
  'sensitive-file-name': 'sensitiveFileName',
  'custom-pattern': 'customPattern',
}

/** 命中类型 → i18n 键尾；未知类型返回 null（调用方回退原始 type） */
export function hitTypeI18nKey(type: string): string | null {
  return HIT_TYPE_KEYS[type] ?? null
}
