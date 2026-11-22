<script setup lang="ts">
// 终端输出分享选项弹层（P-20261106-9）：终端 tab 右键「直播分享」「分享输出快照」
// 两入口共用——创建前选定敏感值遮蔽、访客页溯源水印、可选访问口令（P-20261107-4⑤，
// 文案/交互复用文件创建弹层的口令件）与有效期（P-20261107-4①）。状态在
// useTermShareDialog 单例中（入口只开弹层，确认才发请求），与文件分享创建弹层
// ShareCreateDialog 同范式。
// 遮蔽开关：缺省开（安全默认不可让步）；关闭只就地警示后果，真正的出域警示
// 确认发生在「创建」点击时（confirmTermOptions → confirmUnfilteredEgress）。
// 遮蔽是服务端源头参数（直播 feeder / 快照净化链），访客侧不存在渲染过滤；
// 设置创建时定死——进行中分享不可切，改配置须撤销重建（就地说明）。
// 有效期：直播 = ttlMinutes 分钟档（服务端默认 30 分钟、上限 24h；P-20261119-5
// 起增「永久」挡 → permanent:true，记录与 token 不过期、直播态仍随会话）。
// 永久 × 关闭遮蔽合法（【用户定向修订】2026-11-19：服务端不再 400 硬禁，撤销
// 兜底即可）——组合选中时就地警示「未过滤输出将永久公开」，行动自由交给用户。
// 档位语义与通用 ShareTtlPicker 不匹配，用独立档位下拉 utils/shareTtl
// TERM_LIVE_TTL_OPTIONS；快照 = 复用 ShareTtlPicker 全档（创建面无 TTL 字段，
// 显式选择经既有 /share/:token/expiry 在创建后立即生效）。
// 命中该会话既有直播（沿用既有遮蔽设置）时 toast 如实回告
import { computed } from 'vue'
import { NButton, NCheckbox, NIcon, NInput, NModal, NSelect, NSwitch, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { LockClosedOutline, ShareSocialOutline, WarningOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useTermShareDialog } from '../../composables/useTermShareDialog'
import { formatDateTime } from '../../utils/git'
import { shareTtlExpiresAt, shareTtlLabelKey, TERM_LIVE_TTL_OPTIONS, TERM_LIVE_TTL_PERMANENT } from '../../utils/shareTtl'
import type { ShareTtlChoice } from '../../utils/shareTtl'
import ShareTtlPicker from './ShareTtlPicker.vue'

const { t } = useI18n()
const message = useMessage()
const {
  showTermOptions: show, termOptionsTarget: target, termMask: mask, termWatermark: watermark,
  termPassphrase: passphrase, termLiveTtlMinutes: liveTtlMinutes,
  termFrozenTtlChoice: frozenChoice, termFrozenTtlDate: frozenDate, termFrozenTtlTouched: frozenTouched,
  termWritable: writable, termSubmitting: submitting, confirmTermOptions, cancelTermOptions,
} = useTermShareDialog()

const isFrozen = computed(() => target.value?.kind === 'frozen')
const title = computed(() => t(isFrozen.value ? 'terminal.frozenShare' : 'terminal.liveShare'))
const kindDesc = computed(() => t(isFrozen.value ? 'share.termOptions.frozenDesc' : 'share.termOptions.liveDesc'))

// 直播档位（minutes 为值；0 = 跟随服务端默认 30 分钟，不发字段；
// TERM_LIVE_TTL_PERMANENT = 永久挡）。永久 × 关闭遮蔽合法（【用户定向修订】
// 2026-11-19：服务端不再 400 硬禁）——选项不禁用，组合选中时就地警示
const livePermanentSelected = computed(() => liveTtlMinutes.value === TERM_LIVE_TTL_PERMANENT)
const liveTtlOptions = computed<SelectOption[]>(() =>
  TERM_LIVE_TTL_OPTIONS.map(p => ({ label: t(p.i18nKey), value: p.minutes })))

// 快照档位（ShareTtlPicker 全档）；custom 缺日期 = 无效提交（文件创建弹层同款）
const frozenInvalid = computed(() => isFrozen.value && frozenTouched.value && frozenChoice.value === 'custom' && frozenDate.value == null)
// 直播警示组合：已选永久且遮蔽被关（合法但原样输出将长期公开——知情面保留，
// 行动自由交给用户；撤销兜底在分享管理）
const livePermanentUnfiltered = computed(() => !isFrozen.value && livePermanentSelected.value && !mask.value)

/** 直播有效期提示：永久×未过滤组合 → 就地警示；永久选中 → 永久语义；
 *  遮蔽关 → 上限说明；否则默认档说明 */
const liveTtlHint = computed(() => {
  if (livePermanentUnfiltered.value) return t('share.termOptions.permanentUnfiltered')
  if (livePermanentSelected.value) return t('share.termOptions.ttlLivePermanentNote')
  return mask.value ? t('share.termOptions.ttlLiveNote') : t('share.termOptions.ttlLiveUnfilteredNote')
})

/** 快照有效期提示：未动过 = 说明默认档；动过 = 具体时点/永久 */
const frozenTtlHint = computed(() => {
  if (!frozenTouched.value) return t('share.termOptions.ttlFrozenNote')
  if (frozenChoice.value === 'permanent') return t('share.ttl.permanentLine')
  if (frozenChoice.value === 'custom') {
    const iso = shareTtlExpiresAt('custom', frozenDate.value)
    return iso ? t('share.ttl.expiresAtLine', { date: formatDateTime(iso) }) : t('share.create.ttlPickDate')
  }
  return t('share.ttl.presetHint', { label: t(shareTtlLabelKey(frozenChoice.value as ShareTtlChoice)) })
})

function onFrozenChoice(v: ShareTtlChoice) {
  frozenTouched.value = true
  frozenChoice.value = v
  if (v !== 'custom') frozenDate.value = null
}

function onFrozenDate(v: number | null) {
  frozenTouched.value = true
  frozenDate.value = v
}

async function onConfirm() {
  const res = await confirmTermOptions()
  if (res === 'modeMismatch') message.warning(t('share.termOptions.modeMismatch'))
  // 开放直入口令门缺位（P-20261121-1）：就地提示（口令输入框聚焦——入口
  // 可发现、失败可恢复；提交侧 fail-fast 于请求前）
  if (res === 'passphraseRequired') {
    message.warning(t('share.writable.passRequiredCreate'))
  }
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    class="share-term-options-modal"
    :style="{ width: 'var(--modal-w-sm)', maxWidth: '94vw' }"
    :title="title"
    :mask-closable="false"
    :closable="!submitting"
    :close-on-esc="!submitting"
  >
    <div
      v-if="target"
      class="term-options"
      data-testid="share-term-options"
      :data-kind="target.kind"
    >
      <div class="target-line">
        <span class="target-name">{{ target.name }}</span>
      </div>
      <div class="kind-desc">
        {{ kindDesc }}
      </div>

      <!-- 敏感值遮蔽：服务端源头遮蔽（直播 feeder / 快照净化链），缺省开 -->
      <div class="option-row">
        <div class="option-text">
          <span class="option-name">{{ t('share.termOptions.maskLabel') }}</span>
          <span class="option-note">{{ t('share.termOptions.maskNote') }}</span>
        </div>
        <NSwitch
          v-model:value="mask"
          :disabled="submitting"
          :aria-label="t('share.termOptions.maskLabel')"
          data-testid="share-term-mask"
        />
      </div>
      <div
        v-if="!mask"
        class="unfiltered-warn"
        role="alert"
        data-testid="share-term-unfiltered-warn"
      >
        <NIcon
          :size="15"
          class="warn-icon"
        >
          <WarningOutline />
        </NIcon>
        <div class="warn-text">
          <div>{{ t('share.termOptions.maskOffWarn') }}</div>
          <!-- 关闭遮蔽后的时长语义（两形态不同）：快照强制 24h（原文落盘）、
               直播限时档最长 24h（选「永久」则原样输出长期公开——就地警示见
               ttl-hint，撤销兜底在分享管理） -->
          <div
            v-if="isFrozen"
            class="warn-sub"
          >
            {{ t('share.termOptions.maskOffFrozenTtl') }}
          </div>
          <div
            v-else
            class="warn-sub"
            data-testid="share-term-mask-off-live-ttl"
          >
            {{ t('share.termOptions.maskOffLiveTtl') }}
          </div>
        </div>
      </div>
      <div class="option-note fixed-note">
        {{ t('share.termOptions.maskFixedNote') }}
      </div>

      <NCheckbox
        v-model:checked="watermark"
        :disabled="submitting"
        class="wm-check"
        data-testid="share-term-watermark"
      >
        <span class="option-name">{{ t('share.create.watermarkLabel') }}</span>
        <span class="option-note">{{ t('share.create.watermarkNote') }}</span>
      </NCheckbox>

      <!-- 访客输入快捷选择（P-20261121-1，仅直播形态）：开放直入 = 持链接
           （+口令）访客可直接键入；缺省关（安全基线）。申请-批准路径无需
           选择（申请通道缺省在场，分享管理可关）。仅 live 出开关（frozen/
           快照天然只读） -->
      <div
        v-if="!isFrozen"
        class="option-row"
        data-testid="share-term-writable-row"
      >
        <div class="option-text">
          <span class="option-name">{{ t('share.termOptions.writableLabel') }}</span>
          <span class="option-note">{{ t('share.termOptions.writableNote') }}</span>
        </div>
        <NSwitch
          v-model:value="writable"
          :disabled="submitting"
          :aria-label="t('share.termOptions.writableLabel')"
          data-testid="share-term-writable"
        />
      </div>
      <div
        v-if="!isFrozen && writable && !passphrase"
        class="unfiltered-warn"
        role="alert"
        data-testid="share-term-writable-pass-warn"
      >
        <NIcon
          :size="15"
          class="warn-icon"
        >
          <WarningOutline />
        </NIcon>
        <div class="warn-text">
          {{ t('share.termOptions.writablePassWarn') }}
        </div>
      </div>

      <!-- 访问口令（⑤）：可选，空 = 不设门（安全基线）；文案复用文件创建弹层的口令件 -->
      <div class="option-label pass-label">
        {{ t('share.pass.createLabel') }}
      </div>
      <NInput
        v-model:value="passphrase"
        type="password"
        show-password-on="click"
        clearable
        :placeholder="t('share.pass.createPlaceholder')"
        :maxlength="64"
        :disabled="submitting"
        size="small"
        class="pass-input"
        data-testid="share-term-passphrase"
      >
        <template #prefix>
          <NIcon :size="14">
            <LockClosedOutline />
          </NIcon>
        </template>
      </NInput>
      <div class="option-note">
        {{ t('share.pass.createNote') }}
      </div>

      <!-- 有效期（①）：直播 = 分钟档（默认 30 分钟 / 1h / 6h / 24h / 永久）；
           快照 = ShareTtlPicker 全档（创建后经既有 expiry 端点立即生效） -->
      <div class="option-label ttl-label">
        {{ t('share.ttl.label') }}
      </div>
      <template v-if="isFrozen">
        <div
          class="ttl-row"
          data-testid="share-term-ttl-row"
        >
          <ShareTtlPicker
            :choice="frozenChoice"
            :date="frozenDate"
            select-test-id="share-term-ttl-select"
            date-test-id="share-term-ttl-date"
            @update:choice="onFrozenChoice"
            @update:date="onFrozenDate"
          />
        </div>
        <div
          class="option-note ttl-hint"
          data-testid="share-term-ttl-hint"
        >
          {{ frozenTtlHint }}
        </div>
      </template>
      <template v-else>
        <div
          class="ttl-row"
          data-testid="share-term-ttl-row"
        >
          <NSelect
            v-model:value="liveTtlMinutes"
            size="small"
            :options="liveTtlOptions"
            class="ttl-select"
            :disabled="submitting"
            data-testid="share-term-ttl-select"
          />
        </div>
        <div
          class="option-note ttl-hint"
          :class="{ 'ttl-invalid': livePermanentUnfiltered }"
          data-testid="share-term-ttl-hint"
        >
          {{ liveTtlHint }}
        </div>
      </template>
    </div>

    <template #footer>
      <div class="options-footer">
        <NButton
          size="small"
          quaternary
          :disabled="submitting"
          data-testid="share-term-cancel"
          @click="cancelTermOptions"
        >
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          size="small"
          :type="mask ? 'primary' : 'error'"
          :loading="submitting"
          :disabled="frozenInvalid"
          data-testid="share-term-confirm"
          @click="onConfirm"
        >
          <template #icon>
            <NIcon><ShareSocialOutline /></NIcon>
          </template>
          {{ mask ? t('share.termOptions.confirm') : t('share.termOptions.confirmUnfiltered') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.term-options { display: flex; flex-direction: column; min-width: 0; }
.target-line { min-width: 0; }
.target-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-all;
}
.kind-desc { margin-top: 4px; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.option-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-top: 16px;
}
.option-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.option-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.option-note { font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }
/* 未过滤后果就地警示：危险色与出域警示同语义——不是错误，是出域边界的前置知情 */
.unfiltered-warn {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--accent-red);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent-red) 10%, transparent);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.55;
}
.warn-icon { flex: 0 0 auto; margin-top: 2px; color: var(--accent-red); }
.warn-text { min-width: 0; }
.warn-sub { margin-top: 4px; color: var(--text-secondary); }
.fixed-note { margin-top: 8px; }
.wm-check { display: flex; margin-top: 16px; align-items: flex-start; }
.wm-check .option-note { display: block; margin-top: 2px; font-weight: 400; }
.option-label { margin-top: 16px; font-size: 12.5px; color: var(--text-secondary); }
.pass-input { margin-top: 8px; }
.ttl-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.ttl-select { flex: 0 0 180px; }
.ttl-hint { margin-top: 6px; }
/* 警示组合说明（永久 × 关闭遮蔽，合法可提交）：用出域警示同色保持可感知 */
.ttl-invalid { color: var(--accent-red); }
.options-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
