// 分享地址计划（P-20261020-6 / P-20261020-2 统一实现）：结果卡、管理器复制/
// 打开与二维码共用同一份 URL 计算。选址纯函数在 utils/shareAddress（阶段 A：
// sharePublicBaseUrl > externalAccessUrl > 当前非回环 host > 局域网候选 >
// 旧格式 host:sharePort；前四类走主应用同源 /s/）。设置/网络/子服务状态一次
// 并行拉取，失败降级为不可达提示，不向调用方抛错（分享链接是低频交互，可
// 重试即可）。回环入口下用户选择的局域网候选通过「重排候选首位」传给纯函数，
// 避免复制/二维码与下拉选择各算各的。
import { computed, ref, watch } from 'vue'
import { shareApi, type ShareServiceStatus } from '../api/domains/share'
import { networkApi, settingsApi } from '../api/domains/system'
import { useI18n } from './useI18n'
import type { NetworkAddress } from '../utils/networkAddress'
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
  const selectedIP = ref('')

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

  /** 原始上下文（候选顺序未调整）：用于生成候选清单与默认首项 */
  const baseContext = computed<ShareAddressContext>(() => ({
    currentHref: currentHref.value,
    status: status.value,
    publicBaseUrl: publicBaseUrl.value,
    externalAccessUrl: externalAccessUrl.value,
    addresses: addresses.value,
  }))

  const rawPlan = computed(() => buildShareBasePlan(baseContext.value))
  const candidates = computed(() => rawPlan.value.candidates)

  // 候选变化（重载/切网）时把失效选择复位，保证下拉与链接一致
  watch(candidates, (list) => {
    if (list.length === 0) {
      selectedIP.value = ''
      return
    }
    if (!list.some(a => a.ip === selectedIP.value)) {
      selectedIP.value = list[0]?.ip ?? ''
    }
  }, { immediate: true })

  const selectedAddress = computed<NetworkAddress | null>(() => {
    const list = candidates.value
    if (list.length === 0) return null
    return list.find(a => a.ip === selectedIP.value) ?? list[0] ?? null
  })

  /** 用户选中的候选置首后交给纯函数：buildShareBasePlan 取 candidates[0]
   *  作为回环入口的 baseOrigin，复制/二维码随下拉即时切换 */
  const activeContext = computed<ShareAddressContext>(() => {
    const sel = selectedAddress.value
    if (!sel || candidates.value.length <= 1) return baseContext.value
    return {
      ...baseContext.value,
      addresses: [sel, ...addresses.value.filter(a => a.ip !== sel.ip)],
    }
  })

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
