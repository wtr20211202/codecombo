/**
 * 相对时间文案切片（纯函数，i18n 由调用方翻译 key）：
 * activityMap（OSC 133 活动时间戳）驱动，展示「最近活动」。
 */
export type RelativeTimeKey =
  | 'activityJustNow'
  | 'activityMinutesAgo'
  | 'activityHoursAgo'
  | 'activityDaysAgo'

export function relativeTimeParts(ts: number, now = Date.now()): { key: RelativeTimeKey; n: number } {
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return { key: 'activityJustNow', n: 0 }
  if (minutes < 60) return { key: 'activityMinutesAgo', n: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { key: 'activityHoursAgo', n: hours }
  return { key: 'activityDaysAgo', n: Math.floor(hours / 24) }
}
