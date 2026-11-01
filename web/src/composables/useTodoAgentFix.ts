import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useAgentTerminal } from './useAgentTerminal'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { resolveTaskLaunchArgs } from './useTaskFileLaunch'
import { byteLength, fitListByBudget, LAUNCH_ARGS_MAX_BYTES } from '../utils/promptFit'
import { containsSensitiveValue } from './useAgentFix'
import { projectApi } from '../api/client'

/**
 * TODO 面板「交给智能体修」（P-20261003-159）：把技术债标记（文件 + 行 +
 * TODO 文本 [± 上下文行]）拼成 prompt 经 launchArgs 预填，一键新建 agent 修复
 * 会话并打开 docked 管理页激活。复用 P-109/P-28 ask 链既有发起范式
 * （useAgentTerminal.create → open('docked')，与 useAgentFix 同构）。
 *
 * - 单条目：prompt 附标记行 ±TODO_CONTEXT_RADIUS 行上下文（既有 readFile
 *   通道静默拉全文后就地提取，失败/行号越界/字节超限一律降级为纯定位行——
 *   上下文是锦上添花，绝不阻塞发起）
 * - 批量：勾选 N 条一次交给一个会话（一次会话修一批）；500 字节内逐条贪心
 *   装箱，超出附「另有 M 处未列入」分批注记；超限走任务文件降级（P-20261006-44，
 *   utils/promptFit.withTaskFileFallback + useTaskFileLaunch 落盘）：全部条目
 *   落项目根 .sc-task.md、launchArgs 换短引用指令，分批注记消失，写失败退回
 *   装箱截断。不做自动多会话（一次勾选炸出一串会话不可控）
 * - 敏感值确认复用 useAgentFix 的 containsSensitiveValue 与 agent.fix 文案
 *   （TODO 注释同样可能遗留口令/token 样例，宁可误报弹确认不可静默外发）
 * - 已知限制同 useAgentFix/useEditorAskAgent：设置默认运行时为纯终端（shell）
 *   时 prompt 会作为初始命令注入 shell；环境探测不到任何智能体运行时时服务端
 *   降级纯 shell 会话（launched=false）——以提示告知
 */

/** 待修标记条目（TodoPanel 的 TodoMatch 投影，供纯函数与测试复用） */
export interface TodoFixItem {
  path: string
  line: number
  content: string
}

/** prompt 组装所需的极小翻译面（纯函数可测；组合式内传 useI18n 的 t） */
export type TodoFixTranslator = (key: string, params?: Record<string, unknown>) => string

/** 单条目上下文半径：标记行上下各取几行（±2 足够看清所在代码块语义） */
export const TODO_CONTEXT_RADIUS = 2

/** 条目定位行：路径（项目相对、反斜杠归一 / 与 cwd=项目根一致）:行号 标记文本 */
export function todoItemLine(item: TodoFixItem): string {
  return `${item.path.replace(/\\/g, '/')}:${item.line} ${item.content.trim()}`
}

/** 从文件全文提取标记行 ±radius 行上下文（带行号标注，目标行 `> ` 前缀）。
 *  纯函数：读失败/空内容/行号越界返回 undefined 走降级 */
export function extractTodoContext(
  fileContent: string,
  line: number,
  radius = TODO_CONTEXT_RADIUS,
): string | undefined {
  if (!fileContent || !Number.isInteger(line) || line < 1) return undefined
  const lines = fileContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (line > lines.length) return undefined
  const out: string[] = []
  for (let n = Math.max(1, line - radius); n <= Math.min(lines.length, line + radius); n++) {
    out.push(`${n === line ? '> ' : '  '}${n}: ${lines[n - 1]}`)
  }
  return out.length > 0 ? out.join('\n') : undefined
}

/** 保头裁剪（useEditorAskAgent fitSelectionPrompt 同款语义、独立域拷贝）：
 *  TODO 标记词（FIXME/TODO）在文本头部，丢头就丢了标记语义，与 promptFit
 *  fitByBytes 的保尾方向相反；字节度量仍走同一事实源 byteLength。仅服务
 *  极端超长单行（理论边界：正常标记文本远小于 500 字节） */
function fitTodoLineHead(head: string, line: string): string {
  const full = head + line
  if (byteLength(full) <= LAUNCH_ARGS_MAX_BYTES) return full
  const ellipsis = '…'
  const over = byteLength(full) - LAUNCH_ARGS_MAX_BYTES
  let c = line.slice(0, Math.max(0, line.length - Math.ceil(over / 4)))
  while (c.length > 0 && byteLength(head + c + ellipsis) > LAUNCH_ARGS_MAX_BYTES) {
    c = c.slice(0, -1)
  }
  return head + c + ellipsis
}

/** 单条目 prompt：文件+行+标记文本 [+ 上下文块]。上下文整块字节超限时降级为
 *  纯定位行（保头裁剪兜底），标记定位信息永不丢 */
export function buildSingleTodoFixPrompt(
  item: TodoFixItem,
  context: string | undefined,
  t: TodoFixTranslator,
): string {
  const line = todoItemLine(item)
  if (context) {
    const withCtx = [t('todo.fix.headSingle'), line, t('todo.fix.contextLabel'), context].join('\n')
    if (byteLength(withCtx) <= LAUNCH_ARGS_MAX_BYTES) return withCtx
  }
  return fitTodoLineHead(t('todo.fix.headSingle') + '\n', line)
}

/** 批量 prompt 装箱结果：included = 实际列入条数（会话将收到的），omitted =
 *  超出字节上限未列入的条数（>0 时 prompt 尾部附分批注记） */
export interface BatchTodoPromptResult {
  prompt: string
  included: number
  omitted: number
}

/** 批量全文（未装箱）：批量头（n=全部条数）+ 全部定位行。超限降级时作为任务
 *  文件全文，敏感判定面也用它（P-20261006-44 修正案：全文比装箱摘要更完整，
 *  「另有 M 处未列入」分批注记随文件面消失） */
export function buildBatchTodoFixFullPrompt(items: TodoFixItem[], t: TodoFixTranslator): string {
  return [t('todo.fix.headBatch', { n: items.length }), ...items.map(todoItemLine)].join('\n')
}

/** 批量 prompt：逐条贪心装箱进 500 字节，溢出即止并附分批注记（超额条目
 *  不静默丢弃——agent 知道还有余量，人知道要再发起）。全部单条都装不下时
 *  退化为第一条保头裁剪（至少把第一条交给 agent）。装箱判定序列（贪心装入/
 *  注记计入预算/尾部回吐腾位/降级记账）收口 utils/promptFit.fitListByBudget
 *  单一原语（P-20261006-41，diff 留言域 P-20261006-55 同形装配），本域只保留
 *  装配知识：计数头与「另有 M 处未列入」注记模板、单条保头降级 */
export function buildBatchTodoFixPrompt(items: TodoFixItem[], t: TodoFixTranslator): BatchTodoPromptResult {
  const r = fitListByBudget(items.map(todoItemLine), LAUNCH_ARGS_MAX_BYTES, {
    assemble: (lines, omitted) => {
      const parts = [t('todo.fix.headBatch', { n: lines.length }), ...lines]
      if (omitted > 0) parts.push(t('todo.fix.omitted', { n: omitted }))
      return parts.join('\n')
    },
    fallback: (first) => fitTodoLineHead(t('todo.fix.headSingle') + '\n', first),
  })
  return { prompt: r.text, included: r.included, omitted: r.omittedCount }
}

export function useTodoAgentFix() {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useAgentFix 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 静默拉文件全文提取标记行上下文：失败/二进制 415/超大 413 一律 undefined
   *  降级（readFile 通道与编辑器打开同款，上下文是增强不阻断发起） */
  async function fetchTodoContext(pid: string, path: string, line: number): Promise<string | undefined> {
    try {
      const res = (await projectApi.readFile(pid, path, { silent: true })) as { data?: string }
      return extractTodoContext(res.data || '', line)
    } catch {
      return undefined
    }
  }

  /** 发起修复会话：单条（opts.withContext 时附上下文）或批量装箱。返回
   *  true = 会话已创建（调用方据此清勾选）；无项目/busy/取消确认/创建失败
   *  返回 false（失败可恢复，勾选保留可重试）。批量全文超 500 字节走任务
   *  文件降级（P-20261006-44）：全部条目落项目根 .sc-task.md，launchArgs 换
   *  短引用指令，「另有 M 处未列入」分批注记消失；写失败退回装箱截断 */
  async function handTodosToAgent(items: TodoFixItem[], opts?: { withContext?: boolean }): Promise<boolean> {
    const root = projectStore.currentProject?.path || ''
    const pid = projectStore.currentProjectId
    if (!root || !pid || items.length === 0) return false
    const tt = t as unknown as TodoFixTranslator
    const single = items.length === 1 ? items[0] : undefined
    let context: string | undefined
    if (opts?.withContext && single) {
      context = await fetchTodoContext(pid, single.path, single.line)
    }
    // 装箱版 prompt：单条即组装结果；批量经既有贪心装箱（降级兜底 + included 计数）
    const batch = single ? undefined : buildBatchTodoFixPrompt(items, tt)
    const prompt = single
      ? buildSingleTodoFixPrompt(single, context, tt)
      : batch!.prompt
    // 敏感判定面（P-20261006-44 修正案）：批量对未装箱全文（覆盖被装箱截掉的
    // 条目）；单条无装箱截断，检查面即 prompt 本身
    if (containsSensitiveValue(single ? prompt : buildBatchTodoFixFullPrompt(items, tt))) {
      const ok = await confirmDialog({
        title: t('agent.fix.sensitiveTitle'),
        content: t('agent.fix.sensitiveBody'),
        type: 'warning',
      })
      if (!ok) return false
    }
    const agentTerminal = useAgentTerminal()
    if (agentTerminal.busy.value) return false
    // 超限降级：批量全文写项目根 .sc-task.md + 短引用指令（写失败退回装箱截断；
    // 单条恒在 500 字节内，不走文件面）
    const plan = single
      ? { launchArgs: prompt, taskFile: false, degraded: false }
      : await resolveTaskLaunchArgs(pid, buildBatchTodoFixFullPrompt(items, tt), batch!.prompt)
    const info = await agentTerminal.create(undefined, { dir: root, launchArgs: plan.launchArgs })
    if (!info) {
      message.error(t('agent.fix.failed'))
      return false
    }
    const included = single ? 1 : (plan.taskFile ? items.length : batch!.included)
    if (plan.taskFile) {
      message.info(t('agent.taskFile.fallbackNote'))
    } else if (plan.degraded) {
      message.warning(t('agent.taskFile.fallbackWriteFailed'))
    }
    if (!info.launched) {
      message.warning(t('agent.fix.degraded'))
    } else {
      message.success(t('todo.fix.success', { n: included }))
    }
    await agentTerminal.open('docked')
    return true
  }

  return { handTodosToAgent }
}
