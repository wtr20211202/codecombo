/**
 * 定时任务评估时区工具（P-20261005-217）：表单/列表展示与客户端预校验的
 * 纯函数集合。服务端是事实源（保存口 time.LoadLocation 前置校验），这里
 * 只做同语义的前置校验与「对表」展示——跨时区部署不错点从玄学变显式可查。
 */

/** 表单快捷候选（常用 IANA 时区；选择器 tag 模式允许任意合法名）。
 * 覆盖常见业务地即可，不求全——全量名单随 Intl 运行时能力校验兜底 */
export const COMMON_TIMEZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Bangkok',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Pacific/Auckland',
] as const

/** IANA 时区名是否可被运行时解析（客户端预校验，与服务端 LoadLocation 同判
 * 「能不能用」；Intl 不认识即 RangeError）。空串不算（空 = 按服务器时区） */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** 时区在某时刻的 UTC 偏移（分钟，东正西负）；解析失败返回 null。
 * 手法：同一绝对时刻分别在目标时区与 UTC 下读壁钟，差值即偏移——
 * 不依赖 Intl 的 timeZoneName 枚举（旧引擎兼容），DST 交割日自动跟随 */
export function zoneOffsetMinutes(tz: string, at: Date = new Date()): number | null {
  if (!isValidTimeZone(tz)) return null
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const get = (type: string): number => {
      const part = dtf.formatToParts(at).find(p => p.type === type)
      return part ? Number(part.value) : NaN
    }
    const asUTC = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24, // 个别引擎 hour12:false 下午夜报 '24'，归一回 0
      get('minute'),
      get('second'),
    )
    if (Number.isNaN(asUTC)) return null
    return Math.round((asUTC - at.getTime()) / 60000)
  } catch {
    return null
  }
}

/** 偏移分钟 → 展示形态：0 = 'UTC'，整时 = 'UTC+8'，非整时 = 'UTC+5:30' */
export function formatUTCOffset(minutes: number): string {
  if (minutes === 0) return 'UTC'
  const sign = minutes > 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`
}

/** 时区偏移标签：'UTC+8'；非法时区返回空串（调用方按缺省渲染，不硬凑） */
export function zoneOffsetLabel(tz: string, at: Date = new Date()): string {
  const minutes = zoneOffsetMinutes(tz, at)
  return minutes === null ? '' : formatUTCOffset(minutes)
}

/** RFC3339 串的壁钟时刻（'2026-10-15T14:33:05+08:00' → '14:33'）。
 * 服务端列表 now 段按服务器本地时区序列化，壁钟部分即服务器当前时刻——
 * 纯字符串切片，不做时区换算（换算反而会把服务器时刻折算成浏览器时区） */
export function wallClockOf(iso: string): string {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(iso)
  return m?.[1] ?? ''
}

/** RFC3339 串的数字偏移（'…+08:00' → 480 分钟；'Z' → 0；缺失 → null） */
export function parseUTCOffset(iso: string): number | null {
  if (iso.endsWith('Z')) return 0
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso)
  if (!m) return null
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -minutes : minutes
}

/** 指定时区的当地当前时刻（HH:MM；解析失败返回 '—'，不硬凑——非法时区
 * 交由表单校验拦截，这里只保证展示层不抛异常） */
export function zoneClockIn(tz: string, at: Date = new Date()): string {
  if (!isValidTimeZone(tz)) return '—'
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).format(at)
  } catch {
    return '—'
  }
}
