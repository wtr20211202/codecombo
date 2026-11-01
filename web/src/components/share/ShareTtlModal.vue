<script setup lang="ts">
// 分享有效期调整弹层（P-20261020-5）：分享管理器行操作入口。复用
// POST /api/share/{token}/expiry（P-20261003-29 既有端点与错误映射）：
// permanent → expiresAt:null 清窗；预设/自定义日期 → RFC3339 绝对时点。
// snippet 的 24h 固定窗口不开放调整（服务端 400），管理器不渲染本入口
import { ref, watch } from 'vue'
import { NButton, NModal, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { shareApi, type ShareInfo } from '../../api/domains/share'
import {
  shareTtlExpiresAt, shareTtlFromExpiresAt, shareTtlLabelKey,
  type ShareTtlChoice,
} from '../../utils/shareTtl'
import { formatDateTime } from '../../utils/git'
import ShareTtlPicker from './ShareTtlPicker.vue'

const props = defineProps<{
  show: boolean
  share: ShareInfo | null
}>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'saved'): void
}>()

const { t } = useI18n()
const message = useMessage()

const choice = ref<ShareTtlChoice>('permanent')
const date = ref<number | null>(null)
const saving = ref(false)

// 每次打开按记录当前状态回填（单例弹层，残留会把上一条的日期带给下一条）
watch(() => props.show, (v) => {
  if (!v) return
  const next = shareTtlFromExpiresAt(props.share?.expiresAt)
  choice.value = next.choice
  date.value = next.date
})

function onChoice(v: ShareTtlChoice) {
  choice.value = v
  // 预设档立即清掉自定义日期残留；自定义档保留当前值供日期选择器续用
  if (v !== 'custom') date.value = null
}

const canSave = ref(true)
watch([choice, date], () => {
  canSave.value = choice.value !== 'custom' || date.value != null
}, { immediate: true })

const hint = () => {
  if (choice.value === 'permanent') return t('share.ttl.permanentLine')
  if (choice.value === 'custom') {
    const iso = shareTtlExpiresAt('custom', date.value)
    return iso ? t('share.ttl.expiresAtLine', { date: formatDateTime(iso) }) : t('share.create.ttlPickDate')
  }
  return t('share.ttl.presetHint', { label: t(shareTtlLabelKey(choice.value)) })
}

async function onSave() {
  const s = props.share
  if (!s || !canSave.value) return
  const expiresAt = shareTtlExpiresAt(choice.value, date.value)
  // 自定义日期未选：canSave 已挡住；这里再兜一层不产生空提交
  if (choice.value === 'custom' && !expiresAt) return
  saving.value = true
  try {
    await shareApi.setExpiry(s.token, expiresAt)
    message.success(t('share.ttl.updated'))
    emit('saved')
    emit('update:show', false)
  } catch { /* 拦截器已提示失败；弹层保留供重试 */ } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    class="share-ttl-modal"
    :title="props.share ? t('share.ttl.actionTitle', { name: props.share.name }) : t('share.ttl.label')"
    :mask-closable="false"
    data-testid="sm-ttl-modal"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="ttl-body">
      <div
        class="ttl-row"
        data-testid="sm-ttl-row"
      >
        <span class="ttl-label">{{ t('share.ttl.label') }}</span>
        <ShareTtlPicker
          :choice="choice"
          :date="date"
          select-test-id="sm-ttl-select"
          date-test-id="sm-ttl-date"
          @update:choice="onChoice"
          @update:date="(v) => (date = v)"
        />
      </div>
      <div
        class="ttl-hint"
        data-testid="sm-ttl-hint"
      >
        {{ hint() }}
      </div>
    </div>
    <template #footer>
      <div class="ttl-foot">
        <NButton
          size="small"
          quaternary
          @click="emit('update:show', false)"
        >
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          :loading="saving"
          :disabled="!canSave"
          data-testid="sm-ttl-save"
          @click="onSave"
        >
          {{ t('common.save') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.ttl-body { min-width: 360px; }
.ttl-row { display: flex; align-items: center; gap: 8px; }
.ttl-label { flex-shrink: 0; font-size: 12.5px; color: var(--text-secondary); }
.ttl-hint { margin-top: 8px; font-size: 12px; color: var(--text-muted); }
.ttl-foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
