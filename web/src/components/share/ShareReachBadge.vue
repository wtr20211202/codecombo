<script setup lang="ts">
// 分享链接可达性徽标（P-20261020-2）：结果卡与分享管理器共用。三色语义与
// 二维码接力（QrRelayModal）一致——红=仅本机/不可达，黄=需同一网络，
// 绿=任意网络；文案按基址来源细分（配置基址/外部地址/当前地址/局域网候选/
// 旧端口回退），hint 给可行动的处置指引。
import { computed } from 'vue'
import { useI18n } from '../../composables/useI18n'
import {
  shareReachTone,
  type ShareAddressSource,
} from '../../utils/shareAddress'
import type { RelayAccessState } from '../../utils/networkAddress'

const props = defineProps<{
  state: RelayAccessState
  source?: ShareAddressSource
  /** 结果卡展示完整提示；管理器只留徽标 + title，避免工具栏膨胀 */
  showHint?: boolean
}>()

const { t } = useI18n()

const tone = computed(() => shareReachTone(props.state))

const labelKey = computed(() => {
  if (props.state === 'external') {
    return props.source === 'publicBase' ? 'share.reach.label.publicBase' : 'share.reach.label.external'
  }
  return `share.reach.label.${props.state}`
})

const hintKey = computed(() => {
  if (props.state === 'external') {
    return props.source === 'publicBase' ? 'share.reach.hint.publicBase' : 'share.reach.hint.external'
  }
  if (props.state === 'loopback') {
    // 显式配置成回环基址与「自动选址失败」是两种处境：前者改配置即可，
    // 后者先要配置——分开给指引，避免对已配置用户重复「请配置」
    if (props.source === 'publicBase') return 'share.reach.hint.publicBaseLoopback'
    return props.source === 'candidate' ? 'share.reach.hint.candidate' : 'share.reach.hint.legacy'
  }
  return `share.reach.hint.${props.state}`
})
</script>

<template>
  <div
    class="share-reach"
    :data-state="state"
    :data-tone="tone"
    :data-source="source"
    data-testid="share-reach-badge"
  >
    <span
      class="share-reach-pill"
      :class="`is-${tone}`"
      :title="t(hintKey)"
    >
      <span class="share-reach-dot" />
      {{ t(labelKey) }}
    </span>
    <span
      v-if="showHint"
      class="share-reach-hint"
      :class="`is-${tone}`"
      data-testid="share-reach-hint"
    >{{ t(hintKey) }}</span>
  </div>
</template>

<style scoped>
.share-reach {
  display: flex;
  flex-direction: column;
  gap: 5px;
  align-items: flex-start;
  min-width: 0;
}
.share-reach-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}
.share-reach-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}
.share-reach-pill.is-red { color: var(--accent-red); }
.share-reach-pill.is-yellow { color: var(--accent-orange); }
.share-reach-pill.is-green { color: var(--accent-green); }
.share-reach-pill.is-red { background: color-mix(in srgb, var(--accent-red) 12%, transparent); }
.share-reach-pill.is-yellow { background: color-mix(in srgb, var(--accent-orange) 12%, transparent); }
.share-reach-pill.is-green { background: color-mix(in srgb, var(--accent-green) 12%, transparent); }
.share-reach-hint {
  font-size: 12px;
  line-height: 1.5;
  max-width: 100%;
}
.share-reach-hint.is-red { color: var(--accent-red); }
.share-reach-hint.is-yellow { color: var(--accent-orange); }
.share-reach-hint.is-green { color: var(--text-secondary); }
</style>
