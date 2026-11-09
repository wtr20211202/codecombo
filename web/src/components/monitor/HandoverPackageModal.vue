<script setup lang="ts">
// 值班交接包弹窗（P-20261005-148）：值班大屏/通知中心两入口共用的自包含弹层
// ——生成 markdown 交接文档（useHandoverPackage 装配），双出口：复制
// （utils/clipboard copyText，健壮性红线通道）/ 分享短链（复用 useSnippetShare
// 的 requestCreate：snippet 创建与子服务状态并行取，24h 自动过期）。弹窗
// 自宿主渲染短链结果（成因：ShareResultDialog 当时只挂 Layout、值班大屏独立
// 路由够不到；P-20261108-1 上提 App 层后已全路由可达，此处仍内嵌渲染——
// 结果与交接文档同屏、不叠第二层模态），失败可重生成恢复，不销毁已生成内容。
// 敏感提示是显式常驻注记（提案 MVP 边界：声明含会话名与审批摘要，不做内容级
// 全量遮蔽；自由文本字段已在上游经 maskApprovalSecrets/maskSensitive 兜底）。
// 访问口令（P-20261020-6）：交接文档含会话名与审批摘要，分享出口可选设门；
// 设门后结果区提供「复制邀请信息」（链接+本次明文口令+TTL）。明文只存在于
// 输入框与分享快照两处，成功分享即清输入框、关闭/重新生成即清快照，不进
// URL/二维码。短链走分享地址计划（P-20261020-6 复用 buildRelayPlan 三形态），
// 回环入口下给手机可达的局域网地址，而不是只对当前浏览器有效的 localhost。
import { computed, ref, watch } from 'vue'
import { createDiscreteApi, NButton, NCheckbox, NIcon, NInput, NModal, NSpin } from 'naive-ui'
import { CopyOutline, LockClosedOutline, ShareSocialOutline, RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useThemeStore } from '../../stores/theme'
import { useHandoverPackage } from '../../composables/useHandoverPackage'
import { useSnippetShare } from '../../composables/useSnippetShare'
import { useShareAddressPlan } from '../../composables/useShareAddressPlan'
import { SNIPPET_MAX_BYTES } from '../../api/domains/share'
import { copyText } from '../../utils/clipboard'
import { buildShareInviteText } from '../../utils/shareInvite'
import { formatDateTime } from '../../utils/git'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const { t } = useI18n()
const themeStore = useThemeStore()
// 离散 message（useClaudeRelay 同范式）：弹窗两宿主（值班大屏独立路由/通知
// 中心浮层）统一走离散注入，不依赖祖先 NMessageProvider 的挂载差异
const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({
    theme: themeStore.naiveTheme,
    themeOverrides: themeStore.naiveOverrides,
  })),
})

const { generating, doc, generate } = useHandoverPackage()
const { requestCreate } = useSnippetShare()
// 与分享结果卡/管理器同一份地址口径：复制出去的就是手机能打开的地址
const sharePlan = useShareAddressPlan()

const genFailed = ref(false)
const sharing = ref(false)
/** 分享结果（空 = 尚未分享）；重生成即清——结果卡描述「当前文档的短链」，
 *  快照内容寻址（新内容=新 token），旧链仍有效但已不代表面板里的文档 */
const shareUrl = ref('')
const shareExpiresAt = ref('')
// 访问口令（P-20261020-6）：usePassphrase 是本次分享的意愿，passphrase 是
// 输入中的明文；sharePassphrase 是「已创建那条链」的口令快照——输入后续
// 改动不应影响已发送链接的邀请信息
const usePassphrase = ref(false)
const passphrase = ref('')
const sharePassphrase = ref('')

watch(() => props.show, (show) => {
  if (show) {
    usePassphrase.value = false
    passphrase.value = ''
    sharePassphrase.value = ''
    void sharePlan.load()
    void regenerate()
  } else {
    // 关闭即丢弃明文；下次打开重新输入
    usePassphrase.value = false
    passphrase.value = ''
    sharePassphrase.value = ''
  }
})

/** 生成/重生成：失败置 genFailed（就地可重试，已生成内容保留不清） */
async function regenerate(): Promise<void> {
  genFailed.value = false
  shareUrl.value = ''
  shareExpiresAt.value = ''
  sharePassphrase.value = ''
  try {
    await generate()
  } catch {
    genFailed.value = true
  }
}

const docText = computed(() => doc.value ?? '')
const overLimit = computed(() => new TextEncoder().encode(docText.value).length > SNIPPET_MAX_BYTES)

async function onCopy(): Promise<void> {
  const ok = await copyText(docText.value)
  if (ok) message.success(t('handover.copied'))
  else message.error(t('common.copyFailed'))
}

/** 分享出口：32KiB 超限客户端先拦（服务端 413 兜底）；创建成功拼访客短链。
 *  设门时空口令在按钮禁用层已拦（不会把「勾了设门却没输入」当成无门口令）。
 *  snippet 名显式携带档位日期，分享管理列表可辨 */
async function onShare(): Promise<void> {
  if (sharing.value || !docText.value || overLimit.value) return
  if (usePassphrase.value && !passphrase.value) return
  sharing.value = true
  try {
    const name = t('handover.shareName', { date: new Date().toLocaleDateString() })
    const secret = usePassphrase.value ? passphrase.value : ''
    const res = await requestCreate(docText.value, name, false, secret)
    if (!res.share) {
      message.error(t('handover.shareFailed'))
      return
    }
    // 统一地址计划（P-20261020-2）：创建请求已与子服务状态/分享基址/候选
    // 同批取得 plan；沿用 P-6 的兜底——计划为空时等一次管理器侧加载再试
    let url = res.plan?.url || sharePlan.urlOf(res.share.token)
    if (!url) {
      await sharePlan.load()
      url = sharePlan.urlOf(res.share.token)
    }
    shareUrl.value = url
    shareExpiresAt.value = res.share.expiresAt || ''
    if (!shareUrl.value) {
      message.warning(t('share.serviceDown'))
      return
    }
    sharePassphrase.value = secret
    // 输入框里的明文已被 sharePassphrase 快照接管：清掉一份少暴露一份
    passphrase.value = ''
    message.success(t('handover.shared'))
  } catch {
    message.error(t('handover.shareFailed'))
  } finally {
    sharing.value = false
  }
}

async function copyLink(): Promise<void> {
  const ok = await copyText(shareUrl.value)
  if (ok) message.success(t('handover.linkCopied'))
  else message.error(t('common.copyFailed'))
}

/** 邀请信息：链接 + 本次明文口令 + 到期时点（24h 固定），一次复制交付 */
const inviteText = computed(() => {
  if (!shareUrl.value || !sharePassphrase.value) return ''
  return buildShareInviteText({
    url: shareUrl.value,
    passphrase: sharePassphrase.value,
    expiresText: shareExpiresAt.value ? formatDateTime(shareExpiresAt.value) : undefined,
  }, {
    link: t('share.invite.link'),
    passphrase: t('share.invite.passphrase'),
    expires: t('share.invite.expires'),
    permanent: t('share.invite.permanent'),
    viewOnce: t('share.invite.once'),
  })
})

async function copyInvite(): Promise<void> {
  if (!inviteText.value) return
  const ok = await copyText(inviteText.value)
  if (ok) message.success(t('handover.inviteCopied'))
  else message.error(t('common.copyFailed'))
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    class="handover-modal"
    :title="t('handover.modalTitle')"
    :bordered="false"
    size="small"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <NSpin :show="generating">
      <div
        class="handover-body"
        data-testid="handover-modal"
      >
        <div
          v-if="genFailed && !docText"
          class="handover-fail"
          data-testid="handover-gen-failed"
        >
          <span>{{ t('handover.genFailed') }}</span>
          <NButton
            size="tiny"
            type="primary"
            secondary
            @click="regenerate"
          >
            {{ t('handover.regenerate') }}
          </NButton>
        </div>
        <NInput
          v-else
          :value="docText"
          type="textarea"
          readonly
          :placeholder="t('handover.generating')"
          :autosize="{ minRows: 12, maxRows: 20 }"
          class="handover-doc"
          data-testid="handover-doc"
        />
        <div class="handover-notes">
          <div class="note warn">
            <NIcon
              size="14"
              class="note-icon"
            >
              <ShareSocialOutline />
            </NIcon>
            <span>{{ t('handover.sensitiveNote') }}</span>
          </div>
          <div class="note muted">
            <span>{{ t('handover.liveNote') }}</span>
          </div>
        </div>
        <!-- 分享出口的口令开关（P-20261020-6）：已生成短链后隐藏（改动需
             重新生成再分享），避免输入值与已发送链接的口令不一致 -->
        <div
          v-if="!shareUrl"
          class="handover-pass"
        >
          <NCheckbox
            v-model:checked="usePassphrase"
            data-testid="handover-pass-toggle"
          >
            {{ t('handover.passToggle') }}
          </NCheckbox>
          <NInput
            v-if="usePassphrase"
            v-model:value="passphrase"
            type="password"
            show-password-on="click"
            clearable
            :placeholder="t('share.pass.createPlaceholder')"
            :maxlength="64"
            size="small"
            data-testid="handover-pass-input"
          >
            <template #prefix>
              <NIcon :size="14">
                <LockClosedOutline />
              </NIcon>
            </template>
          </NInput>
          <span
            v-if="usePassphrase"
            class="pass-note"
          >{{ t('handover.passNote') }}</span>
        </div>
        <!-- 分享结果卡：短链 + 复制 + TTL/静态快照注记（只读复看，重生成可刷新） -->
        <div
          v-if="shareUrl"
          class="handover-share-result"
          data-testid="handover-share-result"
        >
          <div class="share-url-row">
            <span class="share-label">{{ t('handover.shareLinkLabel') }}</span>
            <span
              class="share-url"
              data-testid="handover-share-url"
            >{{ shareUrl }}</span>
            <NButton
              size="tiny"
              quaternary
              data-testid="handover-share-link-copy"
              @click="copyLink"
            >
              <NIcon size="13">
                <CopyOutline />
              </NIcon>
              {{ t('handover.copyLink') }}
            </NButton>
            <NButton
              v-if="sharePassphrase"
              size="tiny"
              quaternary
              data-testid="handover-share-invite-copy"
              @click="copyInvite"
            >
              <NIcon size="13">
                <CopyOutline />
              </NIcon>
              {{ t('handover.copyInvite') }}
            </NButton>
          </div>
          <div class="share-notes">
            <span>{{ shareExpiresAt ? t('handover.ttlNoteAt', { time: new Date(shareExpiresAt).toLocaleString() }) : t('handover.ttlNote') }}</span>
            <span v-if="sharePassphrase">{{ t('handover.passSharedNote') }}</span>
            <span>{{ t('handover.liveNote') }}</span>
          </div>
        </div>
      </div>
    </NSpin>
    <template #footer>
      <div class="handover-footer">
        <NButton
          size="small"
          quaternary
          :title="t('handover.regenerateTitle')"
          data-testid="handover-regenerate"
          :disabled="generating"
          @click="regenerate"
        >
          <NIcon size="14">
            <RefreshOutline />
          </NIcon>
          {{ t('handover.regenerate') }}
        </NButton>
        <div class="footer-actions">
          <NButton
            size="small"
            secondary
            data-testid="handover-copy"
            :disabled="!docText || generating"
            @click="onCopy"
          >
            <NIcon
              size="14"
              class="btn-icon"
            >
              <CopyOutline />
            </NIcon>
            {{ t('handover.copyBtn') }}
          </NButton>
          <NButton
            size="small"
            type="primary"
            data-testid="handover-share"
            :loading="sharing"
            :disabled="!docText || generating || overLimit || (usePassphrase && !passphrase)"
            :title="overLimit ? t('handover.overLimit', { n: SNIPPET_MAX_BYTES }) : ''"
            @click="onShare"
          >
            <NIcon
              size="14"
              class="btn-icon"
            >
              <ShareSocialOutline />
            </NIcon>
            {{ t('handover.shareBtn') }}
          </NButton>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.handover-modal {
  width: var(--modal-w-lg);
  max-width: 94vw;
}
.handover-body { display: flex; flex-direction: column; gap: 10px; }
.handover-doc :deep(textarea) {
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.55;
}
.handover-fail {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 12px; border-radius: 8px;
  background: var(--bg-warning); border: 1px solid var(--border-default);
  font-size: 12.5px; color: var(--accent-orange);
}
.handover-notes { display: flex; flex-direction: column; gap: 6px; }
.handover-pass { display: flex; flex-direction: column; gap: 6px; }
.pass-note { font-size: 11.5px; color: var(--text-muted); }
.note {
  display: flex; align-items: flex-start; gap: 7px;
  padding: 7px 11px; border-radius: 8px;
  font-size: 12px; line-height: 1.5;
}
.note.warn {
  background: var(--bg-warning); border: 1px solid var(--border-default);
  color: var(--accent-orange);
}
.note.muted { color: var(--text-muted); }
.note-icon { flex: 0 0 auto; margin-top: 2px; }
.handover-share-result {
  display: flex; flex-direction: column; gap: 6px;
  padding: 9px 12px; border-radius: 8px;
  background: var(--bg-hover); border: 1px solid var(--border-default);
}
.share-url-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.share-label { flex-shrink: 0; font-size: 12px; color: var(--text-secondary); }
.share-url {
  flex: 1; min-width: 0;
  font-family: var(--font-mono); font-size: 12px; color: var(--accent-blue);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.share-notes { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; color: var(--text-muted); }
.handover-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.footer-actions { display: flex; gap: 8px; }
.btn-icon { margin-right: 4px; }
</style>
