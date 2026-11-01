// 同文案 toast 短窗口去重：多个检查入口（如设置弹窗与首页面板）可能在很短
// 时间先后触发同一条提示，叠两层观感差。按 key 在窗口期内只放行一次。
const lastShown = new Map<string, number>()

export function shouldShowToast(key: string, windowMs = 5000): boolean {
  const now = Date.now()
  const last = lastShown.get(key) || 0
  if (now - last < windowMs) {
    return false
  }
  lastShown.set(key, now)
  return true
}
