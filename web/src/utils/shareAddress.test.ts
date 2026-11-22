import { describe, it, expect } from 'vitest'
import {
  buildShareAddressPlan,
  buildShareBasePlan,
  shareReachTone,
  shouldWarnCopy,
  type ShareAddressContext,
} from './shareAddress'
import { loopbackSelfCandidates, type NetworkAddress } from './networkAddress'

// 分享地址计划（P-20261020-2；P-20261120-4 preferred/loopbackSelf 语义）：纯
// 函数覆盖全部选址分支——配置基址/外部地址/当前非回环/回环入口（自动态=
// 浏览器地址、显式候选、显式回环合成项）/旧端口回退/服务未就绪。三色徽标
// 只由 state 决定。

const lan: NetworkAddress = { ip: '192.168.1.50', family: 'v4', iface: 'eth0', private: true }
const lan2: NetworkAddress = { ip: '10.0.0.9', family: 'v4', iface: 'wlan0', private: true }
const pub: NetworkAddress = { ip: '203.0.113.10', family: 'v4', iface: 'eth0', private: false }
const selfCandidates = loopbackSelfCandidates('本机')

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

  it('回环入口自动态：source=loopbackSelf，baseOrigin=浏览器地址（P-20261120-4）', () => {
    const plan = buildShareBasePlan(ctx({ addresses: [pub, lan2, lan], loopbackExtras: selfCandidates }))
    expect(plan.state).toBe('loopback')
    expect(plan.source).toBe('loopbackSelf')
    expect(plan.baseOrigin).toBe('http://localhost:9999')
    // 候选清单 = 降权展示序 + 置尾回环合成项
    expect(plan.candidates.map(a => a.ip)).toEqual(['10.0.0.9', '192.168.1.50', '203.0.113.10', '127.0.0.1', 'localhost'])
    expect(shareReachTone(plan.state)).toBe('red')
  })

  it('回环入口显式选局域网候选：source=candidate，baseOrigin 钉住所选（不被排序覆盖）', () => {
    const plan = buildShareBasePlan(ctx({ addresses: [pub, lan2, lan], preferredIp: '203.0.113.10', loopbackExtras: selfCandidates }))
    expect(plan.state).toBe('loopback')
    expect(plan.source).toBe('candidate')
    expect(plan.baseOrigin).toBe('http://203.0.113.10:9999')
  })

  it('回环入口显式选回环合成项：source=loopbackSelf，origin 为所选回环 ip', () => {
    const plan = buildShareBasePlan(ctx({ addresses: [lan], preferredIp: '127.0.0.1', loopbackExtras: selfCandidates }))
    expect(plan.source).toBe('loopbackSelf')
    expect(plan.baseOrigin).toBe('http://127.0.0.1:9999')
  })

  it('回环入口无候选（未注入合成项）：旧格式 host + sharePort 回退（收窄保留）', () => {
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

  it('回环自动态（仅 LAN 候选未注入合成项）→ 浏览器地址 origin + /s/<token>', () => {
    const plan = buildShareAddressPlan(TOKEN, ctx({ addresses: [lan] }))
    expect(plan.url).toBe(`http://localhost:9999/s/${TOKEN}`)
    expect(plan.source).toBe('loopbackSelf')
    // 候选清单仍在（下拉可显式切换），只是不再被自动改写
    expect(plan.candidates.map(a => a.ip)).toEqual(['192.168.1.50'])
    expect(plan.legacy).toBe(false)
  })

  it('回环自动态（注入合成项）→ 浏览器地址 origin + /s/<token>（P-20261120-4）', () => {
    const plan = buildShareAddressPlan(TOKEN, ctx({ addresses: [lan], loopbackExtras: selfCandidates }))
    expect(plan.url).toBe(`http://localhost:9999/s/${TOKEN}`)
    expect(plan.source).toBe('loopbackSelf')
    expect(plan.legacy).toBe(false)
  })

  it('回环显式选候选 → 所选 origin + /s/<token>', () => {
    const plan = buildShareAddressPlan(TOKEN, ctx({ addresses: [lan], preferredIp: '192.168.1.50', loopbackExtras: selfCandidates }))
    expect(plan.url).toBe(`http://192.168.1.50:9999/s/${TOKEN}`)
    expect(plan.source).toBe('candidate')
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

describe('shouldWarnCopy — 复制警示判定（P-20261119-7；P-20261120-4 扩 loopbackSelf）', () => {
  it('回环本源（自动态/显式选回环）→ loopbackSelf；显式候选 → candidate；旧格式回退 → legacy', () => {
    expect(shouldWarnCopy(buildShareBasePlan(ctx({ addresses: [lan], loopbackExtras: selfCandidates })))).toBe('loopbackSelf')
    expect(shouldWarnCopy(buildShareBasePlan(ctx({ addresses: [lan], preferredIp: '127.0.0.1', loopbackExtras: selfCandidates })))).toBe('loopbackSelf')
    expect(shouldWarnCopy(buildShareBasePlan(ctx({ addresses: [lan], preferredIp: '192.168.1.50', loopbackExtras: selfCandidates })))).toBe('candidate')
    expect(shouldWarnCopy(buildShareBasePlan(ctx()))).toBe('legacy')
  })

  it('显式基址（含回环配置）/ 非回环 / 不可达 / 空来源不警示', () => {
    // 显式配置意图最高：回环形态已有 publicBaseLoopback 专用 hint，复制面不重复打扰
    expect(shouldWarnCopy(buildShareBasePlan(ctx({ publicBaseUrl: 'http://localhost:9999' })))).toBeNull()
    expect(shouldWarnCopy(buildShareBasePlan(ctx({ publicBaseUrl: 'https://share.example.com' })))).toBeNull()
    expect(shouldWarnCopy(buildShareBasePlan(ctx({ externalAccessUrl: 'https://nas.example.com' })))).toBeNull()
    expect(shouldWarnCopy(buildShareBasePlan(ctx({ currentHref: 'http://192.168.1.5:9999/' })))).toBeNull()
    expect(shouldWarnCopy(buildShareBasePlan(ctx({ currentHref: 'https://nas.example.com/' })))).toBeNull()
    // unreachable 时 url 为空、复制按钮早退——警示天然不触达
    expect(shouldWarnCopy(buildShareBasePlan(ctx({ status: { running: false, port: 0, scheme: '' } })))).toBeNull()
  })
})
