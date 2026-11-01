// 分享邀请文案（P-20261020-6）：结果卡/管理器改口令后/交接包分享的「复制
// 邀请信息」统一走这里——链接 + 本次会话内已知的明文口令 + 有效期/一次性
// 说明。口令只作为文案行参与剪贴板输出，绝不拼进 URL 或二维码；关闭创建
// 结果卡后调用方即丢弃明文，本函数不持有任何状态。
//
// labels 里包含分隔符（中文「：」/英文「: 」），让标点随语言走；expiresText
// 由调用方用 formatDateTime + i18n 组装（本文件保持纯函数、零依赖）。
export interface ShareInviteLabels {
  /** 链接行前缀，含分隔符，如「分享链接：」 */
  link: string
  /** 口令行前缀，含分隔符 */
  passphrase: string
  /** 有效期行前缀，含分隔符 */
  expires: string
  /** 无有效期时的整行文案（如「长期有效，可随时撤销」） */
  permanent: string
  /** 一次性分享说明整行 */
  viewOnce: string
}

export interface ShareInviteInput {
  url: string
  /** 仅创建会话内已知的明文；空/缺省 = 未设口令，不输出该行 */
  passphrase?: string
  /** 已本地化的有效期时点；空 = 走 permanent 行 */
  expiresText?: string
  viewOnce?: boolean
}

export function buildShareInviteText(input: ShareInviteInput, labels: ShareInviteLabels): string {
  const lines = [`${labels.link}${input.url}`]
  if (input.passphrase) lines.push(`${labels.passphrase}${input.passphrase}`)
  lines.push(input.expiresText ? `${labels.expires}${input.expiresText}` : labels.permanent)
  if (input.viewOnce) lines.push(labels.viewOnce)
  return lines.join('\n')
}
