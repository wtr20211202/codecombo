import { computed, reactive, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'
import { useAgentTerminal } from './useAgentTerminal'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { containsSensitiveValue } from './useAgentFix'
import { resolveTaskLaunchArgs } from './useTaskFileLaunch'
import { byteLength, LAUNCH_ARGS_MAX_BYTES } from '../utils/promptFit'
import { stagedFileLine, marksNoteLine, type CommitMsgFileEntry } from './useCommitAgentMsg'
import { toStatMap } from '../utils/changeSummary'
import type { NumstatFile } from '../api/domains/git'
import type { AgentMark } from './useAgentMarks'
import { diffApi, logApi } from '../api/client'

/**
 * 变更面板「交给智能体审查变更集」（P-20261005-2）：提交决策前的一键质检——
 * ask 链在 git 域的第四落点（写码→总结→润色→审查）。CommitPanel 是人审变更集
 * 的地方，混改常态（agent 写码 + 人补改）下全靠肉眼滚 diff；本入口把**工作区
 * 变更集为主体**（全 status + numstat 规模，人机混改聚合，与勾选集/提交口径
 * 刻意解耦——审查看的是全部未提交改动）组装成结构化审查任务发给新 agent 会话，
 * 结果在会话中产出，提交决策仍由人终审。
 *
 * 与同族的区别：P-138（生成提交信息）/P-186（拆分建议）以暂存清单为体、产出
 * 提交物；P-177/P-249 以 agent marks 为体；本条 = 全变更集 + 三问（风险点/
 * 缺测试/规范一致性）。发起链沿 P-138 同族范式（P-20261006-44 后家族现状）：
 * 敏感确认（P-109 口径，文案复用 commit.agentMsg 既有键）→ 全文超 500 字节落
 * 项目根 .sc-task.md + 短引用指令（写失败退回装箱截断）→ create（dir=项目根）
 * → docked 打开激活；完成通知沿用 task 终态既有链（零新代码）。
 *
 * - 数据面三取（点击时一次，均尽力而为失败降级不阻断发起）：变更清单 =
 *   changesStore.files（boot/切项目/WS 三路刷新的现成同步面，零新增请求）；
 *   规模 = GET /projects/:id/numstat（P-219 复制摘要同源端点，silent，点击级
 *   低频不进 status 热路径）；基线 = 当前分支（project store 随带）+ 最近 1 条
 *   提交主题（logApi limit=1 现查，useGitStatusSummary amend 同款先例——
 *   logStore 无可靠缓存，直接复用会注入陈旧/错位主题）
 * - marks 归属一行（P-20261005-172）：清单后附「其中 N 个文件来自 agent 会话
 *   改动（runtimes: …）」——审查任务缺「优先审 agent 改动」先验的补齐；数据面
 *   = 面板宿主 useAgentMarks 同一实例（零新增请求），文案复用 commit.agentMsg
 *   既有族键；装箱时最后弃、12 截断时整行让位（「其中 N 个」恒对所见清单精确）
 * - 清单分组：已暂存组在前（提交决策面主体）、未暂存（含未跟踪）组随其后；
 *   总量超 12 个截断 + 「另有 N 个」计数注记（staged 优先保留）
 * - 装箱策略（launchArgs 500 字节上限，P-138 惯例「文件名清单优先保留」）：
 *   固定节按提案逆序弃（深查指引 → 基线 → 规模行），清单整行保头丢尾、组头随
 *   空组隐藏，孤立清单也装不下时只留指令头 + 清单标题 + 计数注记（仍诚实告知
 *   有多少变更未列入）；primary 路径是任务文件全文（无配额，清单不 12 截断），
 *   装箱只是写盘失败时的降级面
 * - 已知限制同 useCommitAgentMsg：设置默认运行时为纯终端（shell）时 prompt 会
 *   作为初始命令注入 shell；探测不到运行时服务端降级纯 shell（launched=false）
 *   ——以提示告知
 */

/** prompt 组装所需的极小翻译面（纯函数可测；组合式内传 useI18n 的 t） */
export type ReviewTranslator = (key: string, params?: Record<string, unknown>) => string

/** 审查清单条目（changes store FileStatus 的形状子集 + staged 分组位） */
export interface ReviewFileEntry extends CommitMsgFileEntry {
  staged: boolean
}

/** diff --stat 摘要（numstat 聚合，示意口径同 P-219；二进制不数行） */
export interface ReviewStat {
  additions: number
  deletions: number
}

/** prompt 组装输入（files/stat/branch/subject 四面见组合式头注） */
export interface ReviewPromptInput {
  files: ReviewFileEntry[]
  /** numstat 取数失败/聚合为空时 null → 规模行整节省略 */
  stat: ReviewStat | null
  /** 当前分支；空（非 git 工作区）→ 基线节整节省略 */
  branch: string
  /** 最近 1 条提交主题（首行）；空（空仓库/取数失败）→ 基线只保留分支段 */
  lastCommitSubject: string
  /** agent marks 归属面（P-20261005-172，面板宿主 useAgentMarks 同一实例）：
   *  清单后附「其中 N 个文件来自 agent 会话改动」一行「优先审 agent 改动」
   *  先验；缺省/无命中 → 整行缺席 */
  marks?: Map<string, AgentMark>
}

/** 清单整形上限：超过截断 + 计数注记（任务书口径）。任务文件全文路径不受此限
 *  （无配额压力，全量清单是本提案卖点），只作用于 launchArgs 装箱面 */
export const REVIEW_LIST_MAX_FILES = 12

/** 清单整形（纯函数）：状态字母行（复用 P-138 stagedFileLine，重命名带旧路径），
 *  已暂存组在前、未暂存（含未跟踪）随其后；总量超上限时保头截断（staged 优先
 *  保留——提交决策面主体）并返回 omitted 计数供注记 */
export function shapeReviewList(files: ReviewFileEntry[]): {
  staged: string[]
  unstaged: string[]
  omitted: number
} {
  const staged: string[] = []
  const unstaged: string[] = []
  for (const f of files) {
    const line = stagedFileLine(f)
    if (f.staged) staged.push(line)
    else unstaged.push(line)
  }
  const total = staged.length + unstaged.length
  if (total <= REVIEW_LIST_MAX_FILES) return { staged, unstaged, omitted: 0 }
  const omitted = total - REVIEW_LIST_MAX_FILES
  const keepStaged = Math.min(staged.length, REVIEW_LIST_MAX_FILES)
  const keepUnstaged = REVIEW_LIST_MAX_FILES - keepStaged
  return { staged: staged.slice(0, keepStaged), unstaged: unstaged.slice(0, keepUnstaged), omitted }
}

/** 装箱/全文共用的节装配（纯函数）：固定节按开关省略（不产空段落噪音，P-177
 *  空节语义），空清单组不出组头。sections 关旗是装箱弃段阶梯的旋钮 */
function assembleReview(
  list: { staged: string[]; unstaged: string[]; omitted: number },
  input: Pick<ReviewPromptInput, 'files' | 'stat' | 'branch' | 'lastCommitSubject' | 'marks'>,
  sections: { stat: boolean; baseline: boolean; guide: boolean; marks: boolean },
  t: ReviewTranslator,
): string {
  const parts: string[] = [t('commit.review.promptHead'), t('commit.review.listHead')]
  if (list.staged.length > 0) parts.push(t('commit.review.stagedHead'), ...list.staged)
  if (list.unstaged.length > 0) parts.push(t('commit.review.unstagedHead'), ...list.unstaged)
  if (list.omitted > 0) parts.push(t('commit.review.more', { n: list.omitted }))
  // 归属行紧贴清单（「其中 N 个」指代上方清单）；N 对 input.files 全集计数，
  // 装箱面只在清单完整在场（omitted=0 且未进入截断阶梯）时放行——恒对所见
  // 清单精确（见 buildChangesetReviewPrompt 弃段注释）
  if (sections.marks) {
    const marksLine = marksNoteLine(input.files, input.marks, t)
    if (marksLine !== '') parts.push(marksLine)
  }
  if (sections.stat && input.stat) {
    parts.push(t('commit.review.statLine', { a: input.stat.additions, d: input.stat.deletions }))
  }
  const branch = input.branch.trim()
  if (sections.baseline && branch) {
    const subject = input.lastCommitSubject.trim()
    if (subject) parts.push(t('commit.review.baseline', { branch, subject }))
    else parts.push(t('commit.review.baselineBranchOnly', { branch }))
  }
  if (sections.guide) parts.push(t('commit.review.selfServe'))
  return parts.join('\n')
}

/** 组装完整审查 prompt（纯函数，未装箱）：全量清单（不 12 截断——任务文件全文
 *  无配额压力）+ 全部固定节。超限降级时作为任务文件全文；整体装得下时与
 *  buildChangesetReviewPrompt 逐字节相等（小变更集两态一致） */
export function buildChangesetReviewPromptFull(input: ReviewPromptInput, t: ReviewTranslator): string {
  const staged: string[] = []
  const unstaged: string[] = []
  for (const f of input.files) {
    const line = stagedFileLine(f)
    if (f.staged) staged.push(line)
    else unstaged.push(line)
  }
  return assembleReview(
    { staged, unstaged, omitted: 0 },
    input,
    { stat: true, baseline: true, guide: true, marks: true },
    t,
  )
}

/**
 * 组装装箱审查 prompt（纯函数）：≤500 字节契约（服务端 launchArgs 上限，超出
 * 由调用方交任务文件降级，本函数是写盘失败时的兜底面）。弃段阶梯按「文件名
 * 清单优先保留」（P-138 惯例）：固定节先弃（逆提案序：深查指引 → 基线 → 规模
 * 行 → marks 归属行——归属行最后弃但仍先于清单截断，P-20261005-172②「归属行
 * 优先级低于文件清单」），清单整行保头丢尾（组头随空组隐藏，计数注记恒在场
 * 诚实告知总量）；归属行另受「清单完整在场」门禁——12 截断（omitted>0）时
 * 「其中 N 个」对所见清单不再精确，整行让位；全弃仍超的理论边界留指令头 +
 * 清单标题 + 计数注记（固定核心 ≪ 500，构造性不超限，无服务端 400 面）。
 * max 参数沿 P-138 惯例预算参数化（既有调用方缺省 500 零变化）
 */
export function buildChangesetReviewPrompt(
  input: ReviewPromptInput,
  t: ReviewTranslator,
  max: number = LAUNCH_ARGS_MAX_BYTES,
): string {
  const shaped = shapeReviewList(input.files)
  // 归属行放行门禁：清单完整在场才可出现（12 截断时 N 对所见清单失真 → 整行缺席）
  const marksOn = shaped.omitted === 0
  // 固定节弃段（guide → baseline → stat → marks，逆提案顺序；marks 殿后仍先于清单截断）
  const sectionLadder: { stat: boolean; baseline: boolean; guide: boolean; marks: boolean }[] = [
    { stat: true, baseline: true, guide: true, marks: marksOn },
    { stat: true, baseline: true, guide: false, marks: marksOn },
    { stat: true, baseline: false, guide: false, marks: marksOn },
    { stat: false, baseline: false, guide: false, marks: marksOn },
    { stat: false, baseline: false, guide: false, marks: false },
  ]
  for (const sections of sectionLadder) {
    const text = assembleReview(shaped, input, sections, t)
    if (byteLength(text) <= max) return text
  }
  // 清单整行丢尾（显示序 [已暂存…, 未暂存…] 的保头语义）：先丢未暂存组尾部
  // （组头随空组隐藏），丢空后再丢已暂存组尾部——组间顺序不乱、头侧恒保留；
  // 截断阶梯归属行恒缺席（marks: false，文件名优先保留）
  for (let keepU = shaped.unstaged.length - 1; keepU >= 0; keepU--) {
    const list = { staged: shaped.staged, unstaged: shaped.unstaged.slice(0, keepU), omitted: shaped.omitted }
    const text = assembleReview(list, input, { stat: false, baseline: false, guide: false, marks: false }, t)
    if (byteLength(text) <= max) return text
  }
  for (let keepS = shaped.staged.length - 1; keepS >= 0; keepS--) {
    const list = { staged: shaped.staged.slice(0, keepS), unstaged: [], omitted: shaped.omitted }
    const text = assembleReview(list, input, { stat: false, baseline: false, guide: false, marks: false }, t)
    if (byteLength(text) <= max) return text
  }
  // 理论边界兜底：指令头 + 清单标题 + 计数注记（固定核心构造性 ≤max）
  return assembleReview(
    { staged: [], unstaged: [], omitted: shaped.omitted },
    input,
    { stat: false, baseline: false, guide: false, marks: false },
    t,
  )
}

/** numstat 聚合（silent，点击级一次 GET）：失败/空返回 null，规模行整节降级 */
async function fetchReviewStat(pid: string): Promise<ReviewStat | null> {
  try {
    const res = await diffApi.getNumstat(pid, { silent: true }) as unknown as { data?: NumstatFile[] }
    let additions = 0
    let deletions = 0
    let any = false
    for (const s of toStatMap(res?.data).values()) {
      if (s.binary) continue // 二进制不数行（宁缺毋谎，P-219 同口径）
      additions += s.additions
      deletions += s.deletions
      any = true
    }
    return any ? { additions, deletions } : null
  } catch { return null }
}

/** 最近 1 条提交主题（首行；风格锚）：失败/空仓库返回空串，基线降级分支段 */
async function fetchLastCommitSubject(pid: string): Promise<string> {
  try {
    const res = await logApi.getLog(pid, { limit: 1 })
    return (res.data?.[0]?.message || '').split('\n')[0]!.trim()
  } catch { return '' }
}

export function useChangesetReview(context?: {
  /** marks 清单（useAgentMarks 聚合，P-52 数据面；面板宿主同一实例传入，
   *  P-20261005-172 归属行数据面——零新增请求） */
  marks?: { value: Map<string, AgentMark> }
}) {
  const projectStore = useProjectStore()
  const changesStore = useChangesStore()
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
  // 发起中标志：按钮 loading 态 + 防重复点击（家族同款；会话创建成功即交由
  // docked 管理页接管）
  const launching = ref(false)
  // 可用性 = 工作区有变更（同步面，changes store 三路刷新；任务书「变更非空可用」）
  const canReview = computed(() => changesStore.files.length > 0)

  /** 交给智能体审查变更集：取数 → 组装 → 敏感确认 →（超限）任务文件降级 →
   *  新建 agent 会话（cwd=项目根）→ docked 打开激活。审查意见在会话中产出，
   *  提交决策由人终审（零自动化——agent 只读分析，模板明示勿修改文件） */
  async function reviewChangeset(): Promise<void> {
    if (launching.value || !canReview.value) return
    const pid = projectStore.currentProjectId
    const root = projectStore.currentProject?.path || ''
    if (!root || !pid) return
    launching.value = true
    try {
      // 规模与基线两面并行现查（点击级低频；各自失败降级不阻断发起）
      const [stat, subject] = await Promise.all([fetchReviewStat(pid), fetchLastCommitSubject(pid)])
      const tt = t as unknown as ReviewTranslator
      const input: ReviewPromptInput = {
        files: changesStore.files.map(f => ({ path: f.path, status: f.status, staged: f.staged, oldPath: f.oldPath })),
        stat,
        branch: projectStore.currentProject?.currentBranch || '',
        lastCommitSubject: subject,
        // 点击时读 marks 现值（面板宿主传入同一 useAgentMarks 实例，P-172 归属先验）
        marks: context?.marks?.value,
      }
      // 全文优先：敏感判定与超限降级都以未装箱全文为面（P-20261006-44 修正案）
      const full = buildChangesetReviewPromptFull(input, tt)
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
      const agentTerminal = useAgentTerminal()
      if (agentTerminal.busy.value) return
      // 超限降级：全文写项目根 .sc-task.md + 短引用指令（写失败退回装箱截断）
      const plan = await resolveTaskLaunchArgs(pid, full, buildChangesetReviewPrompt(input, tt))
      const info = await agentTerminal.create(undefined, { dir: root, launchArgs: plan.launchArgs })
      if (!info) {
        message.error(t('commit.review.failed'))
        return
      }
      if (plan.taskFile) message.info(t('agent.taskFile.fallbackNote'))
      else if (plan.degraded) message.warning(t('agent.taskFile.fallbackWriteFailed'))
      if (!info.launched) {
        message.warning(t('commit.review.degraded'))
      } else {
        message.success(t('commit.review.success'))
      }
      await agentTerminal.open('docked')
    } finally {
      launching.value = false
    }
  }

  // reactive 承载返回面（usePrDescription 同款）：子组件模板内 launching
  // 经代理解包为布尔，发起函数引用保持原样
  return reactive({ reviewChangeset, launching, canReview })
}

export type ChangesetReviewState = ReturnType<typeof useChangesetReview>
