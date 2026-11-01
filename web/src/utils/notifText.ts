import type { NotificationItem } from '../api/client'

// 通知文案渲染链（自 NotificationCenter.vue P-20261007-23 分域拆解迁入为共享
// 纯函数）：行呈现（NotificationRow）与条目复制（NotificationCenter 的
// notifPlainText 复制链）必须走同一实现——「所见即所复制」契约，展示链漂移
// 而复制链不动（或反之）会让粘贴内容与界面内容不一致。

type Translate = (key: string, params?: Record<string, unknown>) => string

// 模板化文案（日报 P-20261001-30）：titleKey/bodyKey 优先按 key + msgParams
// 走 i18n 模板（服务端产生的通知文案随界面语言渲染），title/body 原文回退。
// body 字段此时承载语言中立明细（提交主题列表等），附在翻译摘要行之后
export function notifTitleText(n: NotificationItem, t: Translate): string {
  return n.titleKey ? t(n.titleKey, n.msgParams ?? {}) : n.title
}

export function notifBodyText(n: NotificationItem, t: Translate): string {
  if (!n.bodyKey) return n.body ?? ''
  const summary = t(n.bodyKey, n.msgParams ?? {})
  return n.body ? `${summary}\n${n.body}` : summary
}

/** 条目复制（P-20261003-188）用的纯文本：title+body 拼接（量级：通知 title+body
 *  是短摘要文本，点击 handler 一次字符串拼接，零热路径零常驻内存） */
export function notifPlainText(n: NotificationItem, t: Translate): string {
  const title = notifTitleText(n, t)
  const body = notifBodyText(n, t)
  return body ? `${title}\n${body}` : title
}
