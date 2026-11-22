<script setup lang="ts">
// 二维码接力（P-20261002-59）：把当前页完整 URL 渲染成二维码，手机扫码直达
// 同一工作位置。入口：命令面板「在手机上打开」+ 顶栏按钮（Layout 宿主渲染）。
//
// 地址选择（P-20261019-10）：直接编码 window.location.href 在桌面端以
// localhost 打开时，二维码会指向手机自己的回环地址——必然失败且无提示。
// 这里按三形态选址（utils/networkAddress 纯函数）：
//   配置了外部访问地址 → 用它（Tailscale/Cloudflare Tunnel/公网反代）；
//   当前 host 非回环 → 用当前 origin；
//   当前为回环 → 默认用浏览器地址栏 origin 本身（P-20261120-4：本机访问场景
//     链接即当前地址），要发给别人时在下拉显式切换局域网候选或回环合成项；
//   既无候选也未选择 → 红色不可达提示，不再发出注定打不开的码。
import { computed, ref, watch } from 'vue'
import { NModal, NButton, NCheckbox, NInput, NIcon, NQrCode, NSelect, NSpin, useMessage } from 'naive-ui'
import { CopyOutline, PhonePortraitOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useLockStore } from '../../stores/lock'
import { settingsApi, networkApi } from '../../api/domains/system'
import { copyText } from '../../utils/clipboard'
import {
  buildRelayPlan,
  buildRelayUrl,
  isLoopbackHostname,
  loopbackSelfCandidates,
  relayStatusTone,
  type NetworkAddress,
} from '../../utils/networkAddress'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [v: boolean] }>()

const { t } = useI18n()
const message = useMessage()
const lockStore = useLockStore()

// URL 在弹窗打开瞬间定格：模态遮罩下会话不再导航，定格保证码内容与
// 下方文本、剪贴板三者一致；携带开关每次打开复位为默认开（= 深链现状），
// 让每次扫码意图显式重审而非沿用上次选择
const carryLocation = ref(true)
const frozenHref = ref('')
const externalAccessUrl = ref('')
const networkAddresses = ref<NetworkAddress[]>([])
const selectedIP = ref('')
const networkFailed = ref(false)
const loading = ref(false)

async function loadAddressContext() {
  loading.value = true
  networkFailed.value = false
  // 静默拉取：失败在弹窗内以「不可达」提示呈现，不再叠一层全局 toast。
  // externalAccessUrl 来自既有设置 API；网络清单来自只读端点，两者互不阻塞
  const [settingsResult, networkResult] = await Promise.allSettled([
    settingsApi.get({ silent: true }),
    networkApi.list({ silent: true }),
  ])
  if (settingsResult.status === 'fulfilled') {
    const res = settingsResult.value as { data?: { externalAccessUrl?: string } }
    externalAccessUrl.value = res?.data?.externalAccessUrl || ''
  } else {
    externalAccessUrl.value = ''
  }
  if (networkResult.status === 'fulfilled') {
    const res = networkResult.value as { data?: NetworkAddress[] }
    networkAddresses.value = Array.isArray(res?.data) ? res.data : []
  } else {
    networkAddresses.value = []
    networkFailed.value = true
  }
  loading.value = false
}

watch(() => props.show, (v) => {
  if (!v) return
  carryLocation.value = true
  frozenHref.value = window.location.href
  selectedIP.value = ''
  networkAddresses.value = []
  externalAccessUrl.value = ''
  void loadAddressContext()
}, { immediate: true })

const plan = computed(() => buildRelayPlan(frozenHref.value, externalAccessUrl.value, networkAddresses.value, {
  preferredIp: selectedIP.value,
  loopbackExtras: loopbackSelfCandidates(t('qr.relay.selfLoopback')),
}))
const candidates = computed(() => plan.value.candidates)

// 候选变化（刷新/重开）时只把失效的显式选择复位回自动态；绝不强制赋首项
// （P-20261120-4：默认=浏览器地址，首项劫持会让自动态永远不成立）
watch(candidates, (list) => {
  if (selectedIP.value && !list.some(a => a.ip === selectedIP.value)) {
    selectedIP.value = ''
  }
}, { immediate: true })

/** 当前显式选中的候选；自动态为 null（hint 与链接同走 plan.baseOrigin，
 *  不再有「hint 已切、链接没切」的两条路） */
const selectedAddress = computed<NetworkAddress | null>(() => {
  if (!selectedIP.value) return null
  return candidates.value.find(a => a.ip === selectedIP.value) ?? null
})

// baseOrigin 已内含显式选择语义（preferredIp 钉住 / 自动态=当前 origin）：
// 码/文本框/剪贴板三方同源这一份 origin
const url = computed(() => buildRelayUrl(frozenHref.value, plan.value.baseOrigin, carryLocation.value))

// 首项「自动（当前浏览器地址）」伪选项：自动态可见可选，显式选择后仍可切回
const candidateOptions = computed(() => [
  { label: t('qr.relay.addressAuto'), value: '' },
  ...candidates.value.map(a => ({
    label: `${a.iface} · ${a.ip}`,
    value: a.ip,
  })),
])

const statusTone = computed(() => relayStatusTone(plan.value.state))
const statusKey = computed(() => `qr.relay.status.${plan.value.state}`)

const hint = computed(() => {
  switch (plan.value.state) {
    case 'external': return t('qr.relay.hint.external')
    case 'public': return t('qr.relay.hint.public')
    case 'lan': return t('qr.relay.hint.lan')
    case 'unreachable':
      return networkFailed.value ? t('qr.relay.hint.networkFailed') : t('qr.relay.hint.unreachable')
    default: {
      // 回环本源（自动态默认/显式选回环合成项）与显式选局域网候选双语境区分；
      // 按 baseOrigin 主机归类，与 shareAddress 的 source 判定同一规则
      const loopbackSelf = !selectedAddress.value || isLoopbackHostname(new URL(plan.value.baseOrigin).hostname)
      if (loopbackSelf) return t('qr.relay.hint.loopbackSelf')
      return t('qr.relay.hint.loopback', { ip: selectedAddress.value?.ip || '' })
    }
  }
})

// 明文告警看二维码目标协议（不是当前页面）：回环下切到 https 外部地址后
// 不再误报「链接未加密」
const plainHttp = computed(() => {
  if (!url.value) return false
  try {
    return new URL(url.value).protocol === 'http:'
  } catch {
    return false
  }
})

async function onCopy() {
  if (!url.value) return
  // copyText 带 execCommand 降级：局域网 http 访问（非安全上下文）时
  // navigator.clipboard 不存在，裸调用会静默失败
  const ok = await copyText(url.value)
  if (ok) message.success(t('common.copied'))
  else message.error(t('common.copyFailed'))
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="qr-relay-modal"
    :title="t('qr.relay.title')"
    @update:show="emit('update:show', $event)"
  >
    <div class="qr-relay">
      <div
        v-if="loading"
        class="qr-loading"
      >
        <NSpin size="small" />
        <span>{{ t('qr.relay.loading') }}</span>
      </div>
      <template v-else>
        <div
          v-if="plan.state !== 'unreachable'"
          class="qr-canvas-wrap"
        >
          <NQrCode
            v-if="url"
            :value="url"
            :size="240"
            error-correction-level="M"
          />
        </div>
        <div
          v-else
          class="qr-unreachable"
          data-testid="qr-relay-unreachable"
        >
          <NIcon
            size="28"
            color="var(--accent-red)"
          >
            <PhonePortraitOutline />
          </NIcon>
          <span>{{ t('qr.relay.unreachablePlaceholder') }}</span>
        </div>

        <div
          v-if="candidates.length > 1"
          class="qr-address-row"
        >
          <span class="qr-address-label">{{ t('qr.relay.addressLabel') }}</span>
          <NSelect
            v-model:value="selectedIP"
            :options="candidateOptions"
            size="small"
            data-testid="qr-relay-address-select"
          />
        </div>

        <div
          class="qr-status"
          :class="`is-${statusTone}`"
          data-testid="qr-relay-status"
        >
          <span class="qr-status-dot" />
          <span>{{ t(statusKey) }}</span>
        </div>
        <div
          class="qr-hint"
          :class="`is-${statusTone}`"
          data-testid="qr-relay-hint"
        >
          {{ hint }}
        </div>

        <div class="qr-desc">
          <NIcon
            size="14"
            color="var(--text-muted)"
          >
            <PhonePortraitOutline />
          </NIcon>
          <span>{{ t('qr.relay.desc') }}</span>
        </div>
        <div class="qr-carry-row">
          <NCheckbox
            v-model:checked="carryLocation"
            data-testid="qr-relay-carry-location"
          >
            {{ t('qr.relay.carryLocation') }}
          </NCheckbox>
        </div>
        <div class="qr-link-row">
          <NInput
            :value="url"
            readonly
            size="small"
            data-testid="qr-relay-url"
            @focus="(e: FocusEvent) => (e.target as HTMLInputElement)?.select()"
          />
          <NButton
            size="small"
            :disabled="!url"
            @click="onCopy"
          >
            <template #icon>
              <NIcon><CopyOutline /></NIcon>
            </template>
            {{ t('common.copy') }}
          </NButton>
        </div>
        <div
          v-if="lockStore.state?.enabled"
          class="qr-tip"
        >
          {{ t('qr.relay.unlockHint') }}
        </div>
        <div
          v-if="plainHttp"
          class="qr-tip warn"
        >
          {{ t('qr.relay.httpWarn') }}
        </div>
      </template>
    </div>
  </NModal>
</template>

<style scoped>
.qr-relay {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.qr-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 200px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.qr-canvas-wrap {
  padding: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-canvas);
}
.qr-unreachable {
  width: 240px;
  height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-secondary);
  border: 1px dashed var(--accent-red);
  border-radius: 8px;
}
.qr-address-row {
  margin-top: 10px;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
}
.qr-address-label {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-dim);
}
.qr-address-row :deep(.n-select) { flex: 1; }
.qr-status {
  margin-top: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
}
.qr-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.qr-status.is-red,
.qr-hint.is-red { color: var(--accent-red); }
.qr-status.is-yellow,
.qr-hint.is-yellow { color: var(--accent-orange); }
.qr-status.is-green,
.qr-hint.is-green { color: var(--accent-green); }
.qr-status.is-red { background: color-mix(in srgb, var(--accent-red) 12%, transparent); }
.qr-status.is-yellow { background: color-mix(in srgb, var(--accent-orange) 12%, transparent); }
.qr-status.is-green { background: color-mix(in srgb, var(--accent-green) 12%, transparent); }
.qr-hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}
.qr-desc {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.qr-carry-row {
  margin-top: 10px;
  width: 100%;
}
.qr-link-row {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  width: 100%;
}
.qr-link-row .n-input { flex: 1; }
.qr-tip { margin-top: 10px; font-size: 12px; color: var(--text-secondary); }
.qr-tip.warn { color: var(--accent-orange); }
</style>
