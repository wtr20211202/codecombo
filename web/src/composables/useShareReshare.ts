import { useMessage } from 'naive-ui'
import { shareApi, type ShareInfo, type ShareMode } from '../api/domains/share'
import { AppError } from '../api/error-types'
import { confirmSensitiveFiles } from './useShareDialog'
import { useI18n } from './useI18n'
import { shareConsumed, shareExpired, shareHealth } from './useShareManagerList'
import type { ShareTtlChoice } from '../utils/shareTtl'

/** 重新分享可用性（纯函数，单测锚）：仅 file 分享、目标健康、归属项目仍在、
 * 且旧链已死（过期/一次性已消费）。仍活跃的行重复 create 是幂等 no-op，没有
 * 「重新分享」语义；异常行目标不存在，重建只会失败。批量记录（Paths 非空，
 * P-20261114-3-S1）同为 file 形态且走 createBatch 按原选择集重建，不在此排除。 */
export function shareCanReshare(s: ShareInfo, now: number, projectIds: ReadonlySet<string>): boolean {
  return s.kind === 'file' && !!s.projectId && projectIds.has(s.projectId)
    && shareHealth(s) === 'ok'
    && (shareConsumed(s) || shareExpired(s, now))
}

export interface ReshareConfig {
  projectId: string
  path: string
  mode: 'live' | 'frozen'
  passphrase: string
  watermark: boolean
  viewOnce: boolean
}

/**
 * 重建参数（纯函数）：沿用原 kind/mode/path/水印/一次性设置，口令由调用方
 * 重新输入（服务端只存 bcrypt 哈希，无法回读——不让「重新分享」静默
 * 降级成无口令）。有效期不沿用已过去的绝对时点：弹层默认档（P-20261114-3-S1）
 * frozen 30 天、live 服务端设置默认档——用户未动过就不显式发字段，由服务端
 * 按同一默认兜底（ShareReshareDialog 以此初始化）。
 */
export function reshareConfig(s: ShareInfo, passphrase = ''): ReshareConfig {
  return {
    projectId: s.projectId,
    path: s.path,
    mode: s.frozen ? 'frozen' : 'live',
    passphrase,
    watermark: s.watermark !== false,
    viewOnce: s.viewOnce === true,
  }
}

/** 重发弹层的提交载荷（ShareReshareDialog → runReshare/runBatchReshare）：
 * mode 弹层可改（默认沿用来源）；ttl/expiresAt 仅用户主动改过档位才携带，
 * 未动交服务端默认（与创建弹层 P-20261020-5 同契约）。批量行走
 * runBatchReshare，只消费 passphrase/watermark（createBatch 无 TTL 参数，
 * 服务端按 frozen 默认 30 天兜底）。 */
export interface ReshareSubmit {
  mode: ShareMode
  passphrase: string
  watermark: boolean
  viewOnce: boolean
  ttl?: ShareTtlChoice
  expiresAt?: string
}

/**
 * 行操作「重新分享」（P-20261020-10）：过期/已消费的 file 分享重建为新周期。
 * 同目标 idempotent create 会返回既有死记录，故必须「先撤销旧记录再创建」
 * ——旧链本已过期/消费（访客侧已失效），先删不制造新的坏链；创建仍走既有
 * create（敏感扫描 + 口令/水印设置保留，命中警告照常二次确认）。
 *
 * P-20261114-3-S1 起入口改开 ShareReshareDialog 显式确认面（模式/有效期/
 * 口令可核可改），本 composable 只承载撤销→重建链路：
 * - runReshare 单路径重建：弹层提交的 mode/ttl/口令直接生效（模式不再无引导
 *   沿用）；
 * - runBatchReshare 批量重建：重发链路只传单 path 不传 paths，批量记录若走
 *   单路径 create 会静默重建为「项目根」单路径分享（path 空 rel）——比服务端
 *   400 更糟的静默事故（评审修订点③），故批量行走 createBatch 传原 paths
 *   （服务端集合顺序无关幂等，同集合重建语义明确）；模式恒 frozen 由弹层锁定。
 */
export function useShareReshare(refresh: () => Promise<void> | void) {
  const message = useMessage()
  const { t } = useI18n()

  /** 撤销旧死链（404 = 清理 ticker 已收走，继续重建）→ create(override) 两段
   *  敏感扫描确认流 → 刷新列表对账。单路径/批量重建共用骨架。 */
  async function recreateAfterRevoke(s: ShareInfo, create: (override: boolean) => Promise<unknown>): Promise<void> {
    try {
      await shareApi.remove(s.token, { silent: true })
    } catch (e) {
      if (!(e instanceof AppError && e.status === 404)) {
        message.error(e instanceof AppError && e.userMessage ? e.userMessage : t('share.reshare.failed'))
        return
      }
    }
    try {
      // 拦截器已解包 envelope：返回值即 {data?, warnings?, scanTruncated?}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let res: any = await create(false)
      const warns = (res.warnings || []) as string[]
      if (warns.length) {
        if (!(await confirmSensitiveFiles(warns, res.scanTruncated === true))) {
          // 旧记录已撤销、新记录未创建：如实告知（旧链本已失效，不制造存活链损失）
          message.warning(t('share.reshare.abortedAfterRevoke'))
          await refresh()
          return
        }
        res = await create(true)
      }
      const next = res.data as ShareInfo | undefined
      await refresh()
      message.success(t('share.reshare.done', { name: next?.name ?? s.name }))
    } catch {
      // 创建失败（目标在确认窗口内被删等）：旧死记录已清，列表对账
      await refresh()
    }
  }

  /** 单路径重建（弹层确认后调用）。入口可用性由菜单 canReshare 把守，此处
   *  以同口径 projectIds 兜底再守一道（防未来新入口绕过菜单直调）。 */
  async function runReshare(s: ShareInfo, submit: ReshareSubmit, projectIds: ReadonlySet<string>): Promise<void> {
    if (!shareCanReshare(s, Date.now(), projectIds)) {
      message.warning(t('share.reshare.unavailable'))
      return
    }
    await recreateAfterRevoke(s, (override) => shareApi.create(
      s.projectId, s.path, override, submit.mode, submit.passphrase,
      submit.watermark, submit.viewOnce, submit.ttl, submit.expiresAt))
  }

  /** 批量重建（弹层确认后调用）：createBatch 传原 paths，不走单路径 create
   *  ——见类注释「静默事故」注记。projectIds 兜底守卫与 runReshare 同款。 */
  async function runBatchReshare(s: ShareInfo, passphrase: string, watermark: boolean, projectIds: ReadonlySet<string>): Promise<void> {
    if (!shareCanReshare(s, Date.now(), projectIds)) {
      message.warning(t('share.reshare.unavailable'))
      return
    }
    const paths = s.paths ?? []
    await recreateAfterRevoke(s, (override) => shareApi.createBatch(s.projectId, paths, override, passphrase, watermark))
  }

  return { runReshare, runBatchReshare }
}
