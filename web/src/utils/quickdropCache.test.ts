import { beforeEach, describe, expect, it } from 'vitest'
import { clearQuickdropUrlCache, readQuickdropUrlCache, writeQuickdropUrlCache } from './quickdropCache'

/** 快投递链接缓存读写单测（P-20261117-1）：jsdom localStorage 真读写，
 *  逐用例清键防串扰；缓存是纯便利层——任何异常形态都必须回落 null 不抛 */
describe('quickdropCache', () => {
  beforeEach(() => {
    clearQuickdropUrlCache()
  })

  it('未写入时读缓存为 null', () => {
    expect(readQuickdropUrlCache()).toBeNull()
  })

  it('写入后读回 url/rotatedAt 原值', () => {
    writeQuickdropUrlCache('http://localhost:9999/drop/scd_abc123', '2026-11-17T00:00:00Z')
    expect(readQuickdropUrlCache()).toEqual({
      url: 'http://localhost:9999/drop/scd_abc123',
      rotatedAt: '2026-11-17T00:00:00Z',
    })
  })

  it('重复写入覆盖旧值（轮换覆盖语义）', () => {
    writeQuickdropUrlCache('http://a/drop/scd_old', 'T1')
    writeQuickdropUrlCache('http://a/drop/scd_new', 'T2')
    expect(readQuickdropUrlCache()).toEqual({ url: 'http://a/drop/scd_new', rotatedAt: 'T2' })
  })

  it('url/rotatedAt 空值拒写（空 rotatedAt 会造成假比对）', () => {
    writeQuickdropUrlCache('', 'T1')
    writeQuickdropUrlCache('http://a/drop/scd_x', '')
    expect(readQuickdropUrlCache()).toBeNull()
  })

  it('清缓存后读为 null（撤销/Meta 已不存在清除点）', () => {
    writeQuickdropUrlCache('http://a/drop/scd_x', 'T1')
    clearQuickdropUrlCache()
    expect(readQuickdropUrlCache()).toBeNull()
  })

  it('损坏 JSON 回落 null 不抛（手工改坏/半截写入）', () => {
    window.localStorage.setItem('sc.quickdrop.url', '{not-json')
    expect(readQuickdropUrlCache()).toBeNull()
  })

  it('形状不符回落 null（url/rotatedAt 非串或缺字段）', () => {
    window.localStorage.setItem('sc.quickdrop.url', JSON.stringify({ url: 42, rotatedAt: 'T1' }))
    expect(readQuickdropUrlCache()).toBeNull()
    window.localStorage.setItem('sc.quickdrop.url', JSON.stringify({ url: 'http://a/drop/scd_x' }))
    expect(readQuickdropUrlCache()).toBeNull()
    window.localStorage.setItem('sc.quickdrop.url', JSON.stringify([]))
    expect(readQuickdropUrlCache()).toBeNull()
  })
})
