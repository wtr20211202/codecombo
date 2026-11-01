import { computed, reactive, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useAgentTerminal } from './useAgentTerminal'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { containsSensitiveValue } from './useAgentFix'
import { resolveTaskLaunchArgs } from './useTaskFileLaunch'
import { byteLength, LAUNCH_ARGS_MAX_BYTES } from '../utils/promptFit'
import { fitListPrompt } from './useCommitAgentMsg'
import { buildAgentMarksMarkdown } from '../utils/agentMarksList'
import type { AgentMark, AgentMarksStat } from './useAgentMarks'
import { logApi } from '../api/client'

/**
 * 变更面板「生成 PR 描述」（P-20261003-177）：P-138 提交信息生成的 PR 级延伸
 * ——范围更大（整条分支而非一次暂存）、模板更结构化（改了什么/为什么/怎么测/
 * 风险四节）。组装三个现成数据面经 launchArgs 预填一键新建 agent 会话起草，
 * 打开 docked 管理页激活；结果在会话中产出，人工审阅后自行复制到 PR 系统
 * （产品无 git host 集成——剪贴板出口 MVP）。复用 createAgentTerminal 既有
 * 链路（同 useCommitAgentMsg/useEditorAskAgent 范式）：runtime 取设置默认，
 * dir = 项目根（会话 cwd）。
 *
 * - 上下文 = marks 清单（P-52 agent 改动清单，utils/agentMarksList 构建）+
 *   diffstat（useAgentMarks 同源 activity 增删行数汇总，示意口径）+ 近期提交
 *   （/log 最近 10 条短哈希 + 主题）。只作起草线索不作全量事实——prompt 明示
 *   「信息不足处结合仓库现状自行核实」（会话 cwd = 项目根，agent 可自行查仓）
 * - 500 字节配额装箱沿 P-138 惯例（fitListPrompt 复用）：先整行丢近期提交
 *   尾部（补充上下文，价值密度低于清单），仍超限再按 P-138 保头截断 marks
 *   清单（整行丢弃 + … 尾缀，极端单行裁尾兜底）
 * - 全文超 500 字节走任务文件降级（P-20261006-44）：全量 marks + diffstat +
 *   近期提交落项目根 .sc-task.md，launchArgs 换短引用指令——逐层让位截断消失，
 *   起草拿到完整上下文；写失败退回装箱截断
 * - 清单疑似含敏感值（凭据/令牌形态的路径）时先确认（复用 P-109
 *   containsSensitiveValue 启发式与 agentMsg 既有文案，取消 = 不创建会话）
 * - 无项目根时防御性不动作（同 P-138）；有根即发起——PR 常在工作区已干净、
 *   marks 已随会话关闭消失的时点剪裁，无廉价前置数据可判空，故不设空态禁用
 */

/** prompt 组装所需的极小翻译面（纯函数可测；同 useCommitAgentMsg 约定） */
export type PrDescTranslator = (key: string, params?: Record<string, unknown>) => string

/** 近期提交条目（/log 行的形状子集：短哈希 + 主题行） */
export interface PrDescCommit {
  hash: string
  subject: string
}

/** prompt 组装输入（marks/stat 来自 useAgentMarks，commits 来自 /log） */
export interface PrDescInput {
  marks: Map<string, AgentMark>
  stat: AgentMarksStat
  commits: PrDescCommit[]
}

/** 近期提交行：`<短hash> <主题>`（7 位短 hash 惯例，省 500 字节配额） */
export function prCommitLine(c: PrDescCommit): string {
  return `${c.hash.slice(0, 7)} ${c.subject}`
}

/** 模板装配（纯函数）：指令头 +（marks 清单节，空则整节省略）+ diffstat 行
 *  +（近期提交节，空则整节省略）——空节不出标题，不给 agent 空段落噪音 */
function assemblePrDesc(input: { marksLines: string[]; stat: AgentMarksStat; commitLines: string[] }, t: PrDescTranslator): string {
  const parts: string[] = [t('commit.prDesc.promptHead')]
  if (input.marksLines.length > 0) parts.push(t('commit.prDesc.marksHead'), input.marksLines.join('\n'))
  parts.push(t('commit.prDesc.statLine', { a: input.stat.additions, d: input.stat.deletions }))
  if (input.commitLines.length > 0) parts.push(t('commit.prDesc.commitsHead'), input.commitLines.join('\n'))
  return parts.join('\n')
}

/** marks 清单行切分（buildAgentMarksMarkdown 单一事实源，空清单 → 空行数组） */
function marksToLines(marks: Map<string, AgentMark>, unknownRuntime: string): string[] {
  return buildAgentMarksMarkdown(marks, unknownRuntime).split('\n').filter(l => l.trim() !== '')
}

/**
 * 组装起草 prompt（纯函数）：未超限原样装配；超限时近期提交整行丢尾（二分，
 * … 行计入装箱判定防尾缀本身挤出上限，全放不下整段让位——会话内 agent 可
 * 自行 git log），仍超限再把 marks 清单交 fitListPrompt 按 P-138 惯例装箱。
 * 孤立的 … 行（固定段本身超上限的理论边界）不出现在清单里——空节省略语义
 * 见 assemblePrDesc
 */
export function buildPrDescPrompt(input: PrDescInput, t: PrDescTranslator): string {
  const ellipsis = '…'
  const marksLines = marksToLines(input.marks, t('changes.agentMarks.unknownRuntime'))
  const commitLines = input.commits.filter(c => c.hash).map(prCommitLine)
  const stat = input.stat
  const fits = (m: string[], c: string[]): boolean =>
    byteLength(assemblePrDesc({ marksLines: m, stat, commitLines: c }, t)) <= LAUNCH_ARGS_MAX_BYTES
  if (fits(marksLines, commitLines)) return assemblePrDesc({ marksLines, stat, commitLines }, t)
  // 二分近期提交最大可整行保留数（marks 全量在场的约束下；裁剪时 … 行计入
  // 装箱判定——与 fitListPrompt 同款）
  const fitsCropped = (n: number): boolean =>
    fits(marksLines, n > 0 ? commitLines.slice(0, n).concat(ellipsis) : [])
  let lo = 0
  let hi = commitLines.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fitsCropped(mid)) lo = mid
    else hi = mid - 1
  }
  if (lo > 0) return assemblePrDesc({ marksLines, stat, commitLines: commitLines.slice(0, lo).concat(ellipsis) }, t)
  if (fits(marksLines, [])) return assemblePrDesc({ marksLines, stat, commitLines: [] }, t)
  // 近期提交整段让位仍超限：marks 清单按 P-138 惯例装箱（整行丢尾保头 +
  // … 标注，单行超限裁尾兜底）。… 行原样进装配（fitListPrompt 的 fits 闭包
  // 度量含 … 行，模板侧再过滤会让最终串超出已判定预算；孤立 … 行 = 清单裁空
  // 的理论边界，语义仍是「截断至空」）
  return fitListPrompt(
    list => assemblePrDesc({ marksLines: list ? list.split('\n') : [], stat, commitLines: [] }, t),
    marksLines,
  )
}

/** 组装完整 PR 描述 prompt（纯函数，未装箱）：marks 清单 + diffstat + 近期提交
 *  全量装配。超限降级时作为任务文件全文（P-20261006-44）——文件面无配额，
 *  装箱逐层让位（提交节→marks 节）的截断不再发生；整体装得下时与
 *  buildPrDescPrompt 逐字节相等 */
export function buildPrDescPromptFull(input: PrDescInput, t: PrDescTranslator): string {
  return assemblePrDesc({
    marksLines: marksToLines(input.marks, t('changes.agentMarks.unknownRuntime')),
    stat: input.stat,
    commitLines: input.commits.filter(c => c.hash).map(prCommitLine),
  }, t)
}

/** 从 /log 响应行提取近期提交（hash + 首行主题），脏行防御性丢弃 */
export function toPrDescCommits(rows: { hash?: string; message?: string }[] | undefined): PrDescCommit[] {
  return (rows || [])
    .map(c => ({ hash: String(c.hash || ''), subject: String(c.message || '').split('\n')[0] || '' }))
    .filter(c => c.hash !== '' && c.subject !== '')
}

export function usePrDescription(context: {
  /** marks 清单（useAgentMarks 聚合，P-52 数据面） */
  marks: { value: Map<string, AgentMark> }
  /** diffstat 汇总（useAgentMarks 同源 activity 增删行数，示意口径） */
  stat: { value: AgentMarksStat }
}) {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useCommitAgentMsg 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })
  // 发起中标志：按钮 loading 态 + 防重复点击（会话创建成功即交由 docked 管理页接管）
  const launching = ref(false)

  /** 生成 PR 描述：拉近期提交 → 组装 prompt → 新建 agent 会话（cwd=项目根，
   *  launchArgs 预填）并打开 docked 管理页激活。结果在会话中产出，人工审阅后
   *  复制到 PR 系统（无 git host 集成——剪贴板出口 MVP）。上下文超 500 字节走
   *  任务文件降级（P-20261006-44）：全量 marks/diffstat/近期提交落项目根
   *  .sc-task.md，launchArgs 换短引用指令；写失败退回装箱截断 */
  async function generatePrDesc(): Promise<void> {
    if (launching.value) return
    const pid = projectStore.currentProjectId
    const root = projectStore.currentProject?.path || ''
    if (!root || !pid) return
    // 近期提交（当前分支最近 10 条）：补充上下文，拉取失败降级为无提交节照常
    // 发起（拦截器已弹错误 toast——失败反馈有，起草不因补充数据失败而中止）
    let commits: PrDescCommit[] = []
    try {
      const res = await logApi.getLog(pid, { limit: 10 }) as unknown as { data?: { hash?: string; message?: string }[] }
      commits = toPrDescCommits(res?.data)
    } catch { /* 保持空清单降级 */ }
    const tt = t as unknown as PrDescTranslator
    // 全文优先：敏感判定与超限降级都以未装箱全文为面（P-20261006-44 修正案）
    const input = { marks: context.marks.value, stat: context.stat.value, commits }
    const full = buildPrDescPromptFull(input, tt)
    // 敏感场景提示确认（P-109 口径同 useCommitAgentMsg，文案复用其既有键——
    // 同一语义不复制翻译）：路径疑似含凭据/令牌时先确认，取消 = 不创建会话
    if (containsSensitiveValue(full)) {
      const ok = await confirmDialog({
        title: t('commit.agentMsg.sensitiveTitle'),
        content: t('commit.agentMsg.sensitiveBody'),
        type: 'warning',
      })
      if (!ok) return
    }
    launching.value = true
    try {
      const agentTerminal = useAgentTerminal()
      if (agentTerminal.busy.value) return
      // 超限降级：全文写项目根 .sc-task.md + 短引用指令（写失败退回装箱截断）
      const plan = await resolveTaskLaunchArgs(pid, full, buildPrDescPrompt(input, tt))
      const info = await agentTerminal.create(undefined, { dir: root, launchArgs: plan.launchArgs })
      if (!info) {
        message.error(t('commit.prDesc.failed'))
        return
      }
      if (plan.taskFile) message.info(t('agent.taskFile.fallbackNote'))
      else if (plan.degraded) message.warning(t('agent.taskFile.fallbackWriteFailed'))
      if (!info.launched) {
        message.warning(t('commit.agentMsg.degraded'))
      } else {
        message.success(t('commit.prDesc.success'))
      }
      await agentTerminal.open('docked')
    } finally {
      launching.value = false
    }
  }

  // reactive 承载返回面（useCommitActions 同款）：子组件模板内 launching
  // 经代理解包为布尔，发起函数引用保持原样
  return reactive({ generatePrDesc, launching })
}

export type PrDescState = ReturnType<typeof usePrDescription>
