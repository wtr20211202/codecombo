<script setup lang="ts">
// 分享创建弹层（P-20261003-320）：模式选择——live 活视图（默认）/ frozen
// 冻结快照（内容定格不可变 + 副本全量敏感扫描 + 默认 30 天）。状态在
// useShareDialog 单例中（createShare 入口只开弹层，确认才发请求），任意
// 入口（文件树右键等）共享同一弹层；frozen 的语义说明就地展示，是「冻结=
// 不可变」承诺的唯一解释位。
// 访问口令（P-20261006-25）：可选输入——非空 = 分享加口令门（访客先过口令
// 页再见内容），留空保持「知道链接即能看」。
// 一次性查看（P-20261006-27）：可选勾选——首位访客打开后进入 10 分钟宽限
// 窗，窗后失效（阅后即焚）。frozen 模式下禁用（定格留证与即焚相斥，服务端
// 400；前端禁用是先于报错的引导），勾选说明就地展示失效语义
// 有效期（P-20261020-5）：可选档位（1 小时/1 天/7 天/30 天/永久/自定义）。
// live 未主动改动时预选 settings.shareDefaultTTL（缺省永久），frozen 默认
// 30 天；「未改动」不显式发字段，由服务端按当前设置兜底
import { computed, watch } from 'vue'
import { NButton, NCheckbox, NIcon, NInput, NModal, NRadio, NRadioGroup } from 'naive-ui'
import { LockClosedOutline, ShareSocialOutline } from '@vicons/ionicons5'
import { FROZEN_MAX_BYTES } from '../../api/domains/share'
import { formatBytes } from '../../utils/bytes'
import { useI18n } from '../../composables/useI18n'
import { useShareDialog } from '../../composables/useShareDialog'
import { formatDateTime } from '../../utils/git'
import { shareTtlExpiresAt, shareTtlLabelKey, type ShareTtlChoice } from '../../utils/shareTtl'
import ShareTtlPicker from './ShareTtlPicker.vue'

const { t } = useI18n()
const {
  showCreate: show, createTarget: target, createMode: mode, createPassphrase: passphrase,
  createWatermark: watermark, createViewOnce: viewOnce, createEstimate: estimate,
  createTtlChoice: ttlChoice, createTtlDate: ttlDate, createTtlTouched: ttlTouched,
  createTtlDefault: ttlDefault, confirmCreate, cancelCreate,
} = useShareDialog()

// 批量选择集（P-20261008-1）：多路径只支持 frozen（服务端拒绝 live），弹层
// 以静态说明替代模式单选；清单与合计体积预估就地展示，超 200MB 上限提前预警
const batchPaths = computed(() => target.value?.paths ?? [])
const isBatch = computed(() => batchPaths.value.length > 0)
const BATCH_LISTED = 6
const listedPaths = computed(() => batchPaths.value.slice(0, BATCH_LISTED))
const hiddenCount = computed(() => Math.max(0, batchPaths.value.length - BATCH_LISTED))
const overLimit = computed(() => (estimate.value?.bytes ?? 0) > FROZEN_MAX_BYTES)

// frozen 与一次性互斥（P-20261006-27⑤）：切到 frozen 时主动取消勾选——
// 禁用态保留勾选会让「看起来选了实际没选」，直接清掉才诚实
const viewOnceDisabled = computed(() => mode.value === 'frozen')
watch(mode, (m) => {
  if (m === 'frozen') viewOnce.value = false
  // 有效期未被主动改动时随模式换默认：live = 设置默认档，frozen = 30 天
  //（冻结副本的 store 默认窗口；用户已选的档位跨模式保留）
  if (!ttlTouched.value) ttlChoice.value = m === 'frozen' ? '30d' : ttlDefault.value
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

const ttlInvalid = computed(() => ttlChoice.value === 'custom' && ttlDate.value == null)

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

// 单文件 HTML 分享提示（P-20261020-4）：单文件分享的边界就是该 html 文件
// 本身，同目录 css/img 不在分享内——创建前就把「为什么会掉样式/图」讲清楚，
// 并给出「分享所在文件夹」的替代路径。目录目标不出现该提示
const singleHtmlTarget = computed(() => {
  const tg = target.value
  return !!tg && !tg.isDir && /\.html?$/i.test(tg.path)
})
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    class="share-create-modal"
    :title="t('share.create.title')"
    :mask-closable="false"
    @after-leave="cancelCreate"
  >
    <div
      v-if="target"
      class="share-create"
      data-testid="share-create-dialog"
    >
      <div class="target-line">
        <span class="target-name">{{ target.name }}</span>
        <span
          v-if="isBatch"
          class="target-path"
        >{{ t('share.batch.selected', { n: batchPaths.length }) }}</span>
        <span
          v-else-if="target.path"
          class="target-path"
        >{{ target.path }}</span>
      </div>

      <div
        v-if="singleHtmlTarget"
        class="single-html-note"
        data-testid="share-create-single-html-note"
      >
        {{ t('share.create.singleHtmlNote') }}
      </div>

      <!-- 批量选择集清单 + 合计体积预估（P-20261008-1）：跨目录评审包在
           创建前就能核对组成与量级；超 200MB 上限就地预警（服务端 413 兜底） -->
      <div
        v-if="isBatch"
        class="batch-box"
        data-testid="share-batch-paths"
      >
        <ul class="batch-list">
          <li
            v-for="p in listedPaths"
            :key="p"
            class="batch-path"
          >
            {{ p }}
          </li>
        </ul>
        <div
          v-if="hiddenCount > 0"
          class="mode-note"
        >
          {{ t('share.batch.more', { n: hiddenCount }) }}
        </div>
        <div
          class="batch-estimate"
          :class="{ over: overLimit }"
          data-testid="share-batch-estimate"
        >
          <template v-if="estimate">
            {{ t('share.batch.estimate', { n: estimate.entries, size: formatBytes(estimate.bytes) }) }}
            <span
              v-if="overLimit"
              class="over-tip"
            >{{ t('share.batch.overLimit', { max: formatBytes(FROZEN_MAX_BYTES) }) }}</span>
          </template>
          <template v-else>
            {{ t('share.batch.estimating') }}
          </template>
        </div>
      </div>

      <template v-if="!isBatch">
        <div class="mode-label">
          {{ t('share.create.modeLabel') }}
        </div>
        <NRadioGroup
          v-model:value="mode"
          name="share-mode"
          data-testid="share-mode-group"
        >
          <div class="mode-options">
            <NRadio
              value="live"
              data-testid="share-mode-live"
            >
              <div class="mode-item">
                <span class="mode-name">{{ t('share.create.liveLabel') }}</span>
                <span class="mode-desc">{{ t('share.create.liveDesc') }}</span>
              </div>
            </NRadio>
            <NRadio
              value="frozen"
              data-testid="share-mode-frozen"
            >
              <div class="mode-item">
                <span class="mode-name">{{ t('share.create.frozenLabel') }}</span>
                <span class="mode-desc">{{ t('share.create.frozenDesc') }}</span>
                <span class="mode-note">{{ t('share.create.frozenNote') }}</span>
              </div>
            </NRadio>
          </div>
        </NRadioGroup>
      </template>
      <!-- 批量 = 仅冻结快照：静态说明替代模式单选（live 多根锚定未提供） -->
      <div
        v-else
        class="batch-mode"
        data-testid="share-batch-mode"
      >
        <span class="mode-name">{{ t('share.create.frozenLabel') }}</span>
        <span class="mode-desc">{{ t('share.batch.frozenDesc') }}</span>
        <span class="mode-note">{{ t('share.create.frozenNote') }}</span>
      </div>

      <div class="mode-label pass-label">
        {{ t('share.pass.createLabel') }}
      </div>
      <NInput
        v-model:value="passphrase"
        type="password"
        show-password-on="click"
        clearable
        :placeholder="t('share.pass.createPlaceholder')"
        :maxlength="64"
        class="pass-input"
        data-testid="share-create-passphrase"
      >
        <template #prefix>
          <NIcon :size="14">
            <LockClosedOutline />
          </NIcon>
        </template>
      </NInput>
      <div class="mode-note">
        {{ t('share.pass.createNote') }}
      </div>

      <!-- 有效期（P-20261020-5）：创建时显式可见，默认值来自设置（live）/
           冻结副本 30 天；不主动改动则不显式发字段，服务端按设置兜底 -->
      <div class="mode-label ttl-label">
        {{ t('share.ttl.label') }}
      </div>
      <div
        class="ttl-row"
        data-testid="share-create-ttl-row"
      >
        <ShareTtlPicker
          :choice="ttlChoice"
          :date="ttlDate"
          select-test-id="share-create-ttl-select"
          date-test-id="share-create-ttl-date"
          @update:choice="onTtlChoice"
          @update:date="onTtlDate"
        />
      </div>
      <div
        class="mode-note ttl-hint"
        data-testid="share-create-ttl-hint"
      >
        {{ ttlHint }}
      </div>

      <NCheckbox
        v-model:checked="watermark"
        class="wm-check"
        data-testid="share-create-watermark"
      >
        <span class="mode-name">{{ t('share.create.watermarkLabel') }}</span>
        <span class="mode-note">{{ t('share.create.watermarkNote') }}</span>
      </NCheckbox>

      <NCheckbox
        v-if="!isBatch"
        v-model:checked="viewOnce"
        :disabled="viewOnceDisabled"
        class="wm-check"
        data-testid="share-create-viewonce"
      >
        <span class="mode-name">{{ t('share.create.viewOnceLabel') }}</span>
        <span class="mode-note">{{ viewOnceDisabled ? t('share.create.viewOnceFrozenNote') : t('share.create.viewOnceNote') }}</span>
      </NCheckbox>
    </div>

    <template #footer>
      <div class="create-footer">
        <NButton
          size="small"
          quaternary
          data-testid="share-create-cancel"
          @click="cancelCreate"
        >
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          :disabled="ttlInvalid"
          data-testid="share-create-confirm"
          @click="confirmCreate"
        >
          <template #icon>
            <NIcon><ShareSocialOutline /></NIcon>
          </template>
          {{ t('share.create.confirm') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.share-create { min-width: 320px; }
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
/* 单文件 HTML 提示（P-20261020-4）：警示色与敏感文件警示同语义——不是错误，
   而是分享边界的前置知情 */
.single-html-note {
  margin-top: 10px;
  padding: 7px 10px;
  border: 1px solid var(--accent-orange, #d97706);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent-orange, #d97706) 10%, transparent);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.batch-box {
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-elevated);
}
.batch-list { margin: 0; padding-left: 16px; max-height: 132px; overflow: auto; }
.batch-path {
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  word-break: break-all;
  line-height: 1.6;
}
.batch-estimate { margin-top: 6px; font-size: 11.5px; color: var(--text-muted); }
.batch-estimate.over { color: var(--accent-orange); }
.over-tip { display: block; margin-top: 2px; font-weight: 500; }
.batch-mode {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 14px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
}
.mode-label { margin-top: 14px; font-size: 12.5px; color: var(--text-secondary); }
.mode-options { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
.mode-item { display: flex; flex-direction: column; gap: 2px; }
.mode-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.mode-desc { font-size: 12px; color: var(--text-secondary); }
.mode-note { font-size: 11.5px; color: var(--text-muted); }
.pass-label { margin-top: 16px; }
.pass-input { margin-top: 8px; }
/* 有效期行：选择器 + 自定义日期同排（与结果卡/管理器弹层同控件） */
.ttl-label { margin-top: 16px; }
.ttl-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.ttl-hint { margin-top: 6px; }
.wm-check { display: flex; margin-top: 16px; align-items: flex-start; }
.wm-check .mode-note { display: block; margin-top: 2px; font-weight: 400; }
.create-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
