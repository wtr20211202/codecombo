import { useMessage } from 'naive-ui'
import { shareApi, type ShareInfo } from '../api/domains/share'
import { AppError } from '../api/error-types'
import { confirmDialog, promptDialog } from './useDialog'
import { useI18n } from './useI18n'
import { confirmSensitiveFiles } from './useShareDialog'
import { shareConsumed, shareExpired, shareHealth } from './useShareManagerList'

/** 重新分享可用性（纯函数，单测锚）：仅 file 分享、目标健康、归属项目仍在、
 * 且旧链已死（过期/一次性已消费）。仍活跃的行重复 create 是幂等 no-op，没有
 * 「重新分享」语义；异常行目标不存在，重建只会失败。 */
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
 * 重新输入（服务端只存 bcrypt 哈希，无法回读原文——不让「重新分享」静默
 * 降级成无口令）。有效期不沿用已过去的绝对时点：live 回到永久、frozen 走
 * 服务端默认 30 天。
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

function passphraseBytes(v: string): number {
  return new TextEncoder().encode(v).length
}

/**
 * 行操作「重新分享」（P-20261020-10）：过期/已消费的 file 分享重建为新周期。
 * 同目标 idempotent create 会返回既有死记录，故必须「先撤销旧记录再创建」
 * ——旧链本已过期/消费（访客侧已失效），先删不制造新的坏链；创建仍走既有
 * create（敏感扫描 + 口令/水印设置全保留，命中警告照常二次确认）。
 *
 * 口令：有口令的旧链先弹口令输入（留空 = 明确重建为无口令），不静默丢门。
 */
export function useShareReshare(refresh: () => Promise<void> | void) {
  const message = useMessage()
  const { t } = useI18n()

  async function requestReshare(s: ShareInfo, projectIds: ReadonlySet<string>): Promise<void> {
    if (!shareCanReshare(s, Date.now(), projectIds)) {
      message.warning(t('share.reshare.unavailable'))
      return
    }
    let passphrase = ''
    if (s.hasPassphrase) {
      const input = await promptDialog({
        title: t('share.reshare.title'),
        label: t('share.reshare.passphraseLabel'),
        placeholder: t('share.reshare.passphrasePlaceholder'),
        inputType: 'password',
        hint: t('share.reshare.passphraseHint'),
        confirmText: t('share.reshare.action'),
        validate: (v) => (passphraseBytes(v) > 64 ? t('share.reshare.passphraseTooLong') : null),
      })
      if (input === null) return
      passphrase = input
    } else if (!(await confirmDialog({
      title: t('share.reshare.title'),
      content: t('share.reshare.confirm', { name: s.name }),
      confirmText: t('share.reshare.action'),
    }))) {
      return
    }
    await runReshare(s, passphrase)
  }

  async function runReshare(s: ShareInfo, passphrase: string): Promise<void> {
    const cfg = reshareConfig(s, passphrase)
    // 旧链已是死链（过期/消费），撤销 404 = 清理 ticker 已收走，继续重建
    try {
      await shareApi.remove(s.token, { silent: true })
    } catch (e) {
      if (!(e instanceof AppError && e.status === 404)) {
        message.error(e instanceof AppError && e.userMessage ? e.userMessage : t('share.reshare.failed'))
        return
      }
    }
    try {
      const create = (override: boolean) => shareApi.create(
        cfg.projectId, cfg.path, override, cfg.mode, cfg.passphrase, cfg.watermark, cfg.viewOnce)
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

  return { requestReshare }
}
