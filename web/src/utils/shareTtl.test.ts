import { describe, expect, it } from 'vitest'
import {
  SHARE_TTL_PRESETS, shareTtlDateDisabled, shareTtlExpiresAt, shareTtlFromExpiresAt, shareTtlLabelKey,
} from './shareTtl'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe('shareTtlExpiresAt', () => {
  const now = Date.UTC(2026, 9, 20, 8, 0, 0)

  it('预设档位按 now + 固定时长换算', () => {
    expect(shareTtlExpiresAt('1h', null, now)).toBe(new Date(now + HOUR).toISOString())
    expect(shareTtlExpiresAt('1d', null, now)).toBe(new Date(now + DAY).toISOString())
    expect(shareTtlExpiresAt('7d', null, now)).toBe(new Date(now + 7 * DAY).toISOString())
    expect(shareTtlExpiresAt('30d', null, now)).toBe(new Date(now + 30 * DAY).toISOString())
  })

  it('永久返回 null（接口约定 null = 清窗）', () => {
    expect(shareTtlExpiresAt('permanent', 123, now)).toBeNull()
  })

  it('自定义日期取当日 23:59:59.999 本地时区（当天全程有效）', () => {
    const picked = new Date(2026, 10, 5, 9, 15, 0)
    const iso = shareTtlExpiresAt('custom', picked.getTime(), now)
    const d = new Date(iso!)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(10)
    expect(d.getDate()).toBe(5)
    expect(d.getHours()).toBe(23)
    expect(d.getMinutes()).toBe(59)
    expect(d.getSeconds()).toBe(59)
    expect(d.getMilliseconds()).toBe(999)
  })

  it('自定义日期缺失/非法返回 null（调用方需先禁用提交）', () => {
    expect(shareTtlExpiresAt('custom', null, now)).toBeNull()
    expect(shareTtlExpiresAt('custom', Number.NaN, now)).toBeNull()
  })
})

describe('shareTtlFromExpiresAt', () => {
  it('无有效期 = 永久', () => {
    expect(shareTtlFromExpiresAt(undefined)).toEqual({ choice: 'permanent', date: null })
    expect(shareTtlFromExpiresAt('')).toEqual({ choice: 'permanent', date: null })
  })

  it('有效时点 = 自定义日期回填（时间戳原样）', () => {
    const iso = '2026-11-01T12:00:00Z'
    const now = Date.parse('2026-10-20T00:00:00Z')
    expect(shareTtlFromExpiresAt(iso, now)).toEqual({ choice: 'custom', date: Date.parse(iso) })
  })

  it('剩余时长贴近预设档时回填该档（结果卡显示用户选的 7 天而非自定义）', () => {
    const now = Date.parse('2026-10-20T00:00:00Z')
    expect(shareTtlFromExpiresAt(new Date(now + 7 * DAY + 30_000).toISOString(), now))
      .toEqual({ choice: '7d', date: now + 7 * DAY + 30_000 })
    expect(shareTtlFromExpiresAt(new Date(now + HOUR - 10_000).toISOString(), now))
      .toMatchObject({ choice: '1h' })
    // 偏差超出宽容窗（例如一天后再打开管理器）按自定义日期展示精确时点
    expect(shareTtlFromExpiresAt(new Date(now + 20 * DAY).toISOString(), now))
      .toMatchObject({ choice: 'custom' })
  })

  it('非法时点回落永久（不把 NaN 渲染进日期控件）', () => {
    expect(shareTtlFromExpiresAt('not-a-date')).toEqual({ choice: 'permanent', date: null })
  })
})

describe('shareTtlLabelKey / 预设表', () => {
  it('每个预设都有 i18n 键且键值唯一', () => {
    const keys = SHARE_TTL_PRESETS.map((p) => p.i18nKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const p of SHARE_TTL_PRESETS) {
      expect(p.i18nKey.startsWith('share.ttl.')).toBe(true)
      expect(shareTtlLabelKey(p.value)).toBe(p.i18nKey)
    }
  })
})

describe('shareTtlDateDisabled', () => {
  it('过去的日子禁选，今天可选', () => {
    const todayStart = new Date().setHours(0, 0, 0, 0)
    expect(shareTtlDateDisabled(todayStart - DAY)).toBe(true)
    expect(shareTtlDateDisabled(todayStart)).toBe(false)
    expect(shareTtlDateDisabled(todayStart + DAY)).toBe(false)
  })
})
