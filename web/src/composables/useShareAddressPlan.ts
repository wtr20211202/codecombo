// 分享地址计划（P-20261020-6 / P-20261020-2 统一实现）：结果卡、管理器复制/
// 打开与二维码共用同一份 URL 计算。选址纯函数在 utils/shareAddress（阶段 A：
// sharePublicBaseUrl > externalAccessUrl > 当前非回环 host > 回环入口选址 >
// 旧格式 host:sharePort；前四类走主应用同源 /s/）。设置/网络/子服务状态一次
// 并行拉取，失败降级为不可达提示，不向调用方抛错（分享链接是低频交互，可
// 重试即可）。回环入口下（P-20261120-4）：selectedIP 空 = 「自动（浏览器
// 地址）」态——链接即当前回环 origin；用户显式选择经 preferredIp 语义参数
// 传给纯函数（不再「重排候选首位」——那是下拉与链接框不一致 bug 的根因），
// 复制/二维码/链接框三方同源同一 baseOrigin。
import { computed, ref, watch } from 'vue'
import { shareApi, type ShareServiceStatus } from '../api/domains/share'
import { networkApi, settingsApi } from '../api/domains/system'
import { useI18n } from './useI18n'
import { loopbackSelfCandidates, type NetworkAddress } from '../utils/networkAddress'
import {
  buildShareAddressPlan,
  buildShareBasePlan,
  shareReachTone,
  type ShareAddressContext,
} from '../utils/shareAddress'

const EMPTY_STATUS: ShareServiceStatus = { running: false, port: 0, scheme: '' }

export function useShareAddressPlan() {
  const { t } = useI18n()
  const loading = ref(false)
  const networkFailed = ref(false)
  const status = ref<ShareServiceStatus>({ ...EMPTY_STATUS })
  const currentHref = ref('')
  const externalAccessUrl = ref('')
  const publicBaseUrl = ref('')
  const addresses = ref<NetworkAddress[]>([])
  // '' = 「自动（浏览器地址）」态：回环入口下链接用当前 origin；显式选择后
  // 存候选 ip。不再在加载时强制赋首项——那会让「默认=浏览器地址」永远不成立
  const selectedIP = ref('')

  /** 回环合成候选（127.0.0.1/localhost）：不依赖后端枚举，label 随语言即时解析 */
  const loopbackExtras = computed<NetworkAddress[]>(() => loopbackSelfCandidates(t('share.qr.selfLoopback')))

  /** 拉取选址上下文（分享外发基址/外部地址 + 本机网卡候选 + 子服务状态）。
   *  失败静默：弹层内以不可达/未就绪文案呈现，不再叠全局 toast */
  async function load(): Promise<void> {
    loading.value = true
    networkFailed.value = false
    currentHref.value = window.location.href
    const [statusResult, settingsResult, networkResult] = await Promise.allSettled([
      shareApi.status(),
      settingsApi.get({ silent: true }),
      networkApi.list({ silent: true }),
    ])
    if (statusResult.status === 'fulfilled') {
      const res = statusResult.value as unknown as { data?: ShareServiceStatus }
      status.value = res?.data ?? { ...EMPTY_STATUS }
    } else {
      status.value = { ...EMPTY_STATUS }
    }
    if (settingsResult.status === 'fulfilled') {
      const res = settingsResult.value as unknown as {
        data?: { externalAccessUrl?: string; sharePublicBaseUrl?: string }
      }
      externalAccessUrl.value = res?.data?.externalAccessUrl || ''
      publicBaseUrl.value = res?.data?.sharePublicBaseUrl || ''
    } else {
      externalAccessUrl.value = ''
      publicBaseUrl.value = ''
    }
    if (networkResult.status === 'fulfilled') {
      const res = networkResult.value as unknown as { data?: NetworkAddress[] }
      addresses.value = Array.isArray(res?.data) ? res.data : []
    } else {
      addresses.value = []
      networkFailed.value = true
    }
    loading.value = false
  }

  /** 原始上下文（不含用户选择）：用于生成候选清单；回环合成项随语境注入 */
  const baseContext = computed<ShareAddressContext>(() => ({
    currentHref: currentHref.value,
    status: status.value,
    publicBaseUrl: publicBaseUrl.value,
    externalAccessUrl: externalAccessUrl.value,
    addresses: addresses.value,
    loopbackExtras: loopbackExtras.value,
  }))

  const rawPlan = computed(() => buildShareBasePlan(baseContext.value))
  const candidates = computed(() => rawPlan.value.candidates)

  // 候选变化（重载/切网）时只把失效的显式选择复位回自动态，保证下拉与链接
  // 一致；绝不强制赋首项（P-20261120-4 评审必改1：强制赋首项与「默认=浏览器
  // 地址」互斥）
  watch(candidates, (list) => {
    if (selectedIP.value && !list.some(a => a.ip === selectedIP.value)) {
      selectedIP.value = ''
    }
  }, { immediate: true })

  /** 当前显式选中的候选；自动态为 null（不假装选中首项——hint 与链接必须
   *  走同一份 baseOrigin，避免「hint 同步了链接没同步」的分叉复发） */
  const selectedAddress = computed<NetworkAddress | null>(() => {
    if (!selectedIP.value) return null
    return candidates.value.find(a => a.ip === selectedIP.value) ?? null
  })

  /** 用户显式选择经 preferredIp 传给纯函数：baseOrigin 钉住所选候选 origin；
   *  自动态（''）= 回环入口用浏览器地址栏 origin。链接/二维码/hint 同源 */
  const activeContext = computed<ShareAddressContext>(() => ({
    ...baseContext.value,
    preferredIp: selectedIP.value,
  }))

  const plan = computed(() => buildShareBasePlan(activeContext.value))
  const statusTone = computed(() => shareReachTone(plan.value.state))
  const statusKey = computed(() => `share.qr.status.${plan.value.state}`)

  const hint = computed(() => {
    // 显式配置的基址优先用 P-2 的来源细分文案（回环配置与自动选址失败是
    // 两种处境：前者改配置即可，后者先要配置）
    if (plan.value.source === 'publicBase') {
      return t(plan.value.state === 'loopback'
        ? 'share.reach.hint.publicBaseLoopback'
        : 'share.reach.hint.publicBase')
    }
    switch (plan.value.state) {
      case 'external': return t('share.qr.hint.external')
      case 'public': return t('share.qr.hint.public')
      case 'lan': return t('share.qr.hint.lan')
      case 'unreachable':
        return networkFailed.value ? t('share.qr.hint.networkFailed') : t('share.qr.hint.unreachable')
      default:
        if (plan.value.source === 'legacy') return t('share.reach.hint.legacy')
        // 回环本源（自动态默认/显式选回环）与显式选局域网候选是两种处境：
        // 前者「要发给别人先在下面切地址」，后者「对方需同网」——双语境区分
        if (plan.value.source === 'loopbackSelf') return t('share.qr.hint.loopbackSelf')
        return t('share.qr.hint.loopback', { ip: selectedAddress.value?.ip || '' })
    }
  })

  /** 单条分享记录的访客短链（token 是记录唯一变量；地址与端口共用计划） */
  function urlOf(token: string): string {
    if (!token) return ''
    return buildShareAddressPlan(token, activeContext.value).url
  }

  return {
    loading,
    networkFailed,
    status,
    plan,
    candidates,
    selectedIP,
    statusTone,
    statusKey,
    hint,
    urlOf,
    load,
  }
}
