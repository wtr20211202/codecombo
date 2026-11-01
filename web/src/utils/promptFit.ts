/**
 * agent 发起族 launchArgs 字节装箱单一事实源（P-20261004-6）：服务端对
 * launchArgs 按 UTF-8 字节计上限 500（server/api/terminal/terminal.go：
 * len(launchArgs) > 500 直接 400）。editor 询问（P-28/P-122/P-20261003-7）、
 * 交给智能体修复（P-109）、提交信息起草（P-138）、交叉审查（P-20261003-6）
 * 等 prompt 组装统一经此收口——改截断策略只改这里，新增发起入口按内容形态
 * 直接用 fitByBytes（叙述型，保尾裁头）或 fitListByBudget（清单型，逐条贪心 +
 * 溢出注记，P-20261006-41），不再自持同款拷贝。
 */

/** 服务端 launchArgs 上限（server/api/terminal/terminal.go：len(launchArgs) > 500 拒绝） */
export const LAUNCH_ARGS_MAX_BYTES = 500

/** UTF-8 字节数：TextEncoder 按码点编码，多字节字符计满字节（BMP 内 CJK 3 字节），
 *  字符串切片按码元进行、度量在编码后完成，天然不会把多字节字符腰斩 */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

// ── 任务文件降级（P-20261006-44）：500 字节墙的文件面绕行 ──
// agent 会话 cwd=项目根天然持有文件读写面——超限时「长上下文写文件 + launchArgs
// 短引用」零协议变更送达完整上下文，替代「装配摘要硬塞 + 截断注记」。

/** 任务文件名：项目根固定名单覆盖式单文件——不堆积（每次发起整体覆盖）、
 *  项目根高可见（git 未跟踪列表自然提醒），自述头让 agent 读文件即知可自清理 */
export const TASK_FILE_NAME = '.sc-task.md'

/** 超限降级短指令（随 launchArgs 送达）。双语一行硬编码：agent 运行时语言不受
 *  UI locale 约束，操作指令不随界面语言切换（任务正文才走各链 i18n 模板）；
 *  长度远小于 500 字节，短指令自身不构成二次超限面 */
export const TASK_FILE_LAUNCH_ARGS =
  '请先完整阅读项目根 .sc-task.md 并执行其中任务 (read the project-root .sc-task.md in full first, then carry out the task in it)'

/** withTaskFileFallback 的判定结果：launchArgs = 实际经 launchArgs 送达的文本 */
export interface TaskFileLaunchPlan {
  launchArgs: string
  /** 超限时非空：应先写入项目根 TASK_FILE_NAME 的完整任务文本。落盘由调用方
   *  负责（本模块是有意无 IO 的纯函数层，文件写面在各组合式）；未超限时
   *  undefined = 原文直发，零行为变化 */
  taskFile?: string
}

/** launchArgs 超限降级判定（纯函数）：≤500 字节原样返回（调用方照旧直发）；
 *  超限返回短引用指令 + 待落盘全文——调用方先写任务文件再以短指令发起会话。
 *  注意：调用方必须在调用前对原文经 containsSensitiveValue 敏感判定（写盘面
 *  不可绕过敏感检查，且全文比装箱摘要更完整，检查面也对全文），本函数不做
 *  内容审查 */
export function withTaskFileFallback(text: string): TaskFileLaunchPlan {
  if (byteLength(text) <= LAUNCH_ARGS_MAX_BYTES) return { launchArgs: text }
  return { launchArgs: TASK_FILE_LAUNCH_ARGS, taskFile: text }
}

/** 任务文件完整正文：自述头（一次性载体 + 可自删 + 覆盖式语义）+ 任务全文。
 *  头部自述让 agent 与人读到文件即知生命周期——任务完成后可删，无需额外协议 */
export function buildTaskFileDoc(task: string): string {
  const header = [
    '# Codecombo 一次性任务（.sc-task.md）',
    '',
    '> 本文件是一次性任务载体：发起智能体会话时写入，任务完成即可删除；再次发起同类任务会整体覆盖。',
    '> One-shot task file for an agent session — safe to delete once the task is done; overwritten on each launch.',
    '',
    '---',
    '',
  ].join('\n')
  return `${header}${task.replace(/\s+$/, '')}\n`
}

/** 用模板拼 prompt，总长超 max 时裁剪变量内容（尾部优先语义）：先按超出字节
 *  数估去头字符数批量裁剪（UTF-8 每字符 ≤ 4 字节，floor(over/4) 保证不裁过
 *  头），再逐字符微调到恰好塞下（保尾部 = 报错信息/文件名段通常在尾部，…
 *  前缀标注省略）。slice 按字符计，直接用字节超量做下标会把多字节内容整个
 *  裁坏。模板固定段本身超上限时内容裁空后原样返回（服务端 400 兜底，仅理论
 *  边界：固定段为一句模板文案） */
export function fitByBytes(
  template: (content: string) => string,
  content: string,
  max = LAUNCH_ARGS_MAX_BYTES,
): string {
  const full = template(content)
  if (byteLength(full) <= max) return full
  const ellipsis = '…'
  const over = byteLength(full) - max
  let c = content.slice(Math.min(content.length, Math.floor(over / 4)))
  while (c.length > 0 && byteLength(template(ellipsis + c)) > max) {
    c = c.slice(1)
  }
  return template(ellipsis + c)
}

// ── 清单型装箱（P-20261006-41）：与 fitByBytes（叙述型保尾裁头）正交——清单
// 的价值密度在头部、逐条是天然粒度，溢出注记让 agent 知道还有余量、人知道要
// 再发起。useTodoAgentFix/useDiffCommentAgentFix 的成熟清单语义与
// useCommitAgentMsg fitListPrompt 的整行截断在此归一为单一原语 ──

/** 清单型装箱选项：assemble 是唯一域知识入口——原语只决定「哪些条目、以什么
 *  omitted 计数进装配、装不下怎么办」，头部/注记的文案形态全部域侧表达 */
export interface FitListByBudgetOptions {
  /** 装配渲染：lines = 装入条目（保序），omitted = 未列入条数（>0 时域内自附
   *  溢出注记，如「另有 M 处未列入」/'…'）。原语对每个候选装箱状态调用本函数
   *  做字节判定，其返回即最终文本——注记自身计入预算由此天然成立（放不下时
   *  原语从尾部回吐条目腾位：宁少装一条也绝不超上限，超限 400 = 整批发起失败） */
  assemble: (lines: string[], omitted: number) => string
  /** 连第一条都装不下（或注记回吐至空仍放不下，仅理论边界）时的域内降级：
   *  收首条返回兜底整段文本，原语按 included=1/omittedCount=n-1 记账（todo/
   *  diff 留言域换单条头保头裁剪、P-138 族同头单行裁尾——降级形态各域各异，
   *  不进原语） */
  fallback?: (first: string) => string
}

/** 清单型装箱结果：included = 实际列入条数（会话将收到的；降级时为 1——首条
 *  经 fallback 整形送达），omittedCount = 超出预算未列入条数（>0 = 发生了
 *  截断，调用方可据此提示分批） */
export interface FitListByBudgetResult {
  included: number
  omittedCount: number
  /** 装箱后完整文本（assemble 输出）。唯一可能超预算的仅理论边界：定型模板
   *  自身超上限（服务端 400 兜底，与 fitByBytes 同约定） */
  text: string
}

/** 清单型装箱原语：逐条贪心装入 budget 字节溢出即止（保序即保头），溢出注记
 *  经 assemble 参与字节判定、放不下从尾部回吐条目腾位。budget 与 500 上限解耦
 *  参数化——经预算再分配的入口（P-138 族 launchAskSession essential 份额）同款
 *  算法收敛；空清单返回 {0, 0, assemble([], 0)}，不附注记 */
export function fitListByBudget(
  items: string[],
  budget: number,
  opts: FitListByBudgetOptions,
): FitListByBudgetResult {
  const lines: string[] = []
  for (const item of items) {
    // 贪心试探按「收下这一条」的状态装配（计数头随 lines 增长，assemble 域内
    // 自理）；整体重渲染判定与既有实现同复杂度，且装入量受 budget 封顶、
    // 首个放不下即 break，实际探测量有界
    if (byteLength(opts.assemble([...lines, item], 0)) > budget) break
    lines.push(item)
  }
  if (items.length > 0 && lines.length === 0) return degradeToFirstItem(items, opts)
  let omitted = items.length - lines.length
  while (omitted > 0) {
    if (byteLength(opts.assemble(lines, omitted)) <= budget) break
    lines.pop()
    omitted++
    if (lines.length === 0) return degradeToFirstItem(items, opts)
  }
  return { included: lines.length, omittedCount: omitted, text: opts.assemble(lines, omitted) }
}

/** 首条都装不下的域内降级：有 fallback 交域整形（至少把第一条交给 agent），
 *  无 fallback 的极简调用方装 0 条、以 omittedCount 如实记账 */
function degradeToFirstItem(items: string[], opts: FitListByBudgetOptions): FitListByBudgetResult {
  if (opts.fallback) {
    return { text: opts.fallback(items[0]!), included: 1, omittedCount: items.length - 1 }
  }
  return { text: opts.assemble([], items.length), included: 0, omittedCount: items.length }
}
