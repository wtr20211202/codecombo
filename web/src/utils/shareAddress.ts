// 分享链接地址计划（P-20261020-2，并集 P-20261020-6 的局域网候选选址）：
// 结果卡、分享管理器复制/打开、二维码与 agent 直播邀请通知共用同一套选址
// 纯函数——消除「邀请链接一个口径、二维码另一个口径」。选址优先级与二维码
// 接力（utils/networkAddress，P-20261019-10）同一语义：
//
//   1. 配置了分享外发基址（settings.sharePublicBaseUrl）→ 用它（显式意图最高）；
//   2. 配置了外部访问地址（settings.externalAccessUrl）→ 用它；
//   3. 当前 host 非回环（局域网 IP / 公网域名）→ 用当前 origin；
//   4. 当前为回环（localhost）→ 用 /api/system/network 的局域网候选（首项），
//      徽标保持「本机回环」红态（与二维码接力一致：能自动改地址，但不能保证
//      对端同网）；
//   5. 无可达基址 → 旧格式回退「当前 host + 分享子服务端口」并标红
//      「仅本机可达」（本机自测仍可打开，发给他人必死）。
//
// 阶段 B 起主应用同源代理 /s/*（server/api/router.go），因此 2~4 的路径是
// `<base>/s/<token>`——反代/隧道只需转发主端口；只有回退 5 才依赖 sharePort。
// 纯函数便于单测，组件只负责取值/渲染。

import {
  buildRelayPlan,
  isLoopbackHostname,
  isPrivateHostname,
  normalizeExternalAccessUrl,
  relayStatusTone,
  type NetworkAddress,
  type RelayAccessState,
} from './networkAddress'

/** 分享子服务就绪态的结构子集（与 api/domains/share 的 ShareServiceStatus 兼容） */
export interface ShareServiceStatusLike {
  running: boolean
  port: number
  scheme: '' | 'http' | 'https'
}

/** 当前分享基址的来源（决定徽标文案，不影响颜色语义） */
export type ShareAddressSource =
  | 'publicBase' // settings.sharePublicBaseUrl
  | 'external' // settings.externalAccessUrl
  | 'current' // 当前非回环 origin
  | 'candidate' // 回环入口下的局域网候选
  | 'legacy' // 旧格式：host + sharePort
  | ''

export interface ShareAddressContext {
  /** 当前页面 href（window.location.href；定格后多入口共用） */
  currentHref: string
  status: ShareServiceStatusLike
  /** settings.sharePublicBaseUrl（仅 origin；空 = 未配置） */
  publicBaseUrl?: string
  /** settings.externalAccessUrl（仅 origin；空 = 未配置） */
  externalAccessUrl?: string
  /** /api/system/network 的局域网候选（回环入口下才使用） */
  addresses?: NetworkAddress[]
}

export interface ShareAddressBasePlan {
  state: RelayAccessState
  source: ShareAddressSource
  /** 用于拼分享链接的 origin（不含尾斜杠）；unreachable 时为空串 */
  baseOrigin: string
  candidates: NetworkAddress[]
}

export interface ShareAddressPlan extends ShareAddressBasePlan {
  /** 完整访客短链；空串 = 服务未就绪/无可达基址（调用方提示 serviceDown） */
  url: string
  /** true = 走了旧格式 host:sharePort（不依赖主应用同源代理） */
  legacy: boolean
}

/** 显式配置的基址按 host 属性归类：回环红 / 私网黄 / 其余绿 */
function configuredBase(raw: string): { baseOrigin: string; state: RelayAccessState } | null {
  const base = normalizeExternalAccessUrl(raw).url
  if (!base) return null
  let hostname: string
  try {
    hostname = new URL(base).hostname
  } catch {
    return null
  }
  if (isLoopbackHostname(hostname)) return { baseOrigin: base, state: 'loopback' }
  if (isPrivateHostname(hostname)) return { baseOrigin: base, state: 'lan' }
  return { baseOrigin: base, state: 'external' }
}

/** 旧格式回退 origin：host 取当前页面主机名 + 分享子服务端口（改造前口径） */
function legacyShareOrigin(ctx: ShareAddressContext): string {
  if (!ctx.status?.running || !ctx.status.port) return ''
  try {
    const u = new URL(ctx.currentHref)
    const scheme = ctx.status.scheme || (u.protocol === 'https:' ? 'https' : 'http')
    return `${scheme}://${u.hostname}:${ctx.status.port}`
  } catch {
    return ''
  }
}

/**
 * 生成与 token 无关的基址计划（管理器的全局徽标只需这一层）。
 * status 未就绪 → unreachable（任何链接都还没有可用的落点）。
 */
export function buildShareBasePlan(ctx: ShareAddressContext): ShareAddressBasePlan {
  const unreachable: ShareAddressBasePlan = { state: 'unreachable', source: '', baseOrigin: '', candidates: [] }
  if (!ctx.status?.running) return unreachable

  const publicBase = configuredBase(ctx.publicBaseUrl || '')
  if (publicBase) return { ...publicBase, source: 'publicBase', candidates: [] }

  const relay = buildRelayPlan(ctx.currentHref, ctx.externalAccessUrl || '', ctx.addresses || [])
  switch (relay.state) {
    case 'external':
      return { state: 'external', source: 'external', baseOrigin: relay.baseOrigin, candidates: [] }
    case 'public':
      return { state: 'public', source: 'current', baseOrigin: relay.baseOrigin, candidates: [] }
    case 'lan':
      return { state: 'lan', source: 'current', baseOrigin: relay.baseOrigin, candidates: [] }
    case 'loopback':
      // 候选首项已在 relay.baseOrigin；state 保持 loopback（红色）——与二维码
      // 接力提示一致：地址已自动切换，但不能承诺对端与服务器同一网络
      return { state: 'loopback', source: 'candidate', baseOrigin: relay.baseOrigin, candidates: relay.candidates }
    default: {
      const legacyOrigin = legacyShareOrigin(ctx)
      if (legacyOrigin) return { state: 'loopback', source: 'legacy', baseOrigin: legacyOrigin, candidates: [] }
      return unreachable
    }
  }
}

/** 生成某条分享的完整访客短链（URL 计算唯一入口） */
export function buildShareAddressPlan(token: string, ctx: ShareAddressContext): ShareAddressPlan {
  const base = buildShareBasePlan(ctx)
  if (!base.baseOrigin) return { ...base, url: '', legacy: base.source === 'legacy' }
  const origin = base.baseOrigin.replace(/\/+$/, '')
  return { ...base, url: `${origin}/s/${token}`, legacy: base.source === 'legacy' }
}

/** 徽标三色：红=扫描/发送必失败或需本机网络，黄=需同一网络，绿=任意网络 */
export function shareReachTone(state: RelayAccessState): 'red' | 'yellow' | 'green' {
  return relayStatusTone(state)
}
