import { useProjectStore } from '../stores/project'
import { useEditorAskAgent } from './useEditorAskAgent'
import { useI18n } from './useI18n'
import { byteLength, fitByBytes } from '../utils/promptFit'

/**
 * 冲突面板「交给智能体解决」（P-20261005-190）：把当前选中冲突文件或整个
 * 冲突集（rebase 长链场景主用）一键委派给新 agent 会话。复用 P-28 询问链
 * （useEditorAskAgent.launchAskSession：busy 让位/git 状态摘要注入/统一组装
 * 器/docked 打开）发起，载荷注入结构化上下文——
 * - 模板任务行：用户可编辑（ConflictAgentDialog），缺省「解决冲突并说明两侧
 *   取舍理由，完成后保持文件可 stage 状态」；首行 = 会话名派生源（P-176 定案）
 * - 文件行 + 场景行：路径（项目相对正斜杠）+ git 操作语境（conflictApi.list
 *   顺带返回的 inProgress：merge/rebase/cherry-pick，零新取数）
 * - 冲突体节选：loadContent 链既有数据源（rawContent 带标记原文 + 3way 两侧
 *   ours/theirs），不新增请求；超长按任务书截断策略「两侧各截 + 中部标记」，
 *   与编辑器询问链同限（launchArgs 500 字节）。agent 拿到路径可自行读全文
 *   （冲突 API 读面已登记 ops 手册 conflict 节），节选是省一轮往返的 convenience
 * - 批量（冲突集）：只注入文件清单（逐条贪心装箱 + 「另有 M 个未列入」注记，
 *   useTodoAgentFix 批量同构），逐文件内容不注入（预算放不下，清单本身才是
 *   委派语义）
 *
 * 闭环不新增自动化：本组合式只创建会话——agent 改文件走既有保存链/文件写
 * 通道，冲突标记消解后由变更面板收账面自然反映，不自动 stage/commit（委派
 * prompt 缺省措辞与 ops 手册 conflict 节委派条目双重锚定），用户在变更面板
 * 终审。已知限制同 useEditorAskAgent：纯终端 runtime 时 prompt 作为初始命令
 * 注入 shell、无运行时降级纯 shell 会话（launched=false）——提示由链路给出
 */

/** 单文件委派的内容载荷（ConflictView loadContent 既有 ref 直取，零新取数） */
export interface ConflictDelegateFile {
  /** 项目相对路径 */
  path: string
  /** 带冲突标记的工作区原文（conflicts/content 的 data） */
  raw: string
  /** 3way 我方聚合（conflicts/parsed 的 data.ours） */
  ours: string
  /** 3way 他方聚合（conflicts/parsed 的 data.theirs） */
  theirs: string
}

export interface ConflictDelegateRequest {
  /** 委派文件清单（批量=全冲突集；单文件=长度 1） */
  paths: string[]
  /** 单文件委派的内容载荷；批量无（清单即语义） */
  single?: ConflictDelegateFile
  /** git 操作语境（conflictApi.list 的 inProgress：''|merge|rebase|cherry-pick） */
  op: string
  /** 用户确认后的任务模板（弹层可编辑，缺省 i18n conflict.agent.defaultTemplate） */
  template: string
}

/** prompt 组装所需的极小翻译面（纯函数可测；组合式内传 useI18n 的 t） */
export type ConflictTranslator = (key: string, params?: Record<string, unknown>) => string

/** 节选段最小有效字节：低于此值的段落是噪声（连一行语义都放不下），跳过 */
const MIN_SECTION_BYTES = 24

/** 保头截断（价值密度在头部：冲突块首行/两侧正文开头承载结构信息），… 尾缀
 *  标注省略。promptFit.fitByBytes 的保尾方向相反，域内独立实现（useTodoAgentFix
 *  fitTodoLineHead 同款先例），字节度量走同一事实源 byteLength */
export function fitHeadKeep(text: string, budget: number): string {
  const trimmed = text.replace(/\s+$/, '')
  if (!trimmed || budget <= 0) return ''
  if (byteLength(trimmed) <= budget) return trimmed
  const ellipsis = '…'
  let c = trimmed.slice(0, Math.max(0, trimmed.length - Math.ceil((byteLength(trimmed) - budget) / 4)))
  while (c.length > 0 && byteLength(c + ellipsis) > budget) {
    c = c.slice(0, -1)
  }
  return c ? c + ellipsis : ''
}

/** 从带标记原文提取首个冲突块（<<<<<<< 起至配对 >>>>>>> 行止，含两端标记行）：
 *  原文的价值密度最高处（标记结构 + 两侧正文一并可见）。无起始标记（工作区
 *  已无冲突/纯文本手改中）或块内不闭合/嵌套再遇 <<<<<<<（diff3/复杂形态，
 *  服务端 complex 同判定面）返回 null——调用方按无块处理，不猜 */
export function extractConflictBlock(raw: string): string | null {
  if (!raw) return null
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => l.startsWith('<<<<<<<'))
  if (start < 0) return null
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('>>>>>>>')) {
      end = i
      break
    }
    if (lines[i]!.startsWith('<<<<<<<')) return null
  }
  if (end < 0) return null
  return lines.slice(start, end + 1).join('\n')
}

/** 冲突体节选（纯函数）：① 原文首个冲突块（带标记，份额 ≤60%）② 两侧各截
 *  （保头，对半分配、前侧省下的归后侧）③ 中部省略标记（任一截断时夹在我方/
 *  他方两段之间）。预算分配先扣「注记 + 两侧最低节选」预留——任务书截断策略
 *  「两侧各截+中部标记」是主体，块挤不掉它们；整体 ≤ budget，预算连一段最小
 *  节选都放不下时返回空串（固定行永远优先保住） */
export function buildConflictBody(
  file: ConflictDelegateFile,
  budget: number,
  t: ConflictTranslator,
): string {
  if (budget <= 0) return ''
  const block = extractConflictBlock(file.raw)
  const note = t('conflict.agent.promptOmitted')
  const sides: [string, string][] = ([
    [t('conflict.agent.promptOurs'), (file.ours || '').replace(/\s+$/, '')],
    [t('conflict.agent.promptTheirs'), (file.theirs || '').replace(/\s+$/, '')],
  ] as [string, string][]).filter(([, c]) => !!c.trim())
  // 超长预判：块+两侧原文总量超预算即会发生截断 → 先给注记留位（两侧夹注记
  // 形态 = 前后两枚换行，故 +2）
  const totalRaw = byteLength(block || '') + sides.reduce((n, [, c]) => n + byteLength(c), 0)
  const noteReserve = totalRaw > budget ? byteLength(note) + 2 : 0
  // 块份额 ≤60%，且不得挤掉两侧的最低节选（sidesMin）——两侧是截断策略主体
  const sidesMin = sides.length * MIN_SECTION_BYTES
  const blockAllowance = block
    ? Math.max(0, Math.min(Math.ceil(budget * 0.6), budget - noteReserve - sidesMin))
    : 0
  const lines: string[] = []
  const blockSec = block && blockAllowance > 0 ? fitHeadKeep(block, blockAllowance) : ''
  if (blockSec) lines.push(blockSec)
  // 逐侧填充：对半当前两侧池（前侧省下的归后侧），截断在册
  const parts: string[] = []
  let truncated = false
  let pool = budget - noteReserve - (blockSec ? byteLength(blockSec) + 1 : 0)
  let left = sides.length
  for (const [label, content] of sides) {
    const cap = Math.max(MIN_SECTION_BYTES, Math.ceil(pool / left))
    const full = `${label}${content}`
    const sec = fitHeadKeep(full, Math.min(cap, pool))
    if (!sec) break
    parts.push(sec)
    pool -= byteLength(sec) + 1
    if (sec.length < full.length) truncated = true
    left--
  }
  if (parts.length > 0) {
    // 注记字节已预留，截断在册即直接插入（宁可位置居中不挪尾，超限不可能）
    lines.push(truncated && note ? [parts[0]!, note, ...parts.slice(1)].join('\n') : parts.join('\n'))
  }
  return lines.join('\n')
}

/** 单文件委派 prompt：模板行 + 文件行（路径超长保头，fitByBytes 单一事实源）+
 *  场景行（定型）+ 冲突体节选（剩余预算收敛，可空）。预算消费优先级 = 定位行
 *  （路径）> 场景行 > 模板行（展示顺序仍是模板居首——服务端 promptSessionName
 *  按首行派生会话名；极端小预算时模板先截/让位，定位信息永不丢，P-28 家族
 *  「头部定位不能丢」同则）。空行过滤保证空模板无空行伪影（弹层允许清空模板
 *  = 只发结构化上下文） */
export function fitSingleConflictPrompt(
  template: string,
  file: ConflictDelegateFile,
  ctxLine: string,
  t: ConflictTranslator,
  budget: number,
): string {
  const rel = file.path.replace(/\\/g, '/')
  let rem = budget
  const fileLine = fitByBytes(p => t('conflict.agent.promptFile', { path: p }), rel, rem)
  rem -= byteLength(fileLine) + (fileLine ? 1 : 0)
  const ctx = fitHeadKeep(ctxLine, rem)
  rem -= byteLength(ctx) + (ctx ? 1 : 0)
  const tpl = fitHeadKeep(template, rem)
  const head = [tpl, fileLine, ctx].filter(Boolean)
  const body = buildConflictBody(file, budget - byteLength(head.join('\n')) - (head.length > 0 ? 1 : 0), t)
  return [...head, body].filter(Boolean).join('\n')
}

/** 批量清单装箱结果：included = 实际列入文件数，omitted = 超出字节上限未列入数 */
export interface BatchConflictPromptResult {
  prompt: string
  included: number
  omitted: number
}

/** 批量委派 prompt：模板行 + 场景行 + 清单（逐条贪心装箱，useTodoAgentFix
 *  批量同构），溢出即止并附「另有 M 个未列入」注记（注记自身占字节，超限时
 *  从尾部回吐条目腾位——宁少装一条也绝不超服务端上限）。预算消费优先级 =
 *  清单条目 > 场景行 > 模板行（极端小预算时模板先让位；首条都装不下时保头
 *  裁剪首条，agent 可经 GET /conflicts 自行补全） */
export function fitBatchConflictPrompt(
  template: string,
  ctxLine: string,
  paths: string[],
  render: { head: (n: number) => string; omitted: (n: number) => string },
  budget: number,
): BatchConflictPromptResult {
  let rem = budget
  const ctx = fitHeadKeep(ctxLine, rem)
  rem -= byteLength(ctx) + (ctx ? 1 : 0)
  const tpl = fitHeadKeep(template, Math.max(0, rem - MIN_SECTION_BYTES))
  const head = [tpl, ctx].filter(Boolean)
  const headSep = head.length > 0 ? 1 : 0
  const all = paths.map(p => `- ${p.replace(/\\/g, '/')}`)
  const first = all[0]
  const lines: string[] = []
  for (const ln of all) {
    if (byteLength([...head, render.head(lines.length + 1), ...lines, ln].join('\n')) > budget) break
    lines.push(ln)
  }
  if (lines.length === 0 && first !== undefined) {
    return {
      prompt: [...head, fitHeadKeep(first, Math.max(0, budget - byteLength(head.join('\n')) - headSep))].filter(Boolean).join('\n'),
      included: 1,
      omitted: all.length - 1,
    }
  }
  let omitted = all.length - lines.length
  while (omitted > 0) {
    const withNote = [...head, render.head(lines.length), ...lines, render.omitted(omitted)].join('\n')
    if (byteLength(withNote) <= budget) break
    lines.pop()
    omitted++
    if (lines.length === 0) {
      // 极端边界：吐光条目仍放不下注记——退化为首条保头（理论不可达：注记远短于 500）
      return {
        prompt: [...head, fitHeadKeep(first ?? '', Math.max(0, budget - byteLength(head.join('\n')) - headSep))].filter(Boolean).join('\n'),
        included: 1,
        omitted: Math.max(0, all.length - 1),
      }
    }
  }
  const parts = [...head, render.head(lines.length), ...lines]
  if (omitted > 0) parts.push(render.omitted(omitted))
  return { prompt: parts.join('\n'), included: lines.length, omitted }
}

/** inProgress 值 → 场景文案（prompt 场景行与弹层徽标共用；空 = 探测不到有序
 *  操作，如实弱表述不虚构操作类型） */
export function conflictOpLabel(op: string, t: ConflictTranslator): string {
  if (op === 'merge') return t('conflict.agent.ctxMerge')
  if (op === 'rebase') return t('conflict.agent.ctxRebase')
  if (op === 'cherry-pick') return t('conflict.agent.ctxCherryPick')
  return t('conflict.agent.ctxNone')
}

export function useConflictAgentDelegate() {
  const projectStore = useProjectStore()
  const { t } = useI18n()
  const { launchAskSession } = useEditorAskAgent()

  /** 发起委派会话（单文件或冲突集）：复用 P-28 launchAskSession（git 状态摘要
   *  注入/docked 打开/结果提示全链一致）。返回 true = 链路已走完（会话创建
   *  失败由链路提示，可重试） */
  async function delegateConflicts(payload: ConflictDelegateRequest): Promise<boolean> {
    const root = projectStore.currentProject?.path || ''
    if (!root || payload.paths.length === 0) return false
    const tt = t as unknown as ConflictTranslator
    const single = payload.single && payload.paths.length === 1 ? payload.single : undefined
    const ctxLine = t('conflict.agent.promptCtx', { ctx: conflictOpLabel(payload.op, tt) })
    const rel = single ? single.path.replace(/\\/g, '/') : undefined
    await launchAskSession(
      root,
      () => [{
        id: 'task',
        kind: 'essential',
        text: '',
        fit: budget => single
          ? fitSingleConflictPrompt(payload.template, single, ctxLine, tt, budget)
          : fitBatchConflictPrompt(payload.template, ctxLine, payload.paths, {
              head: n => tt('conflict.agent.promptListHead', { n }),
              omitted: n => tt('conflict.agent.promptOmittedFiles', { n }),
            }, budget).prompt,
      }],
      rel,
      single ? undefined : t('conflict.agent.successBatch', { n: payload.paths.length }),
    )
    return true
  }

  return { delegateConflicts }
}
