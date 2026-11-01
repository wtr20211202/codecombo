import { describe, it, expect } from 'vitest'
import {
  buildRelayPlan,
  buildRelayUrl,
  candidateOrigin,
  formatUrlHost,
  isLoopbackHostname,
  isPrivateHostname,
  normalizeExternalAccessUrl,
  relayStatusTone,
  sortRelayCandidates,
  type NetworkAddress,
} from './networkAddress'

const lan: NetworkAddress = { ip: '192.168.1.50', family: 'v4', iface: 'eth0', private: true }
const lan2: NetworkAddress = { ip: '10.0.0.8', family: 'v4', iface: 'wlan0', private: true }
const v6ula: NetworkAddress = { ip: 'fd00::10', family: 'v6', iface: 'eth0', private: true }
const pub: NetworkAddress = { ip: '203.0.113.7', family: 'v4', iface: 'eth1', private: false }

describe('主机分类', () => {
  it('回环/未指定主机名判定', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.8.9.1', '::1', '[::1]', '0.0.0.0', '::']) {
      expect(isLoopbackHostname(h), h).toBe(true)
    }
    for (const h of ['192.168.1.5', '10.0.0.2', 'nas.local', 'example.com', '100.101.1.1', 'fd00::1']) {
      expect(isLoopbackHostname(h), h).toBe(false)
    }
  })

  it('私有/局域网主机判定（含 Tailscale CGNAT 与单标签主机名）', () => {
    for (const h of ['localhost', '192.168.1.5', '10.1.2.3', '172.16.0.1', '172.31.255.1', '169.254.1.1', '100.101.102.103', 'fd00::1', 'fc00::1', 'fe80::1', 'nas.local', 'nas']) {
      expect(isPrivateHostname(h), h).toBe(true)
    }
    for (const h of ['8.8.8.8', '203.0.113.7', '172.32.0.1', 'nas.example.com', 'example.com', '2001:db8::1']) {
      expect(isPrivateHostname(h), h).toBe(false)
    }
  })
})

describe('normalizeExternalAccessUrl — 外部入口校验/归一', () => {
  it('接受 http/https origin 并归一尾斜杠与默认端口', () => {
    expect(normalizeExternalAccessUrl('')).toEqual({ url: '', error: null })
    expect(normalizeExternalAccessUrl('  https://nas.example.com  ')).toEqual({ url: 'https://nas.example.com', error: null })
    expect(normalizeExternalAccessUrl('https://nas.example.com/')).toEqual({ url: 'https://nas.example.com', error: null })
    expect(normalizeExternalAccessUrl('http://192.168.1.10:9999/')).toEqual({ url: 'http://192.168.1.10:9999', error: null })
    expect(normalizeExternalAccessUrl('https://nas.example.com:443/')).toEqual({ url: 'https://nas.example.com', error: null })
    expect(normalizeExternalAccessUrl('http://[fd00::1]:8443/')).toEqual({ url: 'http://[fd00::1]:8443', error: null })
  })

  it('拒绝凭据/路径/query/fragment/非 http(s)', () => {
    expect(normalizeExternalAccessUrl('https://user:pass@nas.example.com').error).toBe('credentials')
    expect(normalizeExternalAccessUrl('https://nas.example.com/app').error).toBe('path')
    expect(normalizeExternalAccessUrl('https://nas.example.com/?token=x').error).toBe('query')
    expect(normalizeExternalAccessUrl('https://nas.example.com/?').error).toBe('query')
    expect(normalizeExternalAccessUrl('https://nas.example.com/#top').error).toBe('fragment')
    expect(normalizeExternalAccessUrl('ftp://nas.example.com').error).toBe('scheme')
    expect(normalizeExternalAccessUrl('nas.example.com').error).toBe('invalid')
    expect(normalizeExternalAccessUrl('https://nas example.com').error).toBe('invalid')
  })
})

describe('候选排序与 origin 拼装', () => {
  it('私有 v4 优先、去重、稳定序', () => {
    const sorted = sortRelayCandidates([pub, v6ula, lan2, lan, { ...lan, iface: 'aliased' }])
    expect(sorted.map(a => a.ip)).toEqual(['10.0.0.8', '192.168.1.50', 'fd00::10', '203.0.113.7'])
  })

  it('沿用当前协议/端口；IPv6 带方括号', () => {
    expect(candidateOrigin('https://localhost:9443/project?x=1', lan)).toBe('https://192.168.1.50:9443')
    expect(candidateOrigin('http://localhost:9999/', v6ula)).toBe('http://[fd00::10]:9999')
    expect(formatUrlHost('fd00::1')).toBe('[fd00::1]')
    expect(formatUrlHost('192.168.1.1')).toBe('192.168.1.1')
  })
})

describe('buildRelayPlan — 三形态', () => {
  it('配置外部地址 → 绿；外部地址压过局域网候选', () => {
    const plan = buildRelayPlan('http://localhost:9999/project?x=1', 'https://nas.example.com/', [lan])
    expect(plan.state).toBe('external')
    expect(plan.baseOrigin).toBe('https://nas.example.com')
    expect(plan.candidates).toEqual([])
    expect(relayStatusTone(plan.state)).toBe('green')
  })

  it('回环 + 局域网候选 → 红（当前入口）但二维码改写为候选地址', () => {
    const plan = buildRelayPlan('http://localhost:9999/project?x=1#L2', '', [pub, lan2, lan])
    expect(plan.state).toBe('loopback')
    expect(plan.baseOrigin).toBe('http://10.0.0.8:9999')
    expect(plan.candidates.map(a => a.ip)).toEqual(['10.0.0.8', '192.168.1.50', '203.0.113.7'])
    expect(relayStatusTone(plan.state)).toBe('red')
  })

  it('回环无候选 → 不可达（空 origin）', () => {
    const plan = buildRelayPlan('http://localhost:9999/', '', [])
    expect(plan.state).toBe('unreachable')
    expect(plan.baseOrigin).toBe('')
    expect(relayStatusTone(plan.state)).toBe('red')
  })

  it('非回环入口：局域网黄 / 公网绿', () => {
    expect(buildRelayPlan('http://192.168.1.5:9999/', '', []).state).toBe('lan')
    expect(buildRelayPlan('https://nas.example.com/', '', []).state).toBe('public')
    expect(relayStatusTone('lan')).toBe('yellow')
    expect(relayStatusTone('public')).toBe('green')
  })

  it('当前 URL 不可解析 → 不可达', () => {
    expect(buildRelayPlan('not a url', '', [lan])).toEqual({ state: 'unreachable', baseOrigin: '', candidates: [] })
  })
})

describe('buildRelayUrl — 深链拼装', () => {
  it('保留 path/search/hash；关闭携带时指向根入口', () => {
    const href = 'http://localhost:9999/project?project=p1&file=a.ts#L10'
    expect(buildRelayUrl(href, 'http://192.168.1.50:9999', true))
      .toBe('http://192.168.1.50:9999/project?project=p1&file=a.ts#L10')
    expect(buildRelayUrl(href, 'http://192.168.1.50:9999/', false)).toBe('http://192.168.1.50:9999/')
  })

  it('外部 origin 下同样携带当前路由', () => {
    expect(buildRelayUrl('http://localhost:9999/project?x=1', 'https://nas.example.com', true))
      .toBe('https://nas.example.com/project?x=1')
  })

  it('baseOrigin 与当前 origin 相同 → 原样返回当前 href', () => {
    const href = 'http://localhost:9999/project?x=1'
    expect(buildRelayUrl(href, 'http://localhost:9999', true)).toBe(href)
  })

  it('无 baseOrigin（不可达）→ 空串', () => {
    expect(buildRelayUrl('http://localhost:9999/', '', true)).toBe('')
  })
})
