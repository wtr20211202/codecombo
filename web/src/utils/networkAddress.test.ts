import { describe, it, expect } from 'vitest'
import {
  buildRelayPlan,
  buildRelayUrl,
  candidateOrigin,
  formatUrlHost,
  isLoopbackHostname,
  isPrivateHostname,
  loopbackSelfCandidates,
  normalizeExternalAccessUrl,
  relayStatusTone,
  sortRelayCandidates,
  isVirtualIfaceName,
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

  // P-20261119-7：纯 IP 数值排序是错误启发式——Windows 宿主 + WSL 的
  // vEthernet 172.26.144.1 数值上小于物理网卡 192.168.x，会抢走默认首项
  // 产出「对方根本打不开」的链接。虚拟/内部网卡名模式命中者降权排后。
  // P-20261120-4 注记：排序不再决定 baseOrigin（自动态=浏览器地址，显式选择
  // 经 preferredIp 钉住）——降权层现只影响下拉展示序。
  it('虚拟网卡降权：vEthernet 172.26 排在物理 192.168 之后（用户实测场景）', () => {
    const virtual: NetworkAddress = { ip: '172.26.144.1', family: 'v4', iface: 'vEthernet (WSL (Hyper-V firewall))', private: true }
    const physical: NetworkAddress = { ip: '192.168.1.50', family: 'v4', iface: '以太网', private: true }
    const sorted = sortRelayCandidates([virtual, physical])
    expect(sorted.map(a => a.ip)).toEqual(['192.168.1.50', '172.26.144.1'])
    // 降权不是剔除：候选清单完整保留，下拉仍可选回虚拟网卡
    expect(sorted).toHaveLength(2)
    // 自动态 = 浏览器地址栏 origin（排序不改写链接地址）
    expect(buildRelayPlan('http://localhost:9999/', '', [virtual, physical]).baseOrigin)
      .toBe('http://localhost:9999')
    // 显式选虚拟网卡 → 钉住其 origin（仍可选，只是排后）
    expect(buildRelayPlan('http://localhost:9999/', '', [virtual, physical], { preferredIp: '172.26.144.1' }).baseOrigin)
      .toBe('http://172.26.144.1:9999')
  })

  it('虚拟网卡模式表：命中与刻意不命中的典型接口名', () => {
    for (const name of ['vEthernet (Default Switch)', 'vEthernet (WSL)', 'WSL', 'docker0',
      'virbr0', 'vmnet8', 'VMware Network Adapter VMnet1', 'VirtualBox Host-Only Network', 'Loopback Pseudo-Interface 1']) {
      expect(isVirtualIfaceName(name), name).toBe(true)
    }
    // Tailscale CGNAT / macOS utun / OpenWrt 物理网桥 / 常规物理网卡一律不降权
    for (const name of ['eth0', 'wlan0', '以太网', 'tailscale0', 'utun3', 'br-lan', 'en0', 'Wi-Fi']) {
      expect(isVirtualIfaceName(name), name).toBe(false)
    }
  })

  it('IPv6 物理 vs 虚拟、以及虚拟公网 v4 vs 物理私网 v4：物理档整体在前', () => {
    const physicalV6: NetworkAddress = { ip: 'fd00::10', family: 'v6', iface: 'eth0', private: true }
    const virtualV6: NetworkAddress = { ip: 'fd00::20', family: 'v6', iface: 'docker0', private: true }
    expect(sortRelayCandidates([virtualV6, physicalV6]).map(a => a.ip)).toEqual(['fd00::10', 'fd00::20'])

    const physicalPriv: NetworkAddress = { ip: '192.168.1.50', family: 'v4', iface: '以太网', private: true }
    const virtualPub: NetworkAddress = { ip: '203.0.113.9', family: 'v4', iface: 'docker0', private: false }
    expect(sortRelayCandidates([virtualPub, physicalPriv]).map(a => a.ip)).toEqual(['192.168.1.50', '203.0.113.9'])
  })
})

describe('buildRelayPlan — 三形态（P-20261120-4 preferred 语义）', () => {
  it('配置外部地址 → 绿；外部地址压过局域网候选', () => {
    const plan = buildRelayPlan('http://localhost:9999/project?x=1', 'https://nas.example.com/', [lan])
    expect(plan.state).toBe('external')
    expect(plan.baseOrigin).toBe('https://nas.example.com')
    expect(plan.candidates).toEqual([])
    expect(relayStatusTone(plan.state)).toBe('green')
  })

  it('回环 + 局域网候选：自动态 baseOrigin = 浏览器地址栏 origin（不再改写）', () => {
    const plan = buildRelayPlan('http://localhost:9999/project?x=1#L2', '', [pub, lan2, lan])
    expect(plan.state).toBe('loopback')
    expect(plan.baseOrigin).toBe('http://localhost:9999')
    // 候选清单 = 降权展示序（排序只管下拉顺序，不管链接地址）
    expect(plan.candidates.map(a => a.ip)).toEqual(['10.0.0.8', '192.168.1.50', '203.0.113.7'])
    expect(relayStatusTone(plan.state)).toBe('red')
  })

  // P-20261120-4 一致性修复实锚（用户截图二场景）：下拉选全球单播 IPv6
  //（240e… 非 RFC1918/ULA → score 3）曾被排序重排覆盖回私网 IPv4 首项——
  // preferredIp 钉住显式选择，hint/链接框/QR 码三方同源
  it('显式选择钉住 baseOrigin：选公网 IPv6 不被排序覆盖回落私网 v4', () => {
    const v6global: NetworkAddress = { ip: '240e:1234:5678:9abc::5', family: 'v6', iface: 'WLAN', private: false }
    const priv4: NetworkAddress = { ip: '192.168.2.7', family: 'v4', iface: 'WLAN', private: true }
    const plan = buildRelayPlan('http://localhost:19999/', '', [priv4, v6global], { preferredIp: '240e:1234:5678:9abc::5' })
    expect(plan.state).toBe('loopback')
    expect(plan.baseOrigin).toBe('http://[240e:1234:5678:9abc::5]:19999')
    // 展示序不受影响：私网 v4 在前（score 0 < 3）
    expect(plan.candidates.map(a => a.ip)).toEqual(['192.168.2.7', '240e:1234:5678:9abc::5'])
  })

  it('显式选择的 ip 不在候选中（stale）→ 回落自动态（当前 origin）', () => {
    const plan = buildRelayPlan('http://localhost:9999/', '', [lan], { preferredIp: '10.9.9.9' })
    expect(plan.state).toBe('loopback')
    expect(plan.baseOrigin).toBe('http://localhost:9999')
  })

  it('回环合成项：置尾追加 + 显式选中回环 ip → 对应回环 origin', () => {
    const extras = loopbackSelfCandidates('本机')
    expect(extras.map(a => a.ip)).toEqual(['127.0.0.1', 'localhost'])
    const plan = buildRelayPlan('http://localhost:9999/', '', [lan], { loopbackExtras: extras })
    // LAN 在前、回环合成项垫底（LAN 切换一步可达）
    expect(plan.candidates.map(a => a.ip)).toEqual(['192.168.1.50', '127.0.0.1', 'localhost'])
    // 自动态仍 = 浏览器地址
    expect(plan.baseOrigin).toBe('http://localhost:9999')
    // 选中 127.0.0.1 / localhost → 各自的 origin（candidateOrigin 拼装）
    expect(buildRelayPlan('http://localhost:9999/', '', [lan], { preferredIp: '127.0.0.1', loopbackExtras: extras }).baseOrigin)
      .toBe('http://127.0.0.1:9999')
    expect(buildRelayPlan('http://localhost:9999/', '', [lan], { preferredIp: 'localhost', loopbackExtras: extras }).baseOrigin)
      .toBe('http://localhost:9999')
  })

  it('回环合成项与网卡枚举去重：重复 ip 不重复入列', () => {
    const dup: NetworkAddress = { ip: '127.0.0.1', family: 'v4', iface: 'lo0', private: true }
    const plan = buildRelayPlan('http://localhost:9999/', '', [dup], { loopbackExtras: loopbackSelfCandidates('本机') })
    expect(plan.candidates.map(a => a.ip)).toEqual(['127.0.0.1', 'localhost'])
  })

  it('回环无候选且无合成项 → 不可达（收窄保留覆盖：仅纯函数层直调触达）', () => {
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
