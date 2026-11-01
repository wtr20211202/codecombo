// 开工检查单当日显示纪律（P-20261005-219）的纯函数层。
// 显隐判定与 localStorage 当日已阅是「不做每日重复骚扰」契约的唯一事实源：
// - 当日语义 = 客户端本地日期 yyyy-MM-dd（横幅卡是设备侧 UX；服务端 brief.date
//   是人机对账锚，不参与本判定）
// - 存储 key 按日轮换（sc.morningBrief.<date>），跨天自然失效零清理负担
// - 值 = 已提醒条目键数组（'all' = 整卡当日已阅）；一律经 safeStorage 通道
//   （隐私模式/禁 Cookie 下静默降级，绝不裸访问 localStorage——健壮性红线）
// 显隐规则：源存在且计数非零且当日未被提醒才显示；全零/全已阅 = 零打扰（不渲染空卡）
import { safeStorage } from './storage'
import type { MorningBrief } from '../api/domains/system'

export type MorningBriefItemKey = 'unpushed' | 'runningAgents' | 'unread'

/** morningBriefStorageKey 当日已阅存储 key（按日轮换） */
export function morningBriefStorageKey(date: string): string {
  return `sc.morningBrief.${date}`
}

/** briefTodayKey 客户端本地当日 yyyy-MM-dd（当日语义的单一事实源） */
export function briefTodayKey(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** readBriefDismissed 读当日已阅清单：缺存储/损坏 JSON/形态不符一律按「未已阅」
 *  空清单回落——显示纪律宁可多重提醒一次，不因坏数据静默吞掉待办 */
export function readBriefDismissed(date: string): string[] {
  const raw = safeStorage.getItem(morningBriefStorageKey(date))
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/** dismissBriefItem 记当日已阅：'all' 整卡，或单项键。幂等；已整卡已阅后
 *  单项写入无意义不再扩清单 */
export function dismissBriefItem(date: string, key: MorningBriefItemKey | 'all'): void {
  if (key === 'all') {
    safeStorage.setItem(morningBriefStorageKey(date), JSON.stringify(['all']))
    return
  }
  const current = readBriefDismissed(date)
  if (current.includes('all') || current.includes(key)) return
  current.push(key)
  safeStorage.setItem(morningBriefStorageKey(date), JSON.stringify(current))
}

/** visibleBriefItems 当日应提醒的条目键（保序：未推送 → 会话 → 未读）。
 *  键缺席 = 服务端该源降级不可用（诚实降级，前端不猜测不补位） */
export function visibleBriefItems(brief: MorningBrief | null | undefined, dismissed: string[]): MorningBriefItemKey[] {
  if (!brief || dismissed.includes('all')) return []
  const keys: MorningBriefItemKey[] = []
  if (brief.unpushed && brief.unpushed.count > 0 && !dismissed.includes('unpushed')) keys.push('unpushed')
  if (brief.runningAgents && brief.runningAgents.count > 0 && !dismissed.includes('runningAgents')) keys.push('runningAgents')
  if (brief.unread && brief.unread.count > 0 && !dismissed.includes('unread')) keys.push('unread')
  return keys
}
