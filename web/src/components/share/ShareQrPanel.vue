<script setup lang="ts">
// 分享二维码面板（P-20261020-6）：结果卡与管理器二维码弹层共用的展示件。
// 码内容 = 地址计划解析出的访客短链（useShareAddressPlan），链接输入框是
// 扫码失败的手动兜底；三色徽标提示可达性（红=仅本机/无法确定，黄=同网，
// 绿=任意网络）。口令绝不进入码内容——调用方只传 token，不传任何凭据。
import { computed, watch } from 'vue'
import { NButton, NIcon, NInput, NQrCode, NSelect, NSpin, useMessage } from 'naive-ui'
import { CopyOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useShareAddressPlan } from '../../composables/useShareAddressPlan'
import { copyText } from '../../utils/clipboard'

const props = withDefaults(defineProps<{
  token: string
  /** 面板可见/弹层打开时才拉取地址上下文（避免 Layout 常驻组件开机即请求） */
  active?: boolean
  size?: number
  /** 是否展示「复制链接」裸链按钮；口令分享的结果卡关闭它以引导复制邀请信息 */
  showCopy?: boolean
  /** data-testid 前缀：<prefix>-canvas / -status / -hint / -url / -copy / -address-select */
  testidPrefix?: string
}>(), { active: true, size: 220, showCopy: true, testidPrefix: 'share-qr' })

const emit = defineEmits<{ 'update:url': [url: string] }>()

const { t } = useI18n()
const message = useMessage()
const { loading, status, candidates, selectedIP, statusTone, statusKey, hint, urlOf, load } = useShareAddressPlan()

const url = computed(() => urlOf(props.token))
watch(url, (v) => emit('update:url', v), { immediate: true })
// 面板不随弹层销毁而复用（同一组件换 token）时，重新激活也要回传当前值：
// 否则父层清空后的链接槽位要等地址变化才有内容，同 token 重开是空窗
watch(() => props.active, (v) => {
  if (!v) return
  emit('update:url', url.value)
  void load()
}, { immediate: true })

const testid = (suffix: string) => `${props.testidPrefix}-${suffix}`
const candidateOptions = computed(() =>
  candidates.value.map(a => ({ label: `${a.iface} · ${a.ip}`, value: a.ip })))

async function onCopy() {
  if (!url.value) return
  // copyText 带 execCommand 降级：局域网 http 访问（非安全上下文）时
  // navigator.clipboard 不存在，裸调用会静默失败
  const ok = await copyText(url.value)
  if (ok) message.success(t('share.linkCopied'))
  else message.error(t('common.copyFailed'))
}
</script>

<template>
  <div
    class="sq-panel"
    :data-testid="testid('panel')"
  >
    <div
      v-if="loading"
      class="sq-loading"
    >
      <NSpin size="small" />
      <span>{{ t('share.qr.loading') }}</span>
    </div>
    <template v-else>
      <div
        v-if="url"
        class="sq-canvas-wrap"
        :data-testid="testid('canvas')"
      >
        <NQrCode
          :value="url"
          :size="size"
          error-correction-level="M"
        />
      </div>

      <div
        class="sq-status"
        :class="`is-${statusTone}`"
        :data-testid="testid('status')"
      >
        <span class="sq-status-dot" />
        <span>{{ t(statusKey) }}</span>
      </div>
      <div
        class="sq-hint"
        :class="`is-${statusTone}`"
        :data-testid="testid('hint')"
      >
        {{ hint }}
      </div>

      <div
        v-if="candidates.length > 1"
        class="sq-address-row"
      >
        <span class="sq-address-label">{{ t('share.qr.addressLabel') }}</span>
        <NSelect
          v-model:value="selectedIP"
          :options="candidateOptions"
          size="small"
          :data-testid="testid('address-select')"
        />
      </div>

      <div
        v-if="url"
        class="sq-link-row"
      >
        <NInput
          :value="url"
          readonly
          size="small"
          :data-testid="testid('url')"
          @focus="(e: FocusEvent) => (e.target as HTMLInputElement)?.select()"
        />
        <NButton
          v-if="showCopy"
          size="small"
          :data-testid="testid('copy')"
          @click="onCopy"
        >
          <template #icon>
            <NIcon><CopyOutline /></NIcon>
          </template>
          {{ t('common.copy') }}
        </NButton>
        <slot
          name="actions"
          :url="url"
        />
      </div>
      <div
        v-else
        class="sq-warn"
        :data-testid="testid('unavailable')"
      >
        {{ status.running ? t('share.qr.unreachablePlaceholder') : t('share.serviceDown') }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.sq-panel { display: flex; flex-direction: column; align-items: center; width: 100%; }
.sq-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 120px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.sq-canvas-wrap {
  padding: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-canvas);
}
.sq-status {
  margin-top: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
}
.sq-status-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.sq-status.is-red, .sq-hint.is-red { color: var(--accent-red); }
.sq-status.is-yellow, .sq-hint.is-yellow { color: var(--accent-orange); }
.sq-status.is-green, .sq-hint.is-green { color: var(--accent-green); }
.sq-status.is-red { background: color-mix(in srgb, var(--accent-red) 12%, transparent); }
.sq-status.is-yellow { background: color-mix(in srgb, var(--accent-orange) 12%, transparent); }
.sq-status.is-green { background: color-mix(in srgb, var(--accent-green) 12%, transparent); }
.sq-hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}
.sq-address-row {
  margin-top: 10px;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
}
.sq-address-label { flex-shrink: 0; font-size: 12px; color: var(--text-dim); }
.sq-address-row :deep(.n-select) { flex: 1; }
.sq-link-row {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  width: 100%;
}
.sq-link-row .n-input { flex: 1; }
.sq-warn {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--accent-orange);
  text-align: center;
}
</style>
