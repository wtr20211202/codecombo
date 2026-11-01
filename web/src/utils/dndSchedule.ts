// 通知免打扰时段判定（P-20261002-40）：纯函数模块，无视图/存储依赖。
// 时区取运行环境本地时区（Date 的本地时分即本地钟面）；起止支持跨午夜
//（如 22:00 → 08:00）。调用方为 useDesktopNotify（桌面通知）、
// OpsChannelBridge（notify 类 toast）与 alertSound（等待音效）三处生效点，
// 通知中心入账不在静默范围。

/** 免打扰时段配置（本地时间 HH:mm；随 stores/dnd.ts 持久化于 localStorage） */
export interface DndWindow {
  /** 总开关：false 时任何时刻都不静默 */
  enabled: boolean
  /** 开始时刻 "HH:mm"（含） */
  start: string
  /** 结束时刻 "HH:mm"（不含——整点结束到下一日由跨午夜语义自然表达） */
  end: string
  /** 例外类别（P-20261003-115）：命中类别在时段内仍穿透（不静默）。可选字段
   * 兼容旧落盘数据（无该字段 = 未配置，由 stores/dnd.ts 归一化补默认值） */
  except?: string[]
  /** error 级穿透（P-20261004-117）：true（默认）= type 为 error 的通知在
   * 时段/手动档内仍提醒（警报可达性），false = 绝对静默（合法偏好）。可选字段
   * 兼容旧落盘数据（无该字段 = 未配置，归一化按默认开处理） */
  exceptError?: boolean
}

/**
 * 免打扰例外类别的全集（P-20261003-115）：通知中心五类别 + approval（审批等待
 * —— approval 卡不进通知中心，走卡片堆 + 等待音效通道，此处作为独立提醒类别
 * 纳管）。与 NotificationSettings 的类别清单共用 key，UI 多选据此渲染。
 */
// drop（P-20261006-51）：快投递是用户自己刚从手机投出的内容——到桌前期待它
// 在场，可选穿透合理（默认仍不穿透，缺省例外只有 approval）
export const DND_EXCEPTION_CATEGORIES = ['git', 'task', 'clone', 'system', 'error', 'approval', 'drop'] as const

/** 例外类别默认值：审批等待默认穿透——夜间挂机跑任务时审批裁决是关键路径，
 * agent 干等一夜的代价远大于一条提醒的打扰（提案动机） */
export const DND_EXCEPTION_DEFAULTS: string[] = ['approval']

/**
 * 类别是否命中例外表（命中 = 时段内仍穿透）：非数组视为无例外。只认全集内的
 * 值——落盘数据损坏/外来值不匹配任何真实类别，防垃圾值进入 UI 多选
 */
export function isExcepted(w: DndWindow, category: string): boolean {
  return Array.isArray(w.except) && (DND_EXCEPTION_CATEGORIES as readonly string[]).includes(category)
    && w.except.includes(category)
}

/** "HH:mm" → 当日分钟数（0~1439）；非法输入返回 null（判定层按不在时段处理） */
export function parseHm(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * 当前时刻是否落在免打扰时段内（[start, end) 半开区间，分钟精度）：
 * - 未启用 / 起止非法 / start === end（零长窗口）→ 不静默
 *   （fail-open：判不出时段就不静默，宁可打扰也不吞通知）
 * - start < end：同日窗口，start <= cur < end
 * - start > end：跨午夜窗口，cur >= start || cur < end
 */
export function isWithinDnd(w: DndWindow, now = new Date()): boolean {
  if (!w.enabled) return false
  const s = parseHm(w.start)
  const e = parseHm(w.end)
  if (s === null || e === null || s === e) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  if (s < e) return cur >= s && cur < e
  return cur >= s || cur < e
}

// ============== 手动临时免打扰（P-20261003-227） ==============
// 时段规则（上方分钟窗）之外的即时开关：会议/专注场景「现在起 1 小时勿扰」。
// 与时段规则在生效点 OR 组合（stores/dnd.ts isSilenced），例外类别在两源之上
// 统一判定——例外放行的是「免打扰门」本身，不区分静默来自时段还是手动档。

/**
 * 手动档持久化形态：到期时刻（毫秒 epoch）。null = 关；0 = 直到手动关的
 * 无到期哨兵（Infinity 无法过 JSON 序列化）；>0 = 绝对到期时刻。存绝对时刻
 * 而非剩余时长：跨刷新/重开页按挂钟对账语义稳定（与通知 snoozeUntil 同款惯例）
 */
export type ManualDndUntil = number | null

/** 快速档时长：1 小时（会议/专注场景的默认档） */
export const DND_MANUAL_QUICK_MS = 60 * 60 * 1000

/** 手动临时免打扰当前是否生效：>0 与挂钟比较（到点自动失效，fail-open 同
 * isWithinDnd——判不出就不静默），0 = 直到手动关恒真，null/负值 = 关 */
export function isManualDndActive(until: ManualDndUntil, now = Date.now()): boolean {
  if (until === null) return false
  if (until === 0) return true
  return until > now
}

/** 剩余毫秒（仅 >0 档有意义；关/直到手动关返回 null，调用方按需渲染） */
export function manualDndRemainingMs(until: ManualDndUntil, now = Date.now()): number | null {
  if (until === null || until <= 0) return null
  return Math.max(0, until - now)
}

/** 一段带日期的免打扰时间窗（毫秒，[startMs, endMs) 半开，与 isWithinDnd 同口径） */
export interface DndInterval {
  startMs: number
  endMs: number
}

/**
 * 最近一次「已结束」的免打扰时段（P-20261003-64 解除摘要行）：把 isWithinDnd
 * 的分钟窗换算为带日期的毫秒区间，供通知中心按条目时间过滤「免打扰期间错过
 * 的」。仍在窗口内（尚未解除）、未启用或起止非法时返回 null——摘要行只对
 * 「解除后」有意义。同日窗按 cur 在窗前/窗后落到昨天/今天；跨午夜窗解除后
 * 必处于 e..s 段，窗即昨天 start → 今天 end。
 */
export function lastEndedDndWindow(w: DndWindow, now = new Date()): DndInterval | null {
  if (!w.enabled) return null
  const s = parseHm(w.start)
  const e = parseHm(w.end)
  if (s === null || e === null || s === e) return null
  const cur = now.getHours() * 60 + now.getMinutes()
  const inWindow = s < e ? cur >= s && cur < e : cur >= s || cur < e
  if (inWindow) return null
  const start = new Date(now)
  const end = new Date(now)
  start.setHours(Math.floor(s / 60), s % 60, 0, 0)
  end.setHours(Math.floor(e / 60), e % 60, 0, 0)
  if (s < e) {
    // 同日窗：cur < s 说明今天的窗还没开始，最近已结束的是昨天那扇
    if (cur < s) {
      start.setDate(start.getDate() - 1)
      end.setDate(end.getDate() - 1)
    }
  } else {
    // 跨午夜窗：start 在昨天
    start.setDate(start.getDate() - 1)
  }
  return { startMs: start.getTime(), endMs: end.getTime() }
}
