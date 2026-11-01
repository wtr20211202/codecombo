import { describe, it, expect } from 'vitest'
import {
  EGRESS_CONTENT_WARNING,
  EGRESS_SESSION_WARNING,
  hitTypeI18nKey,
  parseEgressWarnings,
} from './egressGate'

// 出域闸响应解析（P-20261004-113）：只接受 warnings 数组非空的闸门形态；
// 命中明细只保留合法 {type,count}（防御未来字段形态漂移），原文从不在这条链上

describe('parseEgressWarnings — 出域闸第一跳响应', () => {
  it('内容命中：类型 + 计数透传，session=false', () => {
    const info = parseEgressWarnings({
      warnings: [EGRESS_CONTENT_WARNING],
      sensitiveHits: [{ type: 'known-token', count: 2 }, { type: 'private-key', count: 1 }],
    })
    expect(info).toEqual({
      session: false,
      warnings: [EGRESS_CONTENT_WARNING],
      hits: [{ type: 'known-token', count: 2 }, { type: 'private-key', count: 1 }],
    })
  })

  it('会话标记 + 内容命中合并：session=true', () => {
    const info = parseEgressWarnings({
      warnings: [EGRESS_SESSION_WARNING, EGRESS_CONTENT_WARNING],
      sensitiveHits: [{ type: 'sensitive-file-name', count: 3 }],
    })
    expect(info?.session).toBe(true)
    expect(info?.hits).toHaveLength(1)
  })

  it('无 warnings / 空 warnings / 非对象 → null（非法形态不当闸门）', () => {
    expect(parseEgressWarnings(null)).toBeNull()
    expect(parseEgressWarnings('oops')).toBeNull()
    expect(parseEgressWarnings({})).toBeNull()
    expect(parseEgressWarnings({ warnings: [] })).toBeNull()
    expect(parseEgressWarnings({ data: 'x' })).toBeNull()
  })

  it('命中明细脏条目被丢弃；未知 warnings token 仍视为闸门', () => {
    const info = parseEgressWarnings({
      warnings: [EGRESS_CONTENT_WARNING, 'future-warning'],
      sensitiveHits: [
        { type: 'known-token', count: 1 },
        { type: '', count: 1 },
        { type: 'known-token', count: 0 },
        { type: 'known-token', count: '2' },
        { type: 42, count: 1 },
        null,
      ],
    })
    expect(info?.hits).toEqual([{ type: 'known-token', count: 1 }])
    expect(info?.warnings).toEqual([EGRESS_CONTENT_WARNING, 'future-warning'])
  })
})

describe('hitTypeI18nKey — 类型 token 映射', () => {
  it('已知类型映射到 i18n 键尾', () => {
    expect(hitTypeI18nKey('known-token')).toBe('knownToken')
    expect(hitTypeI18nKey('sensitive-file-name')).toBe('sensitiveFileName')
    expect(hitTypeI18nKey('custom-pattern')).toBe('customPattern')
  })

  it('未知类型返回 null（调用方回退原文 token）', () => {
    expect(hitTypeI18nKey('future-type')).toBeNull()
  })
})
