/**
 * 会话身份面纯函数（P-20261023-3）：侧栏行内「新/接续」徽标判据与行内
 * 创建/最近活动时间的短格式。数据面 = TerminalSessionInfo（createdAt/
 * derived/resumed，服务端权威）+ activityMap（OSC 133 命令边界，浏览器
 * 内存态）。
 *
 * 「尚无活动」取 OSC 命令边界口径而非服务端 lastActivity：agent TUI 启动
 * 即渲染输出、服务端活动时钟（PTY 字节面）随之刷新，「用户/agent 用过没」
 * 的语义边界是命令边界——与静默/停滞徽标（utils/session-idle）同族口径。
 * 浏览器内存态刷新即失的诚实边界同族：刷新后未见命令的近期会话重现「新」
 * 徽标，与「提示未用即语义」一致。
 */

/** 「新」徽标窗口（ms）：创建后 24h 内且尚无 OSC 命令活动 */
export const NEW_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000

/** 「新」徽标判据：窗口内创建 + 尚无 OSC 活动 + 非接续（接续会话有自己的
 *  徽标，两者不叠加——接续继承槽位旧名，身份语义是「复用」不是「新建」）。
 *  createdAt 缺失/不可解析 = 判不了，不亮（空显不虚构） */
export function isNewAgentSession(
  input: { createdAt?: string; resumed?: boolean; hasActivity: boolean },
  now = Date.now(),
): boolean {
  if (input.resumed) return false
  if (input.hasActivity) return false
  if (!input.createdAt) return false
  const t = Date.parse(input.createdAt)
  if (Number.isNaN(t)) return false
  const diff = now - t
  return diff >= 0 && diff <= NEW_SESSION_WINDOW_MS
}

/** 行内创建时间短格式：今日 HH:mm / 今年 MM-DD / 跨年 YYYY-MM-DD——数字
 *  宽度恒定（同名会话的第二区分维度，一行放得下），本地时区口径。缺失/
 *  不可解析返回空串（空显不虚构，调用方不渲染） */
export function formatSessionCreatedAt(createdAt: string | undefined, now = new Date()): string {
  if (!createdAt) return ''
  const t = new Date(createdAt)
  if (Number.isNaN(t.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameDay = t.getFullYear() === now.getFullYear()
    && t.getMonth() === now.getMonth()
    && t.getDate() === now.getDate()
  if (sameDay) return `${pad(t.getHours())}:${pad(t.getMinutes())}`
  if (t.getFullYear() === now.getFullYear()) return `${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

/** 行内最近活动短格式（浏览器 activityMap，OSC 133 口径）：压缩相对时间
 *  「3分/2时/4天」——行尾弱灰位一行放得下；完整相对文案（含「刚刚」）在
 *  tooltip，走既有 relativeTimeParts 键（i18n 归宿主）。无记录返回空串 */
export function formatSessionActivityShort(lastActivity: number | undefined, now = Date.now()): string {
  if (!lastActivity) return ''
  const minutes = Math.max(0, Math.floor((now - lastActivity) / 60_000))
  if (minutes < 1) return '' // 刚刚：无增量信息不占行宽（tooltip 有完整文案）
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}时`
  return `${Math.floor(hours / 24)}天`
}
