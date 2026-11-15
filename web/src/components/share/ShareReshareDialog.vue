<script setup lang="ts">
// 重新分享弹层（P-20261114-3-S1）：行操作「重新分享」的显式确认面——旧实现
// 是无引导的 promptDialog/confirmDialog（模式无条件沿用 reshareConfig 的
// `mode: s.frozen ? 'frozen' : 'live'`，用户无从知晓也无从更改），本组件把
// 重建参数在确认前摊开：
// - 模式：默认沿用来源链接（提示行明示「沿用来源链接：定格/实时」），单路径
//   可切实时/定格——切回实时正是本弹层的存在意义（P-20261003-320 起分享双
//   模式，重发不该被锁死在来源模式上）；
// - 有效期：未主动改动随模式换默认档（ShareCreateDialog 同款联动——frozen
//   30 天 / live 服务端设置默认档），动过跨模式保留；未动不显式发字段交服务
//   端兜底。设置默认档只用于预选展示（失败静默回落永久），与创建弹层
//   loadCreateTtlDefault 同语义；
// - 口令：只存哈希不可回读，留空 = 明确重建为无口令（不静默丢门，延续
//   P-20261020-10 语义）；
// - 批量记录（Paths 非空）：模式控件禁用（服务端 paths 仅收 frozen，切 live
//   会 400），且重发走 createBatch 按原选择集重建——重发链路只传单 path 会
//   把批量记录静默重建为「项目根」单路径分享，比服务端 400 更糟的静默事故
//   （评审修订点③），故禁切 + 约束说明就地标注。
// 水印/一次性开关无控件、按来源沿用（reshareConfig 语义不变）；唯 frozen 与
// 一次性互斥（服务端 400），来源带一次性而切到定格时显式说明丢弃，不留暗改。
import { computed, ref, watch } from 'vue'
import { NButton, NIcon, NInput, NModal, NRadio, NRadioGroup } from 'naive-ui'
import { LockClosedOutline } from '@vicons/ionicons5'
import type { ShareInfo, ShareMode } from '../../api/domains/share'
import { settingsApi } from '../../api/domains/system'
import { formatDateTime } from '../../utils/git'
import {
  shareTtlExpiresAt, shareTtlLabelKey, type ShareDefaultTtl, type ShareTtlChoice,
} from '../../utils/shareTtl'
import { useI18n } from '../../composables/useI18n'
import { reshareConfig, type ReshareSubmit } from '../../composables/useShareReshare'
import ShareTtlPicker from './ShareTtlPicker.vue'

const props = defineProps<{
  /** 重发来源行（ShareManagerView「更多」菜单传入）；null = 弹层闲置 */
  source: ShareInfo | null
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'confirm', submit: ReshareSubmit): void
  (e: 'update:show', v: boolean): void
}>()

const { t } = useI18n()

const showModel = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v),
})

// 批量记录：Paths 非空（share.batch 注——path 恒空、仅 frozen）
const isBatch = computed(() => (props.source?.paths?.length ?? 0) > 0)

// 来源快照陈旧注记（P-20261114-3-S2）：重发 = 「撤销旧链重建新链」，若只是
// 要跟进最新内容，原地刷新（保持链接，P-20261005-177）才是产品主路——弹层
// 显式提示防把「换内容」误操作成「换链接」（重发换链为辅的文案对齐）
const sourceStale = computed(() => !!props.source?.staleAt)

// 弹层表单态：每次打开从来源行重置（reshareConfig 是沿用语义的单点实现）
const mode = ref<ShareMode>('live')
const passphrase = ref('')
const viewOnce = ref(false)
const sourceViewOnce = ref(false)
const ttlChoice = ref<ShareTtlChoice>('permanent')
const ttlDate = ref<number | null>(null)
const ttlTouched = ref(false)
// live 侧默认档镜像（仅预选展示；未动不发字段，服务端按同一设置兜底）
const liveDefault = ref<ShareDefaultTtl>('permanent')
// 来源模式（「沿用来源链接」提示行的对照基准；用户改过模式即隐藏提示）
const inheritedMode = ref<ShareMode>('live')

const modeInherited = computed(() => mode.value === inheritedMode.value)

watch(() => props.show, (open) => {
  if (!open || !props.source) return
  const cfg = reshareConfig(props.source)
  inheritedMode.value = cfg.mode
  mode.value = cfg.mode
  passphrase.value = ''
  sourceViewOnce.value = cfg.viewOnce
  viewOnce.value = cfg.viewOnce
  ttlTouched.value = false
  ttlDate.value = null
  ttlChoice.value = cfg.mode === 'frozen' ? '30d' : liveDefault.value
  void loadLiveDefault()
})

/** 拉取服务端默认有效期做预选展示（P-20261020-5 同款）：失败静默回落永久
 *  ——用户没动过时请求本就不带 ttl，服务端仍按当前设置兜底，这里不是数据源 */
async function loadLiveDefault(): Promise<void> {
  try {
    // 拦截器已解包 envelope：返回值即 {data: SettingsData}
    const res = await settingsApi.get({ silent: true }) as unknown as { data?: { shareDefaultTTL?: string } }
    const v = res?.data?.shareDefaultTTL
    if (v !== 'permanent' && v !== '1d' && v !== '7d' && v !== '30d') return
    liveDefault.value = v
    if (mode.value !== 'frozen' && !ttlTouched.value) ttlChoice.value = v
  } catch { /* silent：回落 permanent */ }
}

// 模式切换联动（ShareCreateDialog 同款）：一次性与定格互斥（服务端 400），
// 切 frozen 主动清掉；有效期未被主动改动时随模式换默认档，已选档位跨模式保留
watch(mode, (m) => {
  if (m === 'frozen') viewOnce.value = false
  if (!ttlTouched.value) ttlChoice.value = m === 'frozen' ? '30d' : liveDefault.value
})

function onTtlChoice(v: ShareTtlChoice) {
  ttlTouched.value = true
  ttlChoice.value = v
  if (v !== 'custom') ttlDate.value = null
}

function onTtlDate(v: number | null) {
  ttlTouched.value = true
  ttlDate.value = v
}

/** 就地说明生效窗口：自定义日期未选时提示先选日期 */
const ttlHint = computed(() => {
  if (ttlChoice.value === 'custom') {
    const iso = shareTtlExpiresAt('custom', ttlDate.value)
    return iso ? t('share.ttl.expiresAtLine', { date: formatDateTime(iso) }) : t('share.create.ttlPickDate')
  }
  if (ttlChoice.value === 'permanent') return t('share.ttl.permanentLine')
  if (!ttlTouched.value && mode.value === 'frozen') return t('share.create.ttlFrozenDefaultHint')
  const label = t(shareTtlLabelKey(ttlChoice.value))
  return ttlTouched.value
    ? t('share.create.ttlPresetHint', { label })
    : t('share.create.ttlDefaultHint', { label })
})

/** 口令按 UTF-8 字节校验（延续 promptDialog validate 语义——maxlength 是
 *  字符数兜底，中日韩字符 1 字符 3 字节，两者不是同一口径） */
function passphraseBytes(v: string): number {
  return new TextEncoder().encode(v).length
}
const passTooLong = computed(() => passphraseBytes(passphrase.value) > 64)

const ttlInvalid = computed(() => ttlChoice.value === 'custom' && ttlDate.value == null)
const canConfirm = computed(() => !passTooLong.value && !ttlInvalid.value)

function onConfirm(): void {
  if (!canConfirm.value || !props.source) return
  const submit: ReshareSubmit = {
    mode: mode.value,
    passphrase: passphrase.value,
    watermark: props.source.watermark !== false,
    // frozen 与一次性互斥（服务端 400）：watch 已联动清除，此处兜底不把 true 发出去
    viewOnce: mode.value === 'frozen' ? false : viewOnce.value,
  }
  // 有效期（单路径）：用户主动改过才显式携带；未改 = 交给服务端默认。
  // 批量走 createBatch（无 TTL 参数，服务端 frozen 默认 30 天），不发字段
  if (!isBatch.value && ttlTouched.value) {
    if (ttlChoice.value === 'custom') {
      const iso = shareTtlExpiresAt('custom', ttlDate.value)
      if (!iso) return
      submit.expiresAt = iso
    } else {
      submit.ttl = ttlChoice.value
    }
  }
  emit('confirm', submit)
  emit('update:show', false)
}

function close(): void {
  emit('update:show', false)
}
</script>

<template>
  <!-- data-testid 直挂 NModal（attrs 落卡片元素，sm-drop-modal 同款先例）：
       footer 插槽在卡片内，e2e 以卡片为根 can scope 到确认钮 -->
  <NModal
    v-model:show="showModel"
    preset="card"
    class="share-reshare-modal"
    :title="t('share.reshare.title')"
    :mask-closable="false"
    data-testid="share-reshare-modal"
    @after-leave="close"
  >
    <div
      v-if="source"
      class="share-reshare"
    >
      <div class="target-line">
        <span class="target-name">{{ source.name }}</span>
        <span
          v-if="isBatch"
          class="target-path"
        >{{ t('share.batch.selected', { n: source.paths?.length ?? 0 }) }}</span>
        <span
          v-else-if="source.path"
          class="target-path"
        >{{ source.path }}</span>
      </div>
      <div class="mode-note intro-line">
        {{ t('share.reshare.confirm', { name: source.name }) }}
      </div>
      <!-- 来源快照陈旧（P-20261114-3-S2）：先给「原地刷新」这条保链接的主路 -->
      <div
        v-if="sourceStale"
        class="mode-note constraint-note"
        data-testid="share-reshare-stale-note"
      >
        {{ t('share.stale.reshareNote') }}
      </div>

      <div class="mode-label">
        {{ t('share.create.modeLabel') }}
      </div>
      <!-- 沿用提示：仅「未改动」期间展示——用户一旦改选，单选组自身就是现状 -->
      <div
        v-if="modeInherited"
        class="mode-note mode-hint"
        data-testid="share-reshare-mode-hint"
      >
        {{ t(mode === 'frozen' ? 'share.reshare.modeHintFrozen' : 'share.reshare.modeHintLive') }}
      </div>
      <NRadioGroup
        v-model:value="mode"
        name="share-reshare-mode"
        :disabled="isBatch"
        data-testid="share-reshare-mode-group"
      >
        <div class="mode-options">
          <NRadio
            value="live"
            data-testid="share-reshare-mode-live"
          >
            <div class="mode-item">
              <span class="mode-name">{{ t('share.create.liveLabel') }}</span>
              <span class="mode-desc">{{ t('share.create.liveDesc') }}</span>
            </div>
          </NRadio>
          <NRadio
            value="frozen"
            data-testid="share-reshare-mode-frozen"
          >
            <div class="mode-item">
              <span class="mode-name">{{ t('share.create.frozenLabel') }}</span>
              <span class="mode-desc">{{ t('share.create.frozenDesc') }}</span>
              <span class="mode-note">{{ t('share.create.frozenNote') }}</span>
            </div>
          </NRadio>
        </div>
      </NRadioGroup>
      <!-- 批量行：模式控件禁用的约束说明（不可切实时 + 调整选择集走新建批量） -->
      <div
        v-if="isBatch"
        class="mode-note constraint-note"
        data-testid="share-reshare-batch-note"
      >
        {{ t('share.reshare.batchModeNote') }}
      </div>
      <!-- 来源带一次性而切到定格：显式说明丢弃，不留暗改 -->
      <div
        v-else-if="sourceViewOnce && mode === 'frozen'"
        class="mode-note constraint-note"
        data-testid="share-reshare-viewonce-note"
      >
        {{ t('share.reshare.viewOnceDroppedNote') }}
      </div>

      <!-- 有效期（单路径）：批量走 createBatch 无 TTL 参数，整节隐藏 -->
      <template v-if="!isBatch">
        <div class="mode-label ttl-label">
          {{ t('share.ttl.label') }}
        </div>
        <div
          class="ttl-row"
          data-testid="share-reshare-ttl-row"
        >
          <ShareTtlPicker
            :choice="ttlChoice"
            :date="ttlDate"
            select-test-id="share-reshare-ttl-select"
            date-test-id="share-reshare-ttl-date"
            @update:choice="onTtlChoice"
            @update:date="onTtlDate"
          />
        </div>
        <div
          class="mode-note ttl-hint"
          data-testid="share-reshare-ttl-hint"
        >
          {{ ttlHint }}
        </div>
      </template>

      <div class="mode-label pass-label">
        {{ t('share.reshare.passphraseLabel') }}
      </div>
      <NInput
        v-model:value="passphrase"
        type="password"
        show-password-on="click"
        clearable
        :maxlength="64"
        class="pass-input"
        :placeholder="t('share.pass.createPlaceholder')"
        data-testid="share-reshare-pass"
      >
        <template #prefix>
          <NIcon :size="14">
            <LockClosedOutline />
          </NIcon>
        </template>
      </NInput>
      <div
        v-if="passTooLong"
        class="mode-note pass-error"
        data-testid="share-reshare-pass-error"
      >
        {{ t('share.reshare.passphraseTooLong') }}
      </div>
      <div
        v-else
        class="mode-note"
      >
        {{ t('share.reshare.passNote') }}
      </div>
    </div>

    <template #footer>
      <div class="create-footer">
        <NButton
          size="small"
          quaternary
          data-testid="share-reshare-cancel"
          @click="close"
        >
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          :disabled="!canConfirm"
          data-testid="share-reshare-confirm"
          @click="onConfirm"
        >
          {{ t('share.reshare.action') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.share-reshare { min-width: 320px; }
.target-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.target-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-all;
}
.target-path {
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  word-break: break-all;
}
.intro-line { margin-top: 6px; }
.mode-label { margin-top: 14px; font-size: 12.5px; color: var(--text-secondary); }
.mode-hint { margin-top: 4px; }
.mode-options { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
.mode-item { display: flex; flex-direction: column; gap: 2px; }
.mode-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.mode-desc { font-size: 12px; color: var(--text-secondary); }
.mode-note { font-size: 11.5px; color: var(--text-muted); }
/* 约束说明（批量禁切 / 一次性丢弃）：警示色与创建弹层单文件 HTML 提示同语义
   ——不是错误，而是重建边界的前置知情 */
.constraint-note { margin-top: 8px; color: var(--accent-orange, #d97706); }
.ttl-label { margin-top: 16px; }
.ttl-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.ttl-hint { margin-top: 6px; }
.pass-label { margin-top: 16px; }
.pass-input { margin-top: 8px; }
.pass-error { margin-top: 4px; color: var(--accent-red); }
.create-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
