// 通知「稍后提醒」（P-20261003-36）的时刻纯函数（自 NotificationCenter.vue
// P-20261007-23 分域拆解迁入）：延后菜单三档算绝对时刻 + 到期展示格式化。
// 纯函数无组件依赖——通知行（NotificationRow）的到期展示与通知中心的延后
// toast（两条消费链）共用同一实现，格式漂移即在此一处对账。

/** 由菜单 key 算延后绝对时刻（ISO 串，传服务端打标 snoozeUntil） */
export function snoozeUntilFor(key: string | number): string {
  const d = new Date()
  if (key === 'min30') d.setMinutes(d.getMinutes() + 30)
  else if (key === 'hour1') d.setMinutes(d.getMinutes() + 60)
  else d.setDate(d.getDate() + 1) // 明天同一时刻：历法 +1 天，跨月/年与 DST 下仍落同一墙钟时刻
  return d.toISOString()
}

/** 延后到期展示：今天只看钟点，跨天带日期（本地时区，数字形态语言中立） */
export function formatSnoozeUntil(iso: string): string {
  const d = new Date(iso)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === new Date().toDateString()) return hm
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}
