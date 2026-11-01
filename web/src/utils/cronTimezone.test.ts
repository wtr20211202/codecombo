import { describe, expect, it } from 'vitest'
import {
  COMMON_TIMEZONES,
  formatUTCOffset,
  isValidTimeZone,
  parseUTCOffset,
  wallClockOf,
  zoneClockIn,
  zoneOffsetLabel,
  zoneOffsetMinutes,
} from './cronTimezone'

// 定时任务评估时区纯函数（P-20261005-217）：展示/预校验两面，服务端
// LoadLocation 是事实源。锚点用固定时刻断言偏移/壁钟，DST 交割日验证跟随

describe('isValidTimeZone', () => {
  it('accepts known IANA names and UTC', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
  })

  it('rejects garbage and empty (empty = server default, not a zone)', () => {
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('Asia/Shanghai/../..')).toBe(false)
    expect(isValidTimeZone('  ')).toBe(false)
  })
})

describe('zoneOffsetMinutes', () => {
  it('returns offsets east-positive for fixed-anchor instants', () => {
    // 2026-10-02T00:00:00Z：上海 +8、纽约夏令时 -4、伦敦夏令时 +1、UTC 0
    const at = new Date('2026-10-02T00:00:00Z')
    expect(zoneOffsetMinutes('Asia/Shanghai', at)).toBe(480)
    expect(zoneOffsetMinutes('UTC', at)).toBe(0)
    expect(zoneOffsetMinutes('America/New_York', at)).toBe(-240)
    expect(zoneOffsetMinutes('Europe/London', at)).toBe(60)
  })

  it('follows the DST transition across the year', () => {
    // 纽约：2026-03-08 春令时（-5 → -4）、2026-11-01 秋令时（-4 → -5）
    const winter = new Date('2026-01-15T12:00:00Z')
    const summer = new Date('2026-07-15T12:00:00Z')
    expect(zoneOffsetMinutes('America/New_York', winter)).toBe(-300)
    expect(zoneOffsetMinutes('America/New_York', summer)).toBe(-240)
  })

  it('handles half-hour offset zones', () => {
    const at = new Date('2026-10-02T00:00:00Z')
    expect(zoneOffsetMinutes('Asia/Kolkata', at)).toBe(330)
  })

  it('returns null for invalid zones', () => {
    expect(zoneOffsetMinutes('Not/AZone')).toBeNull()
    expect(zoneOffsetMinutes('')).toBeNull()
  })
})

describe('formatUTCOffset', () => {
  it('formats zero, whole-hour and half-hour offsets', () => {
    expect(formatUTCOffset(0)).toBe('UTC')
    expect(formatUTCOffset(480)).toBe('UTC+8')
    expect(formatUTCOffset(-300)).toBe('UTC-5')
    expect(formatUTCOffset(330)).toBe('UTC+5:30')
    expect(formatUTCOffset(-210)).toBe('UTC-3:30')
  })
})

describe('zoneOffsetLabel', () => {
  it('composes the label and degrades to empty for invalid zones', () => {
    expect(zoneOffsetLabel('Asia/Tokyo', new Date('2026-10-02T00:00:00Z'))).toBe('UTC+9')
    expect(zoneOffsetLabel('Not/AZone')).toBe('')
  })
})

describe('wallClockOf', () => {
  it('slices the server wall clock without timezone conversion', () => {
    expect(wallClockOf('2026-10-15T14:33:05+08:00')).toBe('14:33')
    expect(wallClockOf('2026-10-15T06:05:00Z')).toBe('06:05')
  })

  it('returns empty for non-RFC3339 input', () => {
    expect(wallClockOf('not-a-date')).toBe('')
    expect(wallClockOf('')).toBe('')
  })
})

describe('parseUTCOffset', () => {
  it('parses numeric offsets and Z', () => {
    expect(parseUTCOffset('2026-10-15T14:33:05+08:00')).toBe(480)
    expect(parseUTCOffset('2026-10-15T14:33:05-05:30')).toBe(-330)
    expect(parseUTCOffset('2026-10-15T14:33:05Z')).toBe(0)
  })

  it('returns null when the offset is missing', () => {
    expect(parseUTCOffset('2026-10-15T14:33:05')).toBeNull()
    expect(parseUTCOffset('')).toBeNull()
  })
})

describe('zoneClockIn', () => {
  it('renders the wall clock of the given zone at a fixed instant', () => {
    // 2026-10-02T00:00:00Z = 上海 08:00 / 纽约 09-01 20:00（夏令时）
    const at = new Date('2026-10-02T00:00:00Z')
    expect(zoneClockIn('Asia/Shanghai', at)).toBe('08:00')
    expect(zoneClockIn('America/New_York', at)).toBe('20:00')
  })

  it('degrades to an em dash for invalid zones instead of throwing', () => {
    expect(zoneClockIn('Not/AZone')).toBe('—')
    expect(zoneClockIn('')).toBe('—')
  })
})

describe('COMMON_TIMEZONES', () => {
  it('is a deduplicated list of runtime-valid zone names', () => {
    expect(new Set(COMMON_TIMEZONES).size).toBe(COMMON_TIMEZONES.length)
    for (const tz of COMMON_TIMEZONES) {
      expect(isValidTimeZone(tz), tz).toBe(true)
    }
  })
})
