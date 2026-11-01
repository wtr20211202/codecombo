import { describe, it, expect } from 'vitest'
import {
  buildShareAddressPlan,
  buildShareBasePlan,
  shareReachTone,
  type ShareAddressContext,
} from './shareAddress'
import type { NetworkAddress } from './networkAddress'

// 分享地址计划（P-20261020-2）：纯函数覆盖全部选址分支——配置基址/外部地址/
// 当前非回环/回环候选/旧端口回退/服务未就绪。三色徽标只由 state 决定。

const lan: NetworkAddress = { ip: '192.168.1.50', family: 'v4', iface: 'eth0', private: true }
const lan2: NetworkAddress = { ip: '10.0.0.9', family: 'v4', iface: 'wlan0', private: true }
const pub: NetworkAddress = { ip: '203.0.113.10', family: 'v4', iface: 'eth0', private: false }

function ctx(over: Partial<ShareAddressContext> = {}): ShareAddressContext {
  return {
    currentHref: 'http://localhost:9999/project',
    status: { running: true, port: 10001, scheme: 'http' },
    publicBaseUrl: '',
    externalAccessUrl: '',
    addresses: [],
    ...over,
  }
}

const TOKEN = 'abcd1234efgh5678'

describe('buildShareBasePlan — 选址优先级', () => {
  it('分享外发基址最高优先（公网绿）', () => {
    const plan = buildShareBasePlan(ctx({
      publicBaseUrl: 'https://share.example.com/',
      externalAccessUrl: 'https://nas.example.com',
      currentHref: 'http://192.168.1.5:9999/',
    }))
    expect(plan).toMatchObject({ state: 'external', source: 'publicBase', baseOrigin: 'https://share.example.com' })
    expect(shareReachTone(plan.state)).toBe('green')
  })

  it('分享基址是私网 → 黄（需同一网络）；回环 → 红', () => {
    expect(buildShareBasePlan(ctx({ publicBaseUrl: 'http://192.168.1.50:9999' })))
      .toMatchObject({ state: 'lan', source: 'publicBase', baseOrigin: 'http://192.168.1.50:9999' })
    expect(buildShareBasePlan(ctx({ publicBaseUrl: 'http://localhost:9999' })))
      .toMatchObject({ state: 'loopback', source: 'publicBase', baseOrigin: 'http://localhost:9999' })
  })

  it('非法分享基址被忽略，继续走外部地址', () => {
    const plan = buildShareBasePlan(ctx({
      publicBaseUrl: 'https://share.example.com/sub',
      externalAccessUrl: 'https://nas.tailnet.ts.net',
    }))
    expect(plan).toMatchObject({ state: 'external', source: 'external', baseOrigin: 'https://nas.tailnet.ts.net' })
  })

  it('外部访问地址优先于当前地址/候选', () => {
    const plan = buildShareBasePlan(ctx({ externalAccessUrl: 'https://nas.example.com', addresses: [lan] }))
    expect(plan).toMatchObject({ state: 'external', source: 'external', baseOrigin: 'https://nas.example.com' })
    expect(plan.candidates).toEqual([])
  })

  it('当前非回环：公网绿 / 私网黄，均取当前 origin', () => {
    expect(buildShareBasePlan(ctx({ currentHref: 'https://nas.example.com/app' })))
      .toMatchObject({ state: 'public', source: 'current', baseOrigin: 'https://nas.example.com' })
    expect(buildShareBasePlan(ctx({ currentHref: 'http://192.168.1.5:9999/app' })))
      .toMatchObject({ state: 'lan', source: 'current', baseOrigin: 'http://192.168.1.5:9999' })
  })

  it('回环入口 + 局域网候选：自动改址但徽标保持红（不能保证同网）', () => {
    const plan = buildShareBasePlan(ctx({ addresses: [pub, lan2, lan] }))
    expect(plan.state).toBe('loopback')
    expect(plan.source).toBe('candidate')
    // 私网 v4 优先（sortRelayCandidates 稳定序）
    expect(plan.baseOrigin).toBe('http://10.0.0.9:9999')
    expect(plan.candidates.map(a => a.ip)).toEqual(['10.0.0.9', '192.168.1.50', '203.0.113.10'])
    expect(shareReachTone(plan.state)).toBe('red')
  })

  it('回环入口无候选：旧格式 host + sharePort 回退（红）', () => {
    const plan = buildShareBasePlan(ctx())
    expect(plan).toMatchObject({ state: 'loopback', source: 'legacy', baseOrigin: 'http://localhost:10001' })
  })

  it('旧格式跟随子服务 scheme（https）', () => {
    const plan = buildShareBasePlan(ctx({
      status: { running: true, port: 10001, scheme: 'https' },
      currentHref: 'http://localhost:9999/',
    }))
    expect(plan.baseOrigin).toBe('https://localhost:10001')
  })

  it('服务未就绪 / 地址不可解析 → unreachable', () => {
    expect(buildShareBasePlan(ctx({ status: { running: false, port: 0, scheme: '' } })))
      .toEqual({ state: 'unreachable', source: '', baseOrigin: '', candidates: [] })
    expect(buildShareBasePlan(ctx({ currentHref: 'not a url' })))
      .toEqual({ state: 'unreachable', source: '', baseOrigin: '', candidates: [] })
  })
})

describe('buildShareAddressPlan — 拼链', () => {
  it('配置基址 → <base>/s/<token>（阶段 B 同源路径）', () => {
    const plan = buildShareAddressPlan(TOKEN, ctx({ publicBaseUrl: 'https://share.example.com' }))
    expect(plan.url).toBe(`https://share.example.com/s/${TOKEN}`)
    expect(plan.legacy).toBe(false)
  })

  it('当前非回环 origin → 当前 origin + /s/<token>（不再带 sharePort）', () => {
    const plan = buildShareAddressPlan(TOKEN, ctx({ currentHref: 'http://192.168.1.5:9999/x', addresses: [lan] }))
    expect(plan.url).toBe(`http://192.168.1.5:9999/s/${TOKEN}`)
    expect(plan.url).not.toContain(':10001')
  })

  it('回环 + 候选 → 候选 origin + /s/<token>（主端口）', () => {
    const plan = buildShareAddressPlan(TOKEN, ctx({ addresses: [lan] }))
    expect(plan.url).toBe(`http://192.168.1.50:9999/s/${TOKEN}`)
    expect(plan.legacy).toBe(false)
  })

  it('回环无候选 → 旧格式 host:sharePort（legacy 标记）', () => {
    const plan = buildShareAddressPlan(TOKEN, ctx())
    expect(plan.url).toBe(`http://localhost:10001/s/${TOKEN}`)
    expect(plan.legacy).toBe(true)
  })

  it('服务未就绪 → 空 URL（调用方提示 serviceDown）', () => {
    const plan = buildShareAddressPlan(TOKEN, ctx({ status: { running: false, port: 0, scheme: '' } }))
    expect(plan.url).toBe('')
    expect(plan.state).toBe('unreachable')
  })

  it('token 原样拼接（base36 无编码面），基址尾斜杠不产生双斜杠', () => {
    const plan = buildShareAddressPlan(TOKEN, ctx({ publicBaseUrl: 'https://share.example.com/' }))
    expect(plan.url).toBe(`https://share.example.com/s/${TOKEN}`)
    expect(plan.url.includes('//s/')).toBe(false)
  })
})

describe('shareReachTone — 三色语义', () => {
  it('红=回环/不可达；黄=局域网；绿=外部/公网', () => {
    expect(shareReachTone('loopback')).toBe('red')
    expect(shareReachTone('unreachable')).toBe('red')
    expect(shareReachTone('lan')).toBe('yellow')
    expect(shareReachTone('external')).toBe('green')
    expect(shareReachTone('public')).toBe('green')
  })
})
