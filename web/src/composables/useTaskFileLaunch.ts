import { projectApi } from '../api/client'
import { buildTaskFileDoc, TASK_FILE_NAME, withTaskFileFallback } from '../utils/promptFit'

/**
 * 「任务文件」发起面共享助手（P-20261006-44）：launchArgs 500 字节墙
 * （server/api/terminal/terminal.go len(launchArgs) > 500 拒绝）的文件面绕行——
 * 完整任务文本写入项目根固定名单单文件 .sc-task.md（覆盖式，不堆积），launchArgs
 * 换成短引用指令；agent 会话 cwd=项目根（各链既有 dir 语义）天然可读。写面走
 * P-181 同款既有文件 API（projectApi.writeFile，无 baseHash = 直写覆盖）。
 *
 * - 降级不阻断发起：写文件失败（项目硬锁 403 / 网络 / 无项目上下文）一律退回
 *   调用方传入的 legacyFitted（既有 500 字节装箱结果，与降级前行为逐字节一致），
 *   degraded=true 供调用方提示「上下文可能不完整」
 * - 敏感值确认不在此处（各链确认文案/语义各异）：调用方必须先对 fullPrompt 原始
 *   全文经 containsSensitiveValue 判定并取得确认后再调用——写盘面不可绕过敏感
 *   检查，且全文比装箱摘要更完整，检查面也对全文（P-20261006-44 修正案）
 */

/** 发起参数解析结果：launchArgs = 实际传给 createAgentTerminal 的启动参数 */
export interface TaskFileLaunchResult {
  launchArgs: string
  /** true = 任务全文已写入项目根 .sc-task.md（launchArgs 为短引用指令） */
  taskFile: boolean
  /** true = 任务文件写入失败，已退回原 500 字节装箱截断 */
  degraded: boolean
}

/** 完整任务文本 →（超限时）落 .sc-task.md → 实际 launchArgs。projectId 为空
 *  （如部署失败链在无项目上下文发起）不具备文件面，直接走装箱截断 */
export async function resolveTaskLaunchArgs(
  projectId: string,
  fullPrompt: string,
  legacyFitted: string,
): Promise<TaskFileLaunchResult> {
  const plan = withTaskFileFallback(fullPrompt)
  if (!plan.taskFile || !projectId) {
    return { launchArgs: legacyFitted, taskFile: false, degraded: false }
  }
  try {
    // silent：写失败是预期降级分支，不叠拦截器 toast（调用方按 degraded 提示）
    await projectApi.writeFile(projectId, TASK_FILE_NAME, buildTaskFileDoc(plan.taskFile), { silent: true })
    return { launchArgs: plan.launchArgs, taskFile: true, degraded: false }
  } catch {
    return { launchArgs: legacyFitted, taskFile: false, degraded: true }
  }
}
