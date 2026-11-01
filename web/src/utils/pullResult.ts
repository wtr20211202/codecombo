/**
 * pull 结果摘要分档（P-20261003-202）：服务端 pull 前后 HEAD rev-list 计数
 * （响应增量字段 newCommits）→ toast/通知的统一分档。
 *
 * 两个入口（useProjectActions.handlePull 共享拉取流 / GitPanel.handleQuickPull
 * 面板快捷拉取）共用本分档，防「N 个新提交 / 已是最新」文案与语义分叉。
 * 纯函数不持 i18n：返回键名由调用方 t()，与 utils/session-idle 同惯例。
 * 同模块兼收冲突形态失败判定（isConflictPullError，P-20261004-44）——
 * 两入口共用同一错误面，判定逻辑收口一处防分叉。
 */

export interface PullSummary {
  /** toast 级别：有新提交/无法计量 = success（既有语义），0 = info 轻提示 */
  level: 'success' | 'info'
  /** i18n 键（layout.* 命名空间） */
  key: string
  /** 插值参数（有新提交档携带 n） */
  params?: Record<string, unknown>
}

/**
 * 计数 → 摘要分档：
 *   n > 0        → 「Pull 成功：N 个新提交」success + 通知中心入账（调用方负责）
 *   n === 0      → 「已是最新」info 轻提示（与成功通知区分，不入通知中心）
 *   其余（-1/undefined/null）→ 无法计量（旧服务端无字段 / 空仓库基线），
 *                  维持既有「Pull 成功」原样，行为不回退
 */
export function pullResultSummary(newCommits: number | undefined | null): PullSummary {
  if (typeof newCommits === 'number' && newCommits > 0) {
    return { level: 'success', key: 'layout.pullSuccessWithCount', params: { n: newCommits } }
  }
  if (newCommits === 0) {
    return { level: 'info', key: 'layout.pullUpToDate' }
  }
  return { level: 'success', key: 'layout.pullSuccess' }
}

/**
 * 冲突形态 pull 失败判定（P-20261004-44）：冲突 pull 恰走 HTTP 409（git 退出
 * 非零），标记在两处、缺一不可——
 *   ① rawMessage = 响应体 error 字段（server/git 只包 git **stderr**），
 *      兜网络/认证类失败时 stderr 偶带冲突措辞的形态；
 *   ② data.output = 响应体 output 字段（PullRemote 对外契约，409 恒携带）——
 *      git 把 CONFLICT 行/"Automatic merge failed" 写 **stdout**，冲突 pull 的
 *      stderr 实测为空，只看 error 字段永远判不中（e2e 首轮实测踩坑）。
 * 与 classify() 的 gitConflict 分类（error-types.ts）同源关键词，但不独立成
 * 分类调用：分类只看 error 字段，本判定双源取并。双标记大小写不敏感。
 * 纯函数不持 i18n，与 pullResultSummary 同惯例。
 */
const PULL_CONFLICT_RE = /CONFLICT|merge conflict/i

export function isConflictPullError(e: unknown): boolean {
  if (typeof e === 'object' && e !== null) {
    const parts = e as { rawMessage?: unknown; message?: unknown; data?: { output?: unknown } }
    const raw = [parts.rawMessage, parts.message, parts.data?.output]
      .map(v => (typeof v === 'string' ? v : ''))
      .join('\n')
    return PULL_CONFLICT_RE.test(raw)
  }
  return PULL_CONFLICT_RE.test(String(e ?? ''))
}
