// 渲染错误兜底「白屏保险丝」阈值判定（P-20261002-26）：
// 窗口时间内的连续渲染错误达到阈值 → 切降级页（CrashFallback），避免坏构建
// 经「中心分发、子实例自拉替换」推到远程实例后整页白屏只能 SSH 回滚。
// 纯状态机（无 Vue/DOM 依赖），时间源可注入供单测确定性验证

export interface CapturedError {
  /** 错误消息（Error.message 或 String(err)） */
  message: string
  /** 堆栈（可能缺失，如非 Error 抛出值） */
  stack?: string
  /** Vue 报告的错误来源（如 render / setup function / vnode hook） */
  info?: string
}

export interface CrashGuardOptions {
  /** 判定窗口（ms）：与上一次错误间隔超出窗口视为「不连续」，重开窗口 */
  windowMs?: number
  /** 触发阈值：窗口内错误数达到该值即熔断 */
  threshold?: number
  /** 时间源（默认 Date.now，单测注入虚拟时钟） */
  now?: () => number
}

/** 判定窗口：10s 内的错误才算「连续」 */
export const CRASH_WINDOW_MS = 10_000
/** 熔断阈值：窗口内第 3 次错误触发降级页（偶发单次错误不打断正常渲染） */
export const CRASH_THRESHOLD = 3

/** 降级页摘要截断长度（rune 级截断，超长错误消息不撑爆卡片） */
export const CRASH_SUMMARY_MAX = 200
/** 复制详情中堆栈截断长度（保留现场即可，不无限放大剪贴板负载） */
export const CRASH_STACK_MAX = 4000

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `…(truncated ${text.length - max} chars)`
}

export function createCrashGuard(options: CrashGuardOptions = {}) {
  const windowMs = options.windowMs ?? CRASH_WINDOW_MS
  const threshold = options.threshold ?? CRASH_THRESHOLD
  const now = options.now ?? Date.now
  let timestamps: number[] = []
  let last: CapturedError | null = null

  return {
    /**
     * 记录一次渲染错误，返回是否达到熔断阈值。
     * 与上一次错误间隔超出窗口 → 重开窗口（「连续」语义）
     */
    record(error: CapturedError): boolean {
      last = error
      const t = now()
      const prev = timestamps.at(-1)
      if (prev !== undefined && t - prev > windowMs) {
        timestamps = []
      }
      timestamps.push(t)
      // 滑窗裁剪：丢弃窗口起点之外的旧样本
      timestamps = timestamps.filter(ts => t - ts <= windowMs)
      return timestamps.length >= threshold
    },
    /** 最近一次记录的错误（供降级页展示摘要/复制详情） */
    get lastError(): CapturedError | null {
      return last
    },
    /** 复位（回首页成功离开降级页时调用） */
    reset(): void {
      timestamps = []
      last = null
    },
  }
}

export interface CrashReportContext {
  /** 出错页面 URL（含 __crash 等查询参数，方便报告复现） */
  href?: string
  userAgent?: string
}

/** 组装降级页「复制详情」负载：消息 + 来源 + 截断堆栈 + 环境，纯文本可粘贴 */
export function formatCrashDetail(error: CapturedError, context: CrashReportContext = {}): string {
  const lines = [
    `[Codecombo 渲染错误报告]`,
    `time: ${new Date().toISOString()}`,
    `source: ${error.info ?? 'unknown'}`,
    `message: ${truncateText(error.message, CRASH_SUMMARY_MAX)}`,
  ]
  if (error.stack) lines.push(`stack:\n${truncateText(error.stack, CRASH_STACK_MAX)}`)
  if (context.href) lines.push(`href: ${context.href}`)
  if (context.userAgent) lines.push(`userAgent: ${context.userAgent}`)
  return lines.join('\n')
}
