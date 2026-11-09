// 终端输出分享选项流（P-20261106-9）：终端 tab 右键「直播分享」「分享输出快照」
// 两入口共用的创建前选项弹层——敏感值遮蔽（缺省开：安全默认不可让步）+ 访客页
// 溯源水印（缺省开）+ 可选访问口令（P-20261107-4⑤）+ 有效期（P-20261107-4①）。
// 模块级单例状态（useShareDialog 同范式：入口只开弹层，确认才发请求；弹层宿主

// 确认才发请求；弹层宿主 ShareTermOptionsDialog 挂 App 层 ShareDialogsHost，只消费
//
// 纪律：
//   - 关闭遮蔽只就地警示，真正的出域警示确认发生在「创建」点击时（出域动作的
//     发生点，confirmUnfilteredEgress）；取消 = 弹层保持打开、零副作用
//   - 遮蔽是服务端源头参数（直播 feeder / 快照净化链），访客侧不存在渲染过滤；
//     设置创建时定死——进行中分享不可切，改配置须撤销重建（服务端同口径：两模式
//     恒不同链，幂等命中沿用既有记录配置，前端如实回告 modeMismatch）
//   - 每次打开重置为安全基线：弹层是单例，残留会把上一目标的「关闭遮蔽」/口令
//     带给下一目标（口令空串 = 不设门 = 安全基线）
//   - 有效期语义（两形态服务端面不同，前端如实分流）：
//     · 直播：POST /share/terminal 直收 ttlMinutes（0/缺省 = 服务端默认 30 分钟，
//       钳 24h 上限、无永久档）。幂等命中既有直播时 store 不改倒计时（防无意识
//       续期），显式选择经既有 /share/:token/expiry 端点对账生效（文件分享创建
//       流 applyExplicitExpiry 同语义：只有显式选择才改期）
//     · 快照：创建面无 TTL 字段（服务端默认 30 天、未过滤强制 24h），显式选择
//       经同一 /share/:token/expiry 端点创建后立即生效（permanent = 恢复永久，
//       服务端对未过滤记录钳 24h）
//   - 结果卡/地址计划/敏感会话出域闸门全部复用 useShareDialog 既有原语（同一
//     结果卡单例、同一地址口径、同一 override 二次请求契约）
import { ref } from 'vue'
import { shareApi, type ShareInfo, type TermShareOptions } from '../api/domains/share'
import { bumpTerminalLiveShares } from './useTerminalLiveShares'
import { confirmDialog } from './useDialog'
import { confirmSensitiveSessionEgress, loadAddressContext, planFor, useShareDialog } from './useShareDialog'
import { shareTtlExpiresAt, type ShareTtlChoice } from '../utils/shareTtl'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import i18n from '../i18n'

export type TermShareKind = 'live' | 'frozen'

/** 选项确认结果：created = 已创建（结果卡已弹）；modeMismatch = 命中该会话既有
 *  直播、沿用其遮蔽设置（与本次请求不同，宿主应提示「改配置须先结束直播」）；
 *  cancelled = 用户在出域/敏感警示处取消（弹层保持打开可改选）；failed = 请求
 *  失败（拦截器已 toast，弹层保持打开可重试） */
export type TermShareConfirmResult = 'created' | 'modeMismatch' | 'cancelled' | 'failed'

const showTermOptions = ref(false)
const termOptionsTarget = ref<{ kind: TermShareKind; sessionId: string; name: string } | null>(null)
const termMask = ref(true)
const termWatermark = ref(true)
// 口令（⑤）：空串 = 不设门（安全基线）；明文只随创建请求发出，不落本地存储
const termPassphrase = ref('')
// 直播有效期（①）：分钟数；0 = 跟随服务端默认（不发字段）
const termLiveTtlMinutes = ref(0)
// 快照有效期（①）：复用文件分享创建流的档位表（custom 缺日期时禁提交）；
// touched=false = 未动过 → 不调 /expiry（保持服务端默认 30 天，存量语义）
const termFrozenTtlChoice = ref<ShareTtlChoice>('30d')
const termFrozenTtlDate = ref<number | null>(null)
const termFrozenTtlTouched = ref(false)
// 确认进行中（出域警示/请求在途）：弹层按钮 loading 且防重复提交
const termSubmitting = ref(false)

/**
 * 关闭敏感值遮蔽的出域警示确认（P-20261106-9）：警示型 confirm（取消即不动、
 * 零副作用），与敏感会话出域警示同族交互；文案带会话显示名与「未过滤」后果
 */
export function confirmUnfilteredEgress(sessionName: string, kind: TermShareKind): Promise<boolean> {
  const t = i18n.global.t
  return confirmDialog({
    type: 'error',
    title: t('share.termOptions.egressTitle'),
    content: t(kind === 'frozen' ? 'share.termOptions.egressIntroFrozen' : 'share.termOptions.egressIntroLive', { name: sessionName }),
    confirmText: t('share.termOptions.egressConfirm'),
  })
}

/** 会话显示名（store 反查，缺省回落 id——警示与弹层标题自明即可） */
function sessionDisplayName(sessionId: string): string {
  return useTerminalSessionsStore().sessions.find(s => s.id === sessionId)?.name || sessionId
}

/** 显式选择 → /share/:token/expiry 的绝对时点；custom 缺日期视为未选择（null） */
function frozenExpiryTarget(): string | null | undefined {
  if (!termFrozenTtlTouched.value) return undefined
  if (termFrozenTtlChoice.value === 'custom') {
    return shareTtlExpiresAt('custom', termFrozenTtlDate.value) || undefined
  }
  return shareTtlExpiresAt(termFrozenTtlChoice.value, null)
}

/** 直播显式档位 → 对账允许窗（±1 分钟）；fresh 创建服务端即按 ttlMinutes 落，
 *  差值在窗内不二次请求，只有幂等命中（倒计时保持旧值）才补对账 */
const TTL_RECONCILE_TOLERANCE_MS = 60_000

export function useTermShareDialog() {
  const { openResult } = useShareDialog()

  /** 打开选项弹层：每次重置为安全基线（遮蔽开、水印开、无口令、跟随默认档） */
  function openTermOptions(kind: TermShareKind, sessionId: string): void {
    if (!sessionId) return
    termOptionsTarget.value = { kind, sessionId, name: sessionDisplayName(sessionId) }
    termMask.value = true
    termWatermark.value = true
    termPassphrase.value = ''
    termLiveTtlMinutes.value = 0
    termFrozenTtlChoice.value = '30d'
    termFrozenTtlDate.value = null
    termFrozenTtlTouched.value = false
    termSubmitting.value = false
    showTermOptions.value = true
  }

  function cancelTermOptions(): void {
    if (termSubmitting.value) return
    showTermOptions.value = false
  }

  /**
   * 开终端只读直播入口（P-20261003-306）：token→会话，访客看只读输出流（默认
   * 30 分钟 TTL，撤销/轮换走管理面同族端点）——先经选项弹层，确认后创建
   */
  function createTerminalLive(sessionId: string): void {
    openTermOptions('live', sessionId)
  }

  /**
   * 冻结当前终端输出为快照链接入口（P-20261005-205）：服务端在创建时刻取
   * scrollback 全量缓冲定格（默认 30 天 TTL；未过滤快照强制 24h）——先经
   * 选项弹层，确认后创建
   */
  function createTerminalFrozen(sessionId: string): void {
    openTermOptions('frozen', sessionId)
  }

  /** 成功收尾：先收选项弹层再弹结果卡（不叠两层模态）；passphrase 仅随本次
   *  创建会话传入结果卡（「复制邀请信息」用），关闭即丢弃 */
  function finishCreated(created: ShareInfo, context: Awaited<ReturnType<typeof loadAddressContext>>, passphrase = ''): void {
    showTermOptions.value = false
    openResult(created, planFor(created.token, context.status, context.extras), passphrase)
  }

  /**
   * 两形态共用创建链：敏感出域闸门（P-20261003-155）——会话被标记敏感且未确认
   * 时服务端不创建、响应仅带 warnings，弹「确认出域」后带 override 二次请求
   *（文件分享扫描同一契约）。返回生效记录 + 地址上下文 / 'cancelled'（用户取消）/
   * null（失败）。上下文随创建并行取（P-20261020-2），有效期对账改写记录后仍用
   * 同一份地址计划
   */
  async function requestCreate(kind: TermShareKind, sessionId: string, name: string, ttlMinutes: number, opts: TermShareOptions): Promise<{ share: ShareInfo; context: Awaited<ReturnType<typeof loadAddressContext>> } | 'cancelled' | null> {
    const call = (override: boolean) => kind === 'live'
      ? shareApi.createTerminal(sessionId, ttlMinutes || undefined, override, opts)
      : shareApi.createTerminalFrozen(sessionId, override, opts)
    try {
      const [firstRaw, context] = await Promise.all([call(false), loadAddressContext()])
      let created = firstRaw as unknown as { data?: ShareInfo; warnings?: string[] }
      if (!created?.data && created?.warnings?.length) {
        if (!(await confirmSensitiveSessionEgress(name))) return 'cancelled'
        created = await call(true) as unknown as { data?: ShareInfo; warnings?: string[] }
      }
      if (!created?.data) return null
      return { share: created.data, context }
    } catch { /* 拦截器处理 */ }
    return null
  }

  /**
   * 选项弹层确认：关闭遮蔽时先弹出域警示（取消 = 弹层保持打开、零副作用），
   * 再走对应形态的创建链。有效期显式选择经 /share/:token/expiry 对账生效
   *（P-20261020-5 文件创建流 applyExplicitExpiry 同语义：只有显式选择才改期；
   * 失败 = 拦截器已提示，结果卡展示生效记录，可在结果卡有效期行重试）
   */
  async function confirmTermOptions(): Promise<TermShareConfirmResult> {
    const target = termOptionsTarget.value
    if (!target || termSubmitting.value) return 'cancelled'
    const opts: TermShareOptions = { unfiltered: !termMask.value, watermark: termWatermark.value }
    if (termPassphrase.value) opts.passphrase = termPassphrase.value
    const ttlMinutes = termLiveTtlMinutes.value
    const frozenTarget = target.kind === 'frozen' ? frozenExpiryTarget() : undefined
    termSubmitting.value = true
    try {
      if (opts.unfiltered && !(await confirmUnfilteredEgress(target.name, target.kind))) return 'cancelled'
      const res = await requestCreate(target.kind, target.sessionId, target.name, ttlMinutes, opts)
      if (res === 'cancelled') return 'cancelled'
      if (!res) return 'failed'
      let created = res.share
      const context = res.context
      // 有效期显式选择对账（见函数头注）：live 幂等命中差值在允许窗内跳过
      //（fresh 创建已按请求落），frozen 只在 touched 时调
      if (target.kind === 'live' && ttlMinutes > 0) {
        const want = Date.now() + ttlMinutes * 60_000
        const have = created.expiresAt ? new Date(created.expiresAt).getTime() : 0
        if (Math.abs(have - want) > TTL_RECONCILE_TOLERANCE_MS) {
          try {
            const r = await shareApi.setExpiry(created.token, new Date(want).toISOString()) as unknown as { data?: ShareInfo }
            if (r?.data) created = r.data
          } catch { /* 拦截器已提示；结果卡展示生效记录 */ }
        }
      } else if (target.kind === 'frozen' && frozenTarget !== undefined) {
        try {
          const r = await shareApi.setExpiry(created.token, frozenTarget) as unknown as { data?: ShareInfo }
          if (r?.data) created = r.data
        } catch { /* 同上 */ }
      }
      // 幂等命中同会话既有直播（创建时定死）：返回记录的遮蔽模式与本次请求
      // 不同——如实回告，由弹层宿主提示「沿用既有设置，改配置须先结束直播」
      const mismatch = (created.unfiltered === true) !== (opts.unfiltered === true)
      finishCreated(created, context, opts.passphrase || '')
      // 主播侧直播徽标（P-20261005-161）：创建成功即对账，tab 红点不等轮询
      if (target.kind === 'live') bumpTerminalLiveShares()
      return mismatch ? 'modeMismatch' : 'created'
    } finally {
      termSubmitting.value = false
    }
  }

  return {
    showTermOptions, termOptionsTarget, termMask, termWatermark, termPassphrase,
    termLiveTtlMinutes, termFrozenTtlChoice, termFrozenTtlDate, termFrozenTtlTouched,
    termSubmitting,
    createTerminalLive, createTerminalFrozen, confirmTermOptions, cancelTermOptions,
  }
}
