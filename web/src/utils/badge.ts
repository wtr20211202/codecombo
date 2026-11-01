// 角标数字格式化：超过 99 显示「99+」（业界惯例——原始计数既撑宽徽标又
// 无信息增量，200 与 201 对用户的行动含义相同）
export function formatBadgeCount(n: number): string | number {
  return n > 99 ? '99+' : n
}
