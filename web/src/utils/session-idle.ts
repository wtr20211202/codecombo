/**
 * 会话静默判据（P-20261003-53）：running 会话最后活动距今超阈值即视为「静默」
 * （长会话最隐蔽的停滞形态——卡在等输入，无事件无提醒）。数据源 =
 * terminal-sessions store 的 runningMap + activityMap（OSC 133 事件驱动），
 * 本模块只做纯判定，文案与展示在各宿主（侧栏会话行 / 悬浮列表 / 值班大屏卡）。
 * 阈值为常量起步（提案明确不设设置项）；合法长静默命令的误报以弱样式容忍，
 * 不弹窗不打断。
 *
 * 疑似停滞判据（P-20261004-37）：task.progress 声称 running 而 shell 侧证据
 * （OSC 133）表明命令已结束或输出久无动静——「任务在跑、shell 空闲」反组合
 * 持续超阈值即升级强标（弱标只说「无输出」，强标归因到「疑似停滞」），点击
 * 出分诊卡（宿主装配）。同在本模块纯判定，数据源另加 assistantTask.bySession。
 */

/** 静默阈值（分钟）：running 且无 OSC 133 活动超过它才亮标 */
export const SESSION_IDLE_THRESHOLD_MIN = 3

/** 停滞阈值（分钟）：反组合须持续超过它才升级「疑似停滞」——长于静默防抖
 *  （SESSION_IDLE_THRESHOLD_MIN），给合法长静默留出弱标观察档 */
export const SESSION_STALL_THRESHOLD_MIN = 5

/** 静默分钟数：非 running / 无活动记录 / 未超阈值返回 0（0 = 不亮标）。
 *  返回值向下取整到分钟——「无输出 N 分钟」弱标的 N；注意 reactivity 只跟随
 *  两张 map，分钟数不随时间自行跳动（与既有「最近活动」相对时间同口径） */
export function sessionIdleMinutes(
  running: boolean,
  lastActivity: number | undefined,
  now = Date.now(),
): number {
  if (!running || !lastActivity) return 0
  const elapsed = now - lastActivity
  if (elapsed < SESSION_IDLE_THRESHOLD_MIN * 60_000) return 0
  return Math.floor(elapsed / 60_000)
}

/** 静默文案键选择（P-20261003-198）：会话有 pending 审批时特化「等待裁决 N 分钟」
 *  ——同是静默，在等裁决的归因从「可能等输入/已停滞」精确到「等你裁决」，催办
 *  有上下文；无 pending 回落泛化文案（判据不变，只是文案分档）。返回 i18n 键由
 *  宿主翻译（relative-time 的 {key,n} 同款惯例，本模块保持无 i18n 依赖）；
 *  归属判定在宿主经 approvals store 的 pendingSessionIds（sessionId 关联复用） */
export function idleTextKeys(hasPendingApproval: boolean): { badge: string; tip: string } {
  return hasPendingApproval
    ? { badge: 'claudeSessions.idle.pendingBadge', tip: 'claudeSessions.idle.pendingTip' }
    : { badge: 'claudeSessions.idle.badge', tip: 'claudeSessions.idle.tip' }
}

/** 疑似停滞判据入参：两侧数据源由宿主装配（store 直读），本函数只做纯运算 */
export interface SessionStallInput {
  /** bySession[sid].status === 'running'：任务侧声称还在干活 */
  taskRunning: boolean
  /** runningMap[sid]：true=命令在跑 / false=已回提示符（D 已见）/ 缺省=无记录 */
  running?: boolean
  /** activityMap[sid]：最近 OSC 133 事件时刻（ms epoch；缺省=无记录） */
  lastActivity?: number
  /** bySession[sid].updatedAt：最近 task.progress 上报时刻（ms epoch） */
  lastReportAt?: number
  now?: number
}

/**
 * 疑似停滞分钟数（P-20261004-37）：返回「两侧都无动静」的分钟数，0 = 不亮标。
 *
 * 反组合两侧：任务侧 running（bySession）+ shell 侧空闲/静默（runningMap false
 * = 命令已结束无下一条——agent 已死或卡死的主形态；runningMap true 则须静默
 * 超停滞阈值——卡在隐形 prompt 或长静默命令，弱标已在 3 分钟亮过、5 分钟仍无
 * 动静升级为疑似停滞）。「持续」按双侧联合口径计：任务上报与 shell 事件任一
 * 近期还有动静即不算停滞——agent 活着思考/规划时 task.progress 仍会在报，
 * 而 TUI 形态的 activityMap 停在启动时刻不刷新，单看 shell 侧会把活 agent 误
 * 标成停滞（P-53 弱标容忍的历史误报面，强标不允许照搬）。
 *
 * 无 OSC 133 记录（宿主从未附着）不判：shell 侧无证据，宁漏标不误标（与
 * P-192 空闲分离的四重门口径同源）。返回值向下取整到分钟，与弱标同口径。
 */
export function sessionStallMinutes(input: SessionStallInput): number {
  if (!input.taskRunning) return 0
  if (!input.lastActivity) return 0
  const lastSign = Math.max(input.lastActivity, input.lastReportAt ?? 0)
  const silentMin = Math.floor(((input.now ?? Date.now()) - lastSign) / 60_000)
  if (silentMin < SESSION_STALL_THRESHOLD_MIN) return 0
  return silentMin
}

/** 停滞强标文案键（claudeSessions.stall.*，宿主翻译同惯例，本模块无 i18n 依赖） */
const STALL_KEYS = { badge: 'claudeSessions.stall.badge', tip: 'claudeSessions.stall.tip' } as const

/** 会话行停滞/静默标的完整档位决策（P-20261004-37）：三宿主共用，保证强标/
 *  弱标/pending 特化三档的判据与文案键同源不漂移。
 *  - 停滞强标（强于弱标一档）：反组合成立且无 pending 审批——有 pending 时
 *    静默归因已知（在等裁决，P-198 特化档），升级停滞标会与之矛盾；
 *  - 弱标：既有 P-53 静默判据 + P-198 pending 特化文案；
 *  - 都不成立：n=0（badge 为空串，宿主不渲染）。
 *  n 即该档分钟数（badge 的 {n} 插值），宿主只管 t(badge, {n}) */
export function sessionBadgeDecision(
  input: SessionStallInput & { hasPendingApproval: boolean },
): { stall: boolean; badge: string; tip: string; n: number } {
  const stallMin = input.hasPendingApproval ? 0 : sessionStallMinutes(input)
  if (stallMin > 0) return { stall: true, badge: STALL_KEYS.badge, tip: STALL_KEYS.tip, n: stallMin }
  const idleMin = sessionIdleMinutes(input.running === true, input.lastActivity, input.now)
  if (idleMin > 0) {
    return { stall: false, ...idleTextKeys(input.hasPendingApproval), n: idleMin }
  }
  return { stall: false, badge: '', tip: '', n: 0 }
}
