<script setup lang="ts">
// 文本片段分享弹窗（P-20261002-71）：终端右键/编辑器右键/命令面板三入口共用。
// 确认框含内容长度（字节）与「将公开此文本」警示——片段走匿名短链，敏感面
// 提示是创建链路的显式一步；24h 自动过期在弹窗内预告（与文件分享不自动过期
// 的语义差异在文案中点明）。
// 一次性查看（P-20261006-27）：可选勾选——首位访客打开后进入 10 分钟宽限
// 窗、窗后失效；「发给同事看一眼」的排障贴正是一次性的主场景
// 访问口令（P-20261020-6）：可选输入——终端选区/交接文本常含敏感内容，
// 片段不再只能全公开；输入样式与提示复用文件分享弹层同一套键位
import { computed } from 'vue'
import { NButton, NCheckbox, NIcon, NInput, NModal, useMessage } from 'naive-ui'
import { LockClosedOutline, ShareSocialOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useSnippetShare } from '../../composables/useSnippetShare'

const { t } = useI18n()
const message = useMessage()

const {
  showDialog: show,
  draftContent: content,
  draftName: name,
  draftPassphrase: passphrase,
  draftViewOnce: viewOnce,
  submitting,
  byteLength,
  overLimit,
  maxBytes,
  closeDialog,
  submitSnippet,
} = useSnippetShare()

const canSubmit = computed(() => !!content.value.trim() && !overLimit.value && !submitting.value)

async function onCreate() {
  if (!canSubmit.value) return
  const ok = await submitSnippet()
  if (ok) message.success(t('share.snippet.created'))
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    class="share-snippet-modal"
    :title="t('share.snippet.dialogTitle')"
    :bordered="false"
    size="small"
    @after-leave="closeDialog"
  >
    <div class="snippet-form">
      <div class="field">
        <div class="label-row">
          <span class="label">{{ t('share.snippet.contentLabel') }}</span>
          <span
            class="byte-count"
            :class="{ over: overLimit }"
          >
            {{ t('share.snippet.byteCount', { n: byteLength, max: maxBytes }) }}
          </span>
        </div>
        <NInput
          v-model:value="content"
          type="textarea"
          :placeholder="t('share.snippet.contentPlaceholder')"
          :autosize="{ minRows: 8, maxRows: 16 }"
          class="mono"
        />
      </div>
      <div class="field">
        <span class="label">{{ t('share.snippet.nameLabel') }}</span>
        <NInput
          v-model:value="name"
          size="small"
          :placeholder="t('share.snippet.namePlaceholder')"
          maxlength="80"
        />
      </div>
      <div class="field">
        <span class="label">{{ t('share.pass.createLabel') }}</span>
        <NInput
          v-model:value="passphrase"
          type="password"
          show-password-on="click"
          clearable
          :placeholder="t('share.pass.createPlaceholder')"
          :maxlength="64"
          data-testid="snippet-share-passphrase"
        >
          <template #prefix>
            <NIcon :size="14">
              <LockClosedOutline />
            </NIcon>
          </template>
        </NInput>
        <span class="pass-note">{{ t('share.pass.createNote') }}</span>
      </div>
      <div class="warn-note">
        <NIcon
          size="14"
          class="warn-icon"
        >
          <ShareSocialOutline />
        </NIcon>
        <span>{{ passphrase ? t('share.snippet.publicWarningLocked') : t('share.snippet.publicWarning') }}</span>
      </div>
      <div class="expire-note">
        {{ t('share.snippet.expireNote') }}
      </div>
      <NCheckbox
        v-model:checked="viewOnce"
        class="once-check"
        data-testid="snippet-share-viewonce"
      >
        <span class="once-name">{{ t('share.create.viewOnceLabel') }}</span>
        <span class="once-note">{{ t('share.create.viewOnceNote') }}</span>
      </NCheckbox>
    </div>

    <template #footer>
      <div class="snippet-footer">
        <NButton
          size="small"
          quaternary
          @click="show = false"
        >
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          :disabled="!canSubmit"
          :loading="submitting"
          data-testid="snippet-share-create"
          @click="onCreate"
        >
          {{ t('share.snippet.create') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.snippet-form { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.label-row { display: flex; align-items: baseline; justify-content: space-between; }
.label { font-size: 12.5px; color: var(--text-secondary); }
.pass-note { font-size: 11.5px; color: var(--text-muted); }
.byte-count { font-size: 11.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.byte-count.over { color: var(--accent-red); font-weight: 600; }
.mono :deep(textarea) {
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.55;
}
.warn-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px 11px;
  border-radius: 8px;
  background: var(--bg-warning);
  border: 1px solid var(--border-default);
  font-size: 12px;
  color: var(--accent-orange);
  line-height: 1.5;
}
.warn-icon { flex: 0 0 auto; margin-top: 2px; }
.expire-note { font-size: 12px; color: var(--text-muted); }
.once-check { display: flex; align-items: flex-start; }
.once-check .once-name { font-size: 12.5px; font-weight: 500; color: var(--text-primary); }
.once-check .once-note { display: block; margin-top: 2px; font-size: 11.5px; font-weight: 400; color: var(--text-muted); }
.snippet-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
