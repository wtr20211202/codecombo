/**
 * 分享有效期预设（P-20261020-5）：创建弹层 / 结果卡 / 分享管理器共用同一张
 * 档位表与换算逻辑——三处各手抄一份档位是历史结果（结果卡只有 1d/7d/自定义，
 * 创建时根本没有入口）。纯函数集中在此，单测锁定换算与时区收口。
 *
 * `custom` 不是固定时长：自定义日期取当日 23:59:59.999 本地时区（选中日子
 * 当天全程有效，与结果卡 P-20261003-29 既有语义一致）。
 */
export type ShareTtlChoice = 'permanent' | '1h' | '1d' | '7d' | '30d' | 'custom'

/** 后端 shareDefaultTTL 允许的档位（1h 只在单次创建可选，不进全局默认） */
export type ShareDefaultTtl = 'permanent' | '1d' | '7d' | '30d'

export const SHARE_TTL_PRESETS: ReadonlyArray<{ value: ShareTtlChoice; i18nKey: string }> = [
  { value: '1h', i18nKey: 'share.ttl.oneHour' },
  { value: '1d', i18nKey: 'share.ttl.oneDay' },
  { value: '7d', i18nKey: 'share.ttl.sevenDays' },
  { value: '30d', i18nKey: 'share.ttl.thirtyDays' },
  { value: 'permanent', i18nKey: 'share.ttl.permanent' },
  { value: 'custom', i18nKey: 'share.ttl.custom' },
]

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const PRESET_MS: Record<'1h' | '1d' | '7d' | '30d', number> = {
  '1h': HOUR_MS,
  '1d': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
}

/** 档位 → i18n 词条键（结果卡后续文案复用；未知档回落 permanent） */
export function shareTtlLabelKey(choice: ShareTtlChoice): string {
  return SHARE_TTL_PRESETS.find((p) => p.value === choice)?.i18nKey ?? 'share.ttl.permanent'
}

/**
 * 档位 → 落库用的 RFC3339 到期时点；永久返回 null（接口约定 null = 清窗）。
 * 自定义日期为空/非法时同样返回 null（调用方应先禁用提交；此处兜底不产生
 * 非法时点）。`now` 可注入便于单测。
 */
export function shareTtlExpiresAt(
  choice: ShareTtlChoice,
  customDate: number | null | undefined,
  now: number = Date.now(),
): string | null {
  if (choice === 'permanent') return null
  if (choice === 'custom') {
    if (customDate == null || !Number.isFinite(customDate)) return null
    const d = new Date(customDate)
    d.setHours(23, 59, 59, 999)
    return d.toISOString()
  }
  return new Date(now + PRESET_MS[choice]).toISOString()
}

/**
 * 既有到期时点 → 选择器状态（无有效期 = 永久）。剩余时长与某预设档在
 * 宽容窗口内（创建/设置刚返回时的回填场景）→ 回填该预设档，让结果卡显示
 * 用户实际选的「7 天」而不是一律「自定义日期」；偏差较大（例如两天后打开
 * 管理器）才按自定义日期展示精确时点。`now` 可注入便于单测。
 */
const PRESET_MATCH_TOLERANCE_MS = 5 * 60 * 1000

export function shareTtlFromExpiresAt(expiresAt?: string | null, now: number = Date.now()): {
  choice: ShareTtlChoice
  date: number | null
} {
  if (!expiresAt) return { choice: 'permanent', date: null }
  const ts = new Date(expiresAt).getTime()
  if (!Number.isFinite(ts)) return { choice: 'permanent', date: null }
  const remain = ts - now
  for (const [choice, ms] of Object.entries(PRESET_MS) as Array<['1h' | '1d' | '7d' | '30d', number]>) {
    if (Math.abs(remain - ms) <= PRESET_MATCH_TOLERANCE_MS) return { choice, date: ts }
  }
  return { choice: 'custom', date: ts }
}

/** 自定义日期过去的日子不可选（今天可选——当日有效是自定义期的最低粒度） */
export function shareTtlDateDisabled(ts: number): boolean {
  return ts < new Date().setHours(0, 0, 0, 0)
}
