// 二维码接力地址选择（P-20261019-10）：把「当前从哪里打开」映射为手机可达的
// 二维码目标。纯函数族便于单测——组件只负责取值/渲染。
//
// 三类部署形态：
//   - 配置了外部访问地址（Tailscale/Cloudflare Tunnel/公网反代）→ 用它；
//   - 当前 host 非回环（局域网 IP / 公网域名）→ 用当前 origin；
//   - 当前为回环（桌面端 localhost 最常见）→ 用 /api/system/network 返回的
//     局域网候选（多网卡下拉，默认第一项）；无候选 → 不可达态。

export interface NetworkAddress {
  ip: string
  family: 'v4' | 'v6'
  iface: string
  private: boolean
}

/** 二维码目标的可达性分类（决定徽标颜色与提示文案） */
export type RelayAccessState = 'external' | 'public' | 'lan' | 'loopback' | 'unreachable'

export interface RelayAddressPlan {
  state: RelayAccessState
  /** 用于拼二维码的 origin（不含尾斜杠）；unreachable 时为空串 */
  baseOrigin: string
  /** 回环入口下的局域网候选（stable 排序，首项即默认） */
  candidates: NetworkAddress[]
}

export type ExternalAccessUrlError = 'scheme' | 'credentials' | 'path' | 'query' | 'fragment' | 'invalid'

export interface ExternalAccessUrlResult {
  /** 归一后的 origin（空串 = 未配置）；非法时为空串 */
  url: string
  error: ExternalAccessUrlError | null
}

/** 去方括号/小写的主机名比较形态（URL.hostname 对 IPv6 带方括号） */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/** IPv4 点分十进制解析；非四段数字返回 null */
function ipv4Parts(host: string): [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map(p => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (!nums.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return null
  return nums as [number, number, number, number]
}

/** 本机回环 / 未指定地址：手机扫码后都指向手机自己，必须换地址 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = bareHost(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  const v4 = ipv4Parts(host)
  return v4 !== null && v4[0] === 127
}

/**
 * 主机是否属「非公网可路由」形态：用于非回环入口与候选地址的黄/绿分类。
 * 覆盖 RFC1918、IPv6 ULA、链路本地、CGNAT（Tailscale 100.64/10）与单标签
 * 主机名/.local（mDNS 局域网名）。公网域名/公网 IP 返回 false。
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = bareHost(hostname)
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.includes(':')) {
    // IPv6：ULA fc00::/7、链路本地 fe80::/10、回环（按首 hextet 判，
    // 兼容「fc::」「fe8::」压缩写法）
    const firstHextet = Number.parseInt(host.split(':')[0] || '0', 16)
    if (Number.isFinite(firstHextet)) {
      if ((firstHextet & 0xfe00) === 0xfc00) return true
      if ((firstHextet & 0xffc0) === 0xfe80) return true
    }
    return host === '::1'
  }
  const v4 = ipv4Parts(host)
  if (v4) {
    if (v4[0] === 10 || v4[0] === 127) return true
    if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return true
    if (v4[0] === 192 && v4[1] === 168) return true
    if (v4[0] === 169 && v4[1] === 254) return true
    // CGNAT 100.64.0.0/10（Tailscale 等 overlay 网段）
    if (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127) return true
    return false
  }
  // 域名形态：.local 或单标签主机名（如 nas）按局域网处理；公网域名含点
  return host.endsWith('.local') || !host.includes('.')
}

/**
 * 校验并归一外部访问地址（与服务端 config.NormalizeExternalAccessURL 同规则）：
 * 仅 http/https origin，无凭据/路径/query/fragment，尾斜杠与默认端口归一。
 * 与服务端双保险：设置页保存前早反馈，已有脏值也不会污染二维码。
 */
export function normalizeExternalAccessUrl(raw: string): ExternalAccessUrlResult {
  const v = raw.trim()
  if (!v) return { url: '', error: null }
  if (/\s/.test(v)) return { url: '', error: 'invalid' }
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return { url: '', error: 'invalid' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { url: '', error: 'scheme' }
  if (u.username || u.password) return { url: '', error: 'credentials' }
  // WHATWG URL 会把空 query（"?"）归一成空 search，裸字符检查兜住该形态
  if (v.includes('?')) return { url: '', error: 'query' }
  if (v.includes('#')) return { url: '', error: 'fragment' }
  if (u.pathname !== '' && u.pathname !== '/') return { url: '', error: 'path' }
  if (u.search !== '') return { url: '', error: 'query' }
  if (u.hash !== '') return { url: '', error: 'fragment' }
  if (!u.hostname) return { url: '', error: 'invalid' }
  // URL.host 会丢弃默认端口（:80/:443），天然完成归一
  return { url: `${u.protocol}//${u.host}`, error: null }
}

/** IPv6 字面量拼 URL 必须带方括号 */
export function formatUrlHost(ip: string): string {
  return ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip
}

/** 候选排序：私有地址优先、v4 优先，同族按地址数值序（稳定默认首项） */
export function sortRelayCandidates(addresses: NetworkAddress[]): NetworkAddress[] {
  const seen = new Set<string>()
  const deduped: NetworkAddress[] = []
  for (const a of addresses) {
    if (!a || !a.ip || seen.has(a.ip)) continue
    seen.add(a.ip)
    deduped.push(a)
  }
  const score = (a: NetworkAddress) => (a.private ? 0 : 2) + (a.family === 'v4' ? 0 : 1)
  const v4Value = (ip: string) => {
    const parts = ipv4Parts(ip)
    if (!parts) return null
    const [a, b, c, d] = parts
    return (((a * 256 + b) * 256 + c) * 256 + d)
  }
  return deduped.sort((a, b) => {
    if (score(a) !== score(b)) return score(a) - score(b)
    const av = v4Value(a.ip)
    const bv = v4Value(b.ip)
    if (av !== null && bv !== null && av !== bv) return av - bv
    if (av === null || bv === null) {
      if (av !== null) return -1
      if (bv !== null) return 1
    }
    if (a.ip !== b.ip) return a.ip < b.ip ? -1 : 1
    return a.iface < b.iface ? -1 : a.iface > b.iface ? 1 : 0
  })
}

/** 用当前页面的协议/端口 + 指定候选 IP 拼 origin */
export function candidateOrigin(currentHref: string, address: NetworkAddress): string {
  const u = new URL(currentHref)
  return `${u.protocol}//${formatUrlHost(address.ip)}${u.port ? `:${u.port}` : ''}`
}

/**
 * 生成地址计划。当前 URL 不可解析时按不可达处理（弹窗仍可展示提示）。
 * external 优先于一切——用户显式配置的外部入口应压过自动推断。
 */
export function buildRelayPlan(
  currentHref: string,
  externalAccessUrl: string,
  addresses: NetworkAddress[],
): RelayAddressPlan {
  let current: URL
  try {
    current = new URL(currentHref)
  } catch {
    return { state: 'unreachable', baseOrigin: '', candidates: [] }
  }
  const external = normalizeExternalAccessUrl(externalAccessUrl).url
  if (external) {
    return { state: 'external', baseOrigin: external, candidates: [] }
  }
  if (!isLoopbackHostname(current.hostname)) {
    return {
      state: isPrivateHostname(current.hostname) ? 'lan' : 'public',
      baseOrigin: current.origin,
      candidates: [],
    }
  }
  const candidates = sortRelayCandidates(addresses)
  if (candidates.length === 0) {
    return { state: 'unreachable', baseOrigin: '', candidates: [] }
  }
  return {
    state: 'loopback',
    baseOrigin: candidateOrigin(currentHref, candidates[0] as NetworkAddress),
    candidates,
  }
}

/**
 * 拼最终二维码 URL：baseOrigin + 当前路由/search/hash。
 * 关闭「携带当前位置」时指向 baseOrigin 根入口（origin + "/"）。
 * baseOrigin 与当前 origin 相同时直接返回原 href，保留浏览器原始形态。
 */
export function buildRelayUrl(currentHref: string, baseOrigin: string, carryLocation: boolean): string {
  if (!baseOrigin) return ''
  const base = baseOrigin.replace(/\/+$/, '')
  if (!carryLocation) return `${base}/`
  let current: URL
  try {
    current = new URL(currentHref)
  } catch {
    return `${base}/`
  }
  if (current.origin === base) return currentHref
  return `${base}${current.pathname || '/'}${current.search}${current.hash}`
}

/** 徽标语义色三态：红=扫描必失败/不可达，黄=需同网，绿=任意网络 */
export function relayStatusTone(state: RelayAccessState): 'red' | 'yellow' | 'green' {
  if (state === 'loopback' || state === 'unreachable') return 'red'
  if (state === 'lan') return 'yellow'
  return 'green'
}
