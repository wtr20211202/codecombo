import { computed, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useAgentTerminal } from './useAgentTerminal'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { containsSensitiveValue } from './useAgentFix'
import { resolveTaskLaunchArgs } from './useTaskFileLaunch'
import { byteLength, fitListByBudget, LAUNCH_ARGS_MAX_BYTES } from '../utils/promptFit'
import { summarizeAgentMarks } from '../utils/agentMarksList'
import type { AgentMark } from './useAgentMarks'

/**
 * 变更面板「生成提交信息」（P-20261002-138）：把暂存变更清单拼成 prompt 经
 * launchArgs 预填，一键新建 agent 会话起草提交信息并打开 docked 管理页激活。
 * 复用 createAgentTerminal 既有链路（同 useEditorAskAgent 范式）：runtime 取
 * 设置默认，dir = 项目根（会话 cwd）。
 *
 * - 清单 = 提交所涉文件（勾选子集优先，未勾选 = 全部暂存——与提交按钮
 *   filesParam 同口径），逐行「短状态字母 + 路径」（轻量 diff 摘要口径：
 *   服务端 B3 产出视图同款 name-status 形态；launchArgs 服务端 500 字节上限
 *   决定了只能装摘要装不下正文）
 * - marks 归属一行（P-20261005-172）：面板宿主传入 useAgentMarks 归属面时，
 *   清单后附「其中 N 个文件来自 agent 会话改动（runtimes: …）」计数行给起草
 *   agent 人机归属先验；装箱超限时先整行弃归属再截断清单（文件名优先保留）
 * - 清单超 500 字节走任务文件降级（P-20261006-44）：全量清单落项目根
 *   .sc-task.md，launchArgs 换短引用指令——截断注记消失，agent 拿到完整清单
 * - 结果在 agent 会话中产出，不自动回填提交框（人审复制）
 * - 清单疑似含敏感值（凭据/令牌形态的路径）时先确认（复用 P-109
 *   containsSensitiveValue 启发式，取消 = 不创建会话）
 * - 已知限制同 useEditorAskAgent：设置默认运行时为纯终端（shell）时 prompt
 *   会作为初始命令注入 shell；环境探测不到任何智能体运行时时服务端降级纯
 *   shell 会话（launched=false）——以提示告知
 */

/** 服务端 launchArgs 上限与 UTF-8 字节度量走 utils/promptFit 单一事实源
 *  （P-20261004-6：发起族同款算法三拷贝归一） */

/** prompt 组装所需的极小翻译面（纯函数可测；组合式内传 useI18n 的 t） */
export type CommitMsgTranslator = (key: string, params?: Record<string, unknown>) => string

/** 暂存清单条目（changes store FileStatus 的形状子集，纯函数不依赖 store） */
export interface CommitMsgFileEntry {
  path: string
  status: string
  oldPath?: string
}

/** 短状态字母（porcelain X 列语义，与服务端 parseXY 的状态词汇对齐） */
export function statusLetter(status: string): string {
  switch (status) {
    case 'Modified': return 'M'
    case 'Added': return 'A'
    case 'Deleted': return 'D'
    case 'Renamed': return 'R'
    case 'Copied': return 'C'
    case 'Unmerged': return 'U'
    case 'Untracked': return '?'
    default: return (status.slice(0, 1) || '?').toUpperCase()
  }
}

/** 清单行：`M path`；重命名带旧路径（起草时区分纯 move 与 move+edit） */
export function stagedFileLine(f: CommitMsgFileEntry): string {
  const letter = statusLetter(f.status)
  return f.oldPath ? `${letter} ${f.oldPath} -> ${f.path}` : `${letter} ${f.path}`
}

/** 清单型 prompt 装箱：模板(清单) 超 launchArgs 上限时从尾部整行丢弃（头部
 *  优先保留——先暂存/先勾选的文件），丢至一行仍超限再按字符裁尾。语义 diff
 *  决策（P-20261004-6）：与 useAgentFix/useEditorAskAgent 的两段式估裁同源、
 *  方向相反——错误摘要价值在尾部故保尾（fitByBytes 单一事实源），文件清单
 *  价值密度在头部故保头，… 尾缀标注省略。装箱判定序列收口
 *  utils/promptFit.fitListByBudget 单一原语（P-20261006-41）：整行丢弃 =
 *  逐条贪心装不下的自然结果，… 尾缀即溢出注记（与 todo 系分批注记同一注记
 *  计入预算语义）；本函数保留 template 形态 API（P-138 族调用方签名零变化）
 *  作原语之上的薄适配，单行字符裁尾是清单域降级、留在域侧。
 *  max 参数（P-20261004-73）：经 launchAskSession 发起的入口拿到的预算已被
 *  git 状态摘要扣除（组装器 essential 份额 < 500），调用方传份额进来按同款
 *  算法收敛；缺省 = 服务端 500 硬上限（既有调用方零变化） */
export function fitListPrompt(
  template: (list: string) => string,
  lines: string[],
  max: number = LAUNCH_ARGS_MAX_BYTES,
): string {
  const ellipsis = '…'
  return fitListByBudget(lines, max, {
    assemble: (packed, omitted) => template(packed.join('\n') + (omitted > 0 ? `\n${ellipsis}` : '')),
    fallback: (first) => {
      // 单行超限（极端超长路径）：首行按字符裁尾（UTF-8 每字符 ≤4 字节批量估
      // 裁 + 逐字符微调，slice 按字符计防多字节路径裁坏）
      let head = first
      const over = byteLength(template(head)) - max
      if (over > 0) head = head.slice(0, Math.max(0, head.length - Math.ceil(over / 4)))
      while (head.length > 0 && byteLength(template(head + ellipsis)) > max) head = head.slice(0, -1)
      return template(head + ellipsis)
    },
  }).text
}

/** marks 归属行组装（P-20261005-172，P-138/P-2 两 builder 共用）：清单中命中
 *  agent marks 的文件数一行摘要（summarizeAgentMarks 数据面），无命中返回 ''。
 *  文案键挂 commit.agentMsg 命名空间——P-2 审查沿用该族「同一语义不复制翻译」
 *  惯例（sensitiveTitle/Body 同款跨用） */
export function marksNoteLine(files: { path: string }[], marks: Map<string, AgentMark> | undefined, t: CommitMsgTranslator): string {
  if (!marks || marks.size === 0) return ''
  const summary = summarizeAgentMarks(files, marks)
  if (!summary) return ''
  return t('commit.agentMsg.marksNote', { n: summary.count, runtimes: summary.runtimes.join('/') })
}

/** 组装起草 prompt（纯函数）：固定头（指令 + 清单标题）+ 暂存清单行 +（marks
 *  归属一行，P-20261005-172——清单后缀「其中 N 个文件来自 agent 会话改动」给
 *  起草 agent 人机归属先验；无 marks/无命中/装箱截断时整行缺席，见下）。归属行
 *  优先级低于文件清单（任务书②）：先整行弃归属再谈清单截断——归属行只在清单
 *  完整在场时出现，「其中 N 个」对所见清单恒精确 */
export function buildCommitMsgPrompt(files: CommitMsgFileEntry[], t: CommitMsgTranslator, marks?: Map<string, AgentMark>): string {
  const lines = files.map(stagedFileLine)
  const marksLine = marksNoteLine(files, marks, t)
  // 条件追加不 filter 空段：无 marks 调用与改动前模板逐字节同构（空清单尾随
  // 换行的历史形态保持，装箱契约面无隐性漂移）
  const assemble = (list: string, withMarks: boolean): string => {
    const parts = [t('commit.agentMsg.promptHead'), t('commit.agentMsg.promptListHead'), list]
    if (withMarks && marksLine !== '') parts.push(marksLine)
    return parts.join('\n')
  }
  const full = assemble(lines.join('\n'), true)
  if (byteLength(full) <= LAUNCH_ARGS_MAX_BYTES) return full
  const bare = assemble(lines.join('\n'), false)
  if (byteLength(bare) <= LAUNCH_ARGS_MAX_BYTES) return bare
  return fitListPrompt(list => assemble(list, false), lines)
}

/** 组装完整起草 prompt（未装箱；超限降级时作为任务文件全文，P-20261006-44）。
 *  与 buildCommitMsgPrompt 同模板——清单整体装得下时两者逐字节相等 */
export function buildCommitMsgPromptFull(files: CommitMsgFileEntry[], t: CommitMsgTranslator, marks?: Map<string, AgentMark>): string {
  const parts = [t('commit.agentMsg.promptHead'), t('commit.agentMsg.promptListHead'), files.map(stagedFileLine).join('\n')]
  const marksLine = marksNoteLine(files, marks, t)
  if (marksLine !== '') parts.push(marksLine)
  return parts.join('\n')
}

export function useCommitAgentMsg() {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useEditorAskAgent 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })
  // 发起中标志：按钮 loading 态 + 防重复点击（会话创建成功即交由 docked 管理页接管）
  const launching = ref(false)

  /** 生成提交信息：新建 agent 会话（cwd=项目根，prompt 经 launchArgs 预填）
   *  并打开 docked 管理页激活。结果在会话中产出，不回填提交框（人审复制）。
   *  marks（P-20261005-172）：面板宿主传入的 agent 归属面，prompt 附「其中 N
   *  个文件来自 agent 会话改动」一行先验。清单超 500 字节时降级任务文件
   *  （P-20261006-44）：全文落项目根 .sc-task.md，launchArgs 换短引用指令；
   *  写失败退回装箱截断 */
  async function generateCommitMsg(files: CommitMsgFileEntry[], marks?: Map<string, AgentMark>): Promise<void> {
    if (launching.value) return
    const root = projectStore.currentProject?.path || ''
    const pid = projectStore.currentProjectId
    if (!root || !pid || files.length === 0) return
    const tt = t as unknown as CommitMsgTranslator
    // 全文优先：敏感判定与超限降级都以未装箱全文为面（全文比装箱摘要更完整）
    const full = buildCommitMsgPromptFull(files, tt, marks)
    // 敏感场景提示确认（P-109 简单提示口径）：路径疑似含凭据/令牌时先确认，
    // 取消 = 不创建会话
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
      const plan = await resolveTaskLaunchArgs(pid, full, buildCommitMsgPrompt(files, tt, marks))
      const info = await agentTerminal.create(undefined, { dir: root, launchArgs: plan.launchArgs })
      if (!info) {
        message.error(t('commit.agentMsg.failed'))
        return
      }
      if (plan.taskFile) message.info(t('agent.taskFile.fallbackNote'))
      else if (plan.degraded) message.warning(t('agent.taskFile.fallbackWriteFailed'))
      if (!info.launched) {
        message.warning(t('commit.agentMsg.degraded'))
      } else {
        message.success(t('commit.agentMsg.success'))
      }
      await agentTerminal.open('docked')
    } finally {
      launching.value = false
    }
  }

  return { generateCommitMsg, launching }
}
