<script setup lang="ts">
// 分享结果卡：右键「分享」创建成功后的短链展示（复制/打开/去管理）。
// 状态在 useShareDialog 单例中，任意入口（文件树右键等）创建后即弹出；
// 服务未就绪时 url 为空——给出可行动提示而非报错堆栈。
// 有效期行（P-20261003-29 / P-20261020-5）：文件分享 opt-in TTL——默认「永久」
// 不动即零变化（不发请求），选择预设或自定义日期即刻生效；档位与创建弹层/
// 管理器共用 utils/shareTtl（1 小时/1 天/7 天/30 天/永久/自定义）；
// snippet 的 24h 固定窗口不提供此行（服务端拒绝调整）
// 二维码与邀请信息（P-20261020-6）：码/复制统一走地址计划（回环入口改局域
// 网候选，三色徽标提示可达性）；设了口令时额外提供「复制邀请信息」——明文
// 口令只在本次创建会话内存里，关闭结果卡即丢弃，绝不进 URL/二维码。
import { computed, ref, watch } from 'vue'
import { NModal, NButton, NIcon, NInput, NSelect, NDatePicker, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { CopyOutline, OpenOutline, ShareSocialOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useShareDialog } from '../../composables/useShareDialog'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { shareApi } from '../../api/domains/share'
import { formatDateTime } from '../../utils/git'
import { relativeTimeParts } from '../../utils/relative-time'
import { copyText } from '../../utils/clipboard'
import { buildShareInviteText } from '../../utils/shareInvite'
import ShareQrPanel from './ShareQrPanel.vue'
import ShareReachBadge from './ShareReachBadge.vue'
import { shareTtlExpiresAt, shareTtlFromExpiresAt, type ShareTtlChoice } from '../../utils/shareTtl'
import ShareTtlPicker from './ShareTtlPicker.vue'

const { t } = useI18n()
const message = useMessage()
const { showResult: show, resultShare, resultPassphrase, resultPlan, clearResultSecret } = useShareDialog()
const { toggleShareManager } = usePanelLayout()

const share = computed(() => resultShare.value)
const plan = computed(() => resultPlan.value)
// QR 面板解析出的最终短链（地址计划 + 子服务端口）；面板加载前为空，
// 打开/复制按钮随面板一起出现，避免先展示一个不可达的 localhost 链接
const inviteUrl = ref('')
// 关闭即丢弃明文口令与地址快照：下次打开（可能是另一条分享）在二维码面板
// 重新加载前不展示任何旧链接，避免「打开」误跳上一条分享
watch(show, (v) => {
  inviteUrl.value = ''
  if (!v) clearResultSecret()
})
// 各形态共用结果卡：描述按形态区分（片段强调公开文本 + 24h 过期；终端直播
// 强调只读遮蔽 + 默认 30 分钟过期——访客看得见、改不了；冻结快照强调内容
// 定格不可变 + 30 天保留，P-20261003-320；终端输出快照强调时点定格 + 会话
// 关闭后仍可访问，P-20261005-205）
const desc = computed(() => {
  if (share.value?.kind === 'snippet') return t('share.snippet.resultDesc')
  if (share.value?.kind === 'terminal') return t('share.terminal.resultDesc')
  if (share.value?.kind === 'terminal-frozen') return t('share.termFrozen.resultDesc')
  if (share.value?.kind === 'cast') return t('share.cast.resultDesc')
  if (share.value?.kind === 'session') return t('share.session.resultDesc')
  // 多路径冻结分享（P-20261008-1）：先说清「集合 + 定格」，再走 frozen 通用说明
  if (share.value?.paths?.length) return t('share.batch.resultDesc', { n: share.value.paths.length })
  if (share.value?.frozen) return t('share.frozen.resultDesc')
  return share.value?.isDir ? t('share.resultDirDesc') : t('share.resultFileDesc')
})

// 访问指标行（P-20261002-14）：重复分享恒返回同一条短链——结果卡顺带展示
// 历史暴露量，分享者对「这条链已经传开了」有即时感知（幂等重建不清零计数）
const hitsLine = computed(() => {
  const s = share.value
  if (!s) return ''
  if (!s.hits) return t('share.resultNeverAccessed')
  const p = relativeTimeParts(new Date(s.lastAccessAt || s.createdAt).getTime())
  return t('share.resultHitsLine', { n: s.hits, time: t(`share.${p.key}`, { n: p.n }) })
})

// ── 有效期（opt-in TTL）：选择即生效，失败回落已生效状态（错误 toast 由
// http 拦截器统一弹出，这里不重复报） ──
const ttlChoice = ref<ShareTtlChoice>('permanent')
const ttlDate = ref<number | null>(null)
// TTL 行仅文件分享提供（opt-in TTL）：snippet 24h 固定、terminal 默认 30 分钟
// 固定（直播是临时暴露面，服务端钳制不提供永久档）——两者的过期时点直接展示
const isFileShare = computed(() => share.value?.kind === 'file')

/** 从记录当前状态回填选择器（弹窗打开 / 失败回落共用） */
function syncTtl() {
  const next = shareTtlFromExpiresAt(share.value?.kind === 'file' ? share.value.expiresAt : null)
  ttlChoice.value = next.choice
  ttlDate.value = next.date
}
watch(show, (v) => { if (v) syncTtl() })

/** 落库并回写结果卡（响应即更新后的记录） */
async function applyExpiry(expiresAt: string | null) {
  const s = share.value
  if (!s) return
  try {
    // 拦截器已解包 envelope：返回值即 {data: 更新后的记录}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await shareApi.setExpiry(s.token, expiresAt)
    if (res?.data) resultShare.value = res.data
    message.success(t('share.ttl.updated'))
  } catch {
    syncTtl() // 拦截器已提示失败；选择器回落到记录的已生效状态
  }
}

async function onTtlChoice(v: ShareTtlChoice) {
  ttlChoice.value = v
  if (v === 'custom') {
    // custom：等日期选定再落（onTtlDate），选定前不发生请求
    ttlDate.value = null
    return
  }
  ttlDate.value = null
  await applyExpiry(shareTtlExpiresAt(v, null))
}

/** 自定义日期落定：取当日 23:59:59 本地时区（选中的日子当天全程有效） */
async function onTtlDate(ts: number | null) {
  ttlDate.value = ts
  if (ts == null) return
  await applyExpiry(shareTtlExpiresAt('custom', ts))
}

const ttlHint = computed(() => {
  const s = share.value
  if (!s || s.kind === 'snippet') return ''
  return s.expiresAt
    ? t('share.ttl.expiresAtLine', { date: formatDateTime(s.expiresAt) })
    : t('share.ttl.permanentLine')
})

// 邀请文案（P-20261020-6）：口令 / 有效期 / 一次性说明集中在一次复制里。
// 口令为空（未设门或幂等命中既有口令分享）时 invite 按钮不出现——不猜、
// 不给错口令；到期时点用既有 formatDateTime 口径
const inviteText = computed(() => {
  const s = share.value
  if (!s || !inviteUrl.value || !resultPassphrase.value) return ''
  return buildShareInviteText({
    url: inviteUrl.value,
    passphrase: resultPassphrase.value,
    expiresText: s.expiresAt ? formatDateTime(s.expiresAt) : undefined,
    viewOnce: s.viewOnce === true,
  }, {
    link: t('share.invite.link'),
    passphrase: t('share.invite.passphrase'),
    expires: t('share.invite.expires'),
    permanent: t('share.invite.permanent'),
    viewOnce: t('share.invite.once'),
  })
})

async function onCopyInvite() {
  if (!inviteText.value) return
  // copyText 带 execCommand 降级：局域网 http 访问（非安全上下文）时
  // navigator.clipboard 不存在，裸调用会静默失败
  const ok = await copyText(inviteText.value)
  if (ok) message.success(t('share.invite.copied'))
  else message.error(t('common.copyFailed'))
}

function onOpen(target: string) {
  if (target) window.open(target, '_blank', 'noopener')
}

function onManage() {
  show.value = false
  toggleShareManager()
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    class="share-result-modal"
    :title="t('share.resultTitle')"
  >
    <div class="share-result">
      <div class="result-icon">
        <NIcon
          size="30"
          color="var(--accent-blue)"
        >
          <ShareSocialOutline />
        </NIcon>
      </div>
      <div class="result-body">
        <div class="result-name">
          {{ share?.name }}
        </div>
        <div class="result-desc">
          {{ desc }}
        </div>
        <div
          class="result-hits"
          data-testid="share-result-hits"
        >
          {{ hitsLine }}
        </div>

        <!-- 有效期（opt-in TTL）：文件分享可选（默认永久 = 零变化），snippet 固定 24h 不提供 -->
        <template v-if="isFileShare">
          <div
            class="ttl-row"
            data-testid="share-ttl-row"
          >
            <span class="ttl-label">{{ t('share.ttl.label') }}</span>
            <ShareTtlPicker
              :choice="ttlChoice"
              :date="ttlDate"
              @update:choice="onTtlChoice"
              @update:date="onTtlDate"
            />
          </div>
          <div
            class="ttl-hint"
            data-testid="share-ttl-hint"
          >
            {{ ttlHint }}
          </div>
        </template>

        <!-- 可达性徽标（P-20261020-2）：同一份地址计划供复制/打开/管理器
             二维码使用；红/黄/绿给出发送前的可达性预期与处置指引 -->
        <div
          v-if="plan"
          class="result-reach"
        >
          <ShareReachBadge
            :state="plan.state"
            :source="plan.source"
            show-hint
          />
        </div>

        <ShareQrPanel
          v-if="share"
          :token="share.token"
          :active="show"
          :size="200"
          :show-copy="!resultPassphrase"
          testid-prefix="share-result-qr"
          @update:url="inviteUrl = $event"
        >
          <template #actions="{ url: qrUrl }">
            <NButton
              size="small"
              type="primary"
              @click="onOpen(qrUrl)"
            >
              <template #icon>
                <NIcon><OpenOutline /></NIcon>
              </template>
              {{ t('share.open') }}
            </NButton>
            <NButton
              v-if="resultPassphrase && inviteUrl"
              size="small"
              data-testid="share-invite-copy"
              @click="onCopyInvite"
            >
              <template #icon>
                <NIcon><CopyOutline /></NIcon>
              </template>
              {{ t('share.invite.copy') }}
            </NButton>
          </template>
        </ShareQrPanel>
        <template v-if="inviteUrl">
          <div class="result-tip">
            {{ t('share.resultTip') }}
          </div>
          <div
            v-if="resultPassphrase"
            class="result-tip secret"
            data-testid="share-invite-note"
          >
            {{ t('share.invite.secretNote') }}
          </div>
        </template>
      </div>
    </div>

    <template #footer>
      <div class="result-footer">
        <NButton
          size="small"
          quaternary
          @click="show = false"
        >
          {{ t('common.close') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          secondary
          @click="onManage"
        >
          {{ t('share.manageAll') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.share-result {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.result-icon {
  flex: 0 0 auto;
  width: 46px;
  height: 46px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--brand-accent-soft);
}
.result-body { flex: 1; min-width: 0; }
.result-reach { margin-top: 12px; }
.result-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-all;
}
.result-desc { margin-top: 4px; font-size: 12.5px; color: var(--text-secondary); }
/* 访问指标行：紧随描述，弱化但可见（未访问同样展示，暴露量 0 也是信息） */
.result-hits { margin-top: 3px; font-size: 12px; color: var(--text-muted); }
/* 有效期行：标签 + 预设选择（+ 自定义日期），与卡内输入控件同小尺寸 */
.ttl-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.ttl-label { flex-shrink: 0; font-size: 12.5px; color: var(--text-secondary); }
.ttl-hint { margin-top: 6px; font-size: 12px; color: var(--text-muted); }
.result-reach { margin-top: 12px; }
.link-row { display: flex; gap: 8px; margin-top: 12px; }
.link-row .n-input { flex: 1; }
.result-tip { margin-top: 10px; font-size: 12px; color: var(--text-secondary); }
.result-tip.warn { color: var(--accent-orange); }
.result-tip.secret { color: var(--accent-orange); }
.result-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
