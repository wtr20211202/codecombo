import { describe, expect, it } from 'vitest'
import type { NotificationItem } from '../api/client'
import { notifBodyText, notifPlainText, notifTitleText } from './notifText'

// 通知文案渲染链共享纯函数（P-20261007-23 自 NotificationCenter.vue 迁入）：
// 行呈现（NotificationRow）与复制链（壳的 copyNotif）同一实现——「所见即所复制」。
// t 桩 = key 直通（同 naiveRuntime.tKey 口径），断言按 key 不按文案。

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

function base(partial: Partial<NotificationItem>): NotificationItem {
  return {
    id: 'a', type: 'info', category: 'system', title: '原标题', time: '2026-10-24T10:00:00Z', read: false,
    ...partial,
  }
}

describe('notifTitleText/notifBodyText 模板化文案（日报 P-20261001-30）', () => {
  it('无 key：title/body 原文回退', () => {
    const n = base({ title: '原标题', body: '原正文' })
    expect(notifTitleText(n, t)).toBe('原标题')
    expect(notifBodyText(n, t)).toBe('原正文')
  })

  it('有 key：按 key+msgParams 走 i18n 模板；body 原文附在翻译摘要行之后', () => {
    const n = base({ titleKey: 'daily.title', bodyKey: 'daily.body', msgParams: { date: '10-24' }, body: '明细行' })
    expect(notifTitleText(n, t)).toBe('daily.title:{"date":"10-24"}')
    expect(notifBodyText(n, t)).toBe('daily.body:{"date":"10-24"}\n明细行')
  })

  it('有 key 无 body：仅翻译摘要行；body 空串不追加换行', () => {
    const n = base({ bodyKey: 'daily.body', body: '' })
    expect(notifBodyText(n, t)).toBe('daily.body:{}') // t 桩：空参数对象也保留插值形态
  })
})

describe('notifPlainText 复制链（P-20261003-188）', () => {
  it('title+body 拼接；无 body 时仅 title（所见即所复制）', () => {
    expect(notifPlainText(base({ title: 'T', body: 'B' }), t)).toBe('T\nB')
    expect(notifPlainText(base({ title: 'T' }), t)).toBe('T')
    expect(notifPlainText(base({ bodyKey: 'k', body: 'x' }), t)).toBe('原标题\nk:{}\nx')
  })
})
