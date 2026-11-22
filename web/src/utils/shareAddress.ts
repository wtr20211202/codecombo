// 分享链接地址计划（P-20261020-2，并集 P-20261020-6 的局域网候选选址）：
// 结果卡、分享管理器复制/打开、二维码与 agent 直播邀请通知共用同一套选址
// 纯函数——消除「邀请链接一个口径、二维码另一个口径」。选址优先级与二维码
// 接力（utils/networkAddress，P-20261019-10）同一语义：
//
//   1. 配置了分享外发基址（settings.sharePublicBaseUrl）→ 用它（显式意图最高）；
//   2. 配置了外部访问地址（settings.externalAccessUrl）→ 用它；
//   3. 当前 host 非回环（局域网 IP / 公网域名）→ 用当前 origin；
//   4. 当前为回环（localhost）→ 默认用浏览器地址栏 origin（P-20261120-4：
//      本机访问场景链接即当前地址；要发给别人时在下拉显式切局域网候选或
//      回环合成项），徽标保持「本机回环」红态（回环链接不能承诺对端可达）；
//   5. 无可达基址 → 旧格式回退「当前 host + 分享子服务端口」并标红
//      「仅本机可达」（本机自测仍可打开，发给他人必死；回环合成候选恒可用，
//      该分支收窄为地址计划本身的降级路径）。
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
  type RelayPlanOptions,
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
  | 'loopbackSelf' // 回环本源（P-20261120-4：自动态/显式选回环——链接即浏览器地址）
  | 'candidate' // 回环入口下显式选择的局域网候选
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
  /** 用户显式选择的候选 ip（含回环合成项）；空 = 自动态（P-20261120-4） */
  preferredIp?: string
  /** 回环合成候选（label 已 i18n 解析）；回环入口下置尾追加进候选清单 */
  loopbackExtras?: NetworkAddress[]
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

  const relayOptions: RelayPlanOptions = {
    preferredIp: ctx.preferredIp,
    loopbackExtras: ctx.loopbackExtras,
  }
  const relay = buildRelayPlan(ctx.currentHref, ctx.externalAccessUrl || '', ctx.addresses || [], relayOptions)
  switch (relay.state) {
    case 'external':
      return { state: 'external', source: 'external', baseOrigin: relay.baseOrigin, candidates: [] }
    case 'public':
      return { state: 'public', source: 'current', baseOrigin: relay.baseOrigin, candidates: [] }
    case 'lan':
      return { state: 'lan', source: 'current', baseOrigin: relay.baseOrigin, candidates: [] }
    case 'loopback': {
      // 来源按解析出的 baseOrigin 主机归类：回环本源（自动态或显式选回环合成
      // 项）vs 显式选中的局域网候选——文案与复制警示分形（P-20261120-4 评审
      // 必改3：新默认态沿用 'candidate' 会得到「按本机网卡地址生成」的失实描述）
      const hostname = new URL(relay.baseOrigin).hostname
      const source: ShareAddressSource = isLoopbackHostname(hostname) ? 'loopbackSelf' : 'candidate'
      // state 保持 loopback（红色）：回环本源=外机必失败；显式局域网候选=不能
      // 承诺对端与服务器同一网络——徽标红语义不变，细分文案在 hint/copyWarn
      return { state: 'loopback', source, baseOrigin: relay.baseOrigin, candidates: relay.candidates }
    }
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

/** 复制可达性警示档位（对应 i18n `share.copyWarn.*`；null = 不警示） */
export type ShareCopyWarn = 'loopbackSelf' | 'candidate' | 'legacy'

/**
 * 复制动作的可达性警示判定（P-20261119-7 评审必改3/必改4；P-20261120-4 评审
 * 必改3 扩档：判定函数单一事实源，管理器/二维码面板/交接包各复制面共用，
 * 防 N 处条件漂移）。
 *
 * 回环入口下三种来源需要警示：
 *   - loopbackSelf=回环本源链接（自动态默认=浏览器地址，或显式选回环合成项）：
 *     对方无法访问——本机自测正配套；文案同 quickdropLoopback 形态；
 *   - candidate=显式选择的局域网候选链接：地址已不是 localhost，但不能承诺
 *     对端与服务器同一网络（多网卡机器上也可能选错网卡）；
 *   - legacy=旧格式 host:sharePort：host 来自当前回环入口，对方必失败。
 * publicBase（显式配置的基址）即使指向回环也不在复制面重复打扰——该形态已有
 * 专用 hint（publicBaseLoopback）且正确处置是改配置，显式意图优先；非回环态
 * （current/external）本就可达；unreachable 时 url 为空、调用方复制前已早退，
 * 警示天然不触达。
 */
export function shouldWarnCopy(plan: ShareAddressBasePlan): ShareCopyWarn | null {
  if (plan.state !== 'loopback') return null
  if (plan.source === 'loopbackSelf' || plan.source === 'candidate' || plan.source === 'legacy') {
    return plan.source
  }
  return null
}
