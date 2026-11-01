<script setup lang="ts">
// 分享有效期选择器（P-20261020-5）：预设档位 + 自定义日期。创建弹层 / 结果卡 /
// 分享管理器三处共用同一控件与档位表（utils/shareTtl.ts），避免再次出现
// 「某处只有 1天/7天」的档位漂移。纯受控组件：值由父级持有，变更经事件回传
import { computed } from 'vue'
import { NDatePicker, NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import {
  SHARE_TTL_PRESETS, shareTtlDateDisabled,
  type ShareTtlChoice,
} from '../../utils/shareTtl'

const props = withDefaults(defineProps<{
  choice: ShareTtlChoice
  date: number | null
  selectTestId?: string
  dateTestId?: string
}>(), {
  selectTestId: 'share-ttl-select',
  dateTestId: 'share-ttl-date',
})

const emit = defineEmits<{
  (e: 'update:choice', v: ShareTtlChoice): void
  (e: 'update:date', v: number | null): void
}>()

const { t } = useI18n()
const options = computed<SelectOption[]>(() =>
  SHARE_TTL_PRESETS.map((p) => ({ label: t(p.i18nKey), value: p.value })))
</script>

<template>
  <NSelect
    :value="props.choice"
    size="small"
    :options="options"
    class="ttl-select"
    :data-testid="props.selectTestId"
    @update:value="(v: ShareTtlChoice) => emit('update:choice', v)"
  />
  <NDatePicker
    v-if="props.choice === 'custom'"
    :value="props.date"
    type="date"
    size="small"
    class="ttl-date"
    :is-date-disabled="shareTtlDateDisabled"
    :clearable="false"
    :data-testid="props.dateTestId"
    @update:value="(v: number | null) => emit('update:date', v)"
  />
</template>

<style scoped>
.ttl-select { flex: 0 0 130px; }
.ttl-date { flex: 0 0 150px; }
</style>
