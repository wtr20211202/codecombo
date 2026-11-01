import { describe, expect, it, vi, beforeEach } from 'vitest'

// 自定义敏感模式前端同步单测（P-20261006-11）：mock 边界只有 settingsApi——
// 拉取成功注入 / 缺字段回落空 / 拉取失败保旧，三态覆盖。注入效果经
// utils/sensitiveMask 的公开导出观察（maskSensitive）

const { getSettingsMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn<() => Promise<unknown>>(),
}))
vi.mock('../api/domains/system', () => ({
  settingsApi: { get: () => getSettingsMock() },
}))

import { refreshCustomSensitivePatterns } from './useCustomSensitivePatterns'
import { maskSensitive, setCustomSensitivePatterns } from '../utils/sensitiveMask'

describe('refreshCustomSensitivePatterns', () => {
  beforeEach(() => {
    setCustomSensitivePatterns([])
    getSettingsMock.mockReset()
  })

  it('拉取成功：列表注入遮蔽链', async () => {
    getSettingsMock.mockResolvedValue({ data: { customSensitivePatterns: ['scrt_[A-Za-z0-9]{20,}'] } })
    await refreshCustomSensitivePatterns()
    expect(maskSensitive('x scrt_a1B2c3D4e5F6g7H8A9B2 y')).toBe('x *** y')
  })

  it('旧服务端缺字段：回落空数组（纯通用表现状）', async () => {
    setCustomSensitivePatterns(['scrt_[A-Za-z0-9]{20,}'])
    getSettingsMock.mockResolvedValue({ data: {} })
    await refreshCustomSensitivePatterns()
    expect(maskSensitive('x scrt_a1B2c3D4e5F6g7H8A9B2 y')).toBe('x scrt_a1B2c3D4e5F6g7H8A9B2 y')
  })

  it('拉取失败：静默保旧列表（追加防护不因瞬断撤销）', async () => {
    setCustomSensitivePatterns(['scrt_[A-Za-z0-9]{20,}'])
    getSettingsMock.mockRejectedValue(new Error('network'))
    await expect(refreshCustomSensitivePatterns()).resolves.toBeUndefined()
    expect(maskSensitive('x scrt_a1B2c3D4e5F6g7H8A9B2 y')).toBe('x *** y')
  })
})
