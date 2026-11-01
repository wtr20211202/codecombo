import { computed, reactive, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'
import { useAgentTerminal } from './useAgentTerminal'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { containsSensitiveValue } from './useAgentFix'
import { byteLength, LAUNCH_ARGS_MAX_BYTES } from '../utils/promptFit'
import { fitListPrompt } from './useCommitAgentMsg'
import { buildAgentMarksMarkdown } from '../utils/agentMarksList'
import type { AgentMark, AgentMarksStat } from './useAgentMarks'

/**
 * 变更面板「建议补测试」（P-20261003-249，P-138/P-177 建议家族）：agent 改完
 * 代码缺测试时，一键新建 agent 会话产出「测试缺口建议」——每条含 目标文件 /
 * 建议补的测试点 / 优先级（高/中/低）。
 *
 * - 数据面 = marks 清单（P-52 agent 改动清单，与 PR 描述共用 useAgentMarks
 *   同一实例，零新增请求）+ diffstat（同一次拉取内聚合的增删行数汇总，示意
 *   口径）。清单与规模仅作分析线索——模板明示「可能截断或缺漏，自行核实」，
 *   agent 在会话内（cwd = 项目根）自行 git diff/status 与既有测试布局对账
 * - 输出纯建议是安全边界：模板显式「不要编写或修改任何测试文件」——是否
 *   补测、何时补由人工确认后另行发起，本功能不做任何自动写测试
 * - 发起链路与 usePrDescription（P-177）同范式：createAgentTerminal（runtime
 *   取设置默认，dir = 项目根）+ 打开 docked 管理页；敏感场景确认（P-109
 *   口径）/ busy 让位 / 降级与失败提示同款语义
 * - 入口可用性（canSuggest）= 有项目根且工作区确有未提交变更（changes store
 *   同步数据面，无竞态——变更树「没有变更」空态时入口无分析对象）；marks
 *   是 3s 防抖的异步迟到数据，不参与禁用条件防按钮闪烁
 */

/** prompt 组装所需的极小翻译面（纯函数可测；同 usePrDescription 约定） */
export type SuggestTestsTranslator = (key: string, params?: Record<string, unknown>) => string

/** prompt 组装输入（marks/stat 来自 useAgentMarks） */
export interface SuggestTestsInput {
  marks: Map<string, AgentMark>
  stat: AgentMarksStat
}

/** marks 清单行切分（buildAgentMarksMarkdown 单一事实源，空清单 → 空行数组） */
function marksToLines(marks: Map<string, AgentMark>, unknownRuntime: string): string[] {
  return buildAgentMarksMarkdown(marks, unknownRuntime).split('\n').filter(l => l.trim() !== '')
}

/** 模板装配（纯函数）：指令头 +（marks 清单节，空则整节省略）+ diffstat 行
 *  ——空清单不出清单标题，不给 agent 空段落噪音（对账指令在指令头内） */
function assembleSuggestTests(input: { marksLines: string[]; stat: AgentMarksStat }, t: SuggestTestsTranslator): string {
  const parts: string[] = [t('commit.suggestTests.promptHead')]
  if (input.marksLines.length > 0) parts.push(t('commit.suggestTests.marksHead'), input.marksLines.join('\n'))
  parts.push(t('commit.suggestTests.statLine', { a: input.stat.additions, d: input.stat.deletions }))
  return parts.join('\n')
}

/**
 * 组装补测试建议 prompt（纯函数）：未超限原样装配；超限时清单交 fitListPrompt
 * 按 P-138 惯例装箱（整行丢尾保头 + … 尾缀，极端单行裁尾兜底）——变量段只有
 * marks 清单，diffstat 与指令头为固定短行恒在场
 */
export function buildSuggestTestsPrompt(input: SuggestTestsInput, t: SuggestTestsTranslator): string {
  const marksLines = marksToLines(input.marks, t('changes.agentMarks.unknownRuntime'))
  const fits = (lines: string[]): boolean =>
    byteLength(assembleSuggestTests({ marksLines: lines, stat: input.stat }, t)) <= LAUNCH_ARGS_MAX_BYTES
  if (fits(marksLines)) return assembleSuggestTests({ marksLines, stat: input.stat }, t)
  // … 行计入 fitListPrompt 的 fits 闭包度量，模板侧不再过滤（见 usePrDescription
  // 同款注记：过滤会让最终串超出已判定预算）
  return fitListPrompt(
    list => assembleSuggestTests({ marksLines: list ? list.split('\n') : [], stat: input.stat }, t),
    marksLines,
  )
}

export function useSuggestTests(context: {
  /** marks 清单（useAgentMarks 聚合，P-52 数据面） */
  marks: { value: Map<string, AgentMark> }
  /** diffstat 汇总（useAgentMarks 同源 activity 增删行数，示意口径） */
  stat: { value: AgentMarksStat }
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
  // 发起中标志：按钮 loading 态 + 防重复点击（会话创建成功即交由 docked 管理页接管）
  const launching = ref(false)

  /** 入口可用性：有项目根且工作区有未提交变更（同步面，见文件头注） */
  const canSuggest = computed(() => {
    const pid = projectStore.currentProjectId
    const root = projectStore.currentProject?.path || ''
    return !!pid && root !== '' && changesStore.files.length > 0
  })

  /** 建议补测试：组装 prompt（marks+diffstat）→ 新建 agent 会话（cwd=项目根，
   *  launchArgs 预填）并打开 docked 管理页激活。产出为测试缺口建议（在会话中
   *  呈现），不自动编写/修改任何测试文件 */
  async function suggestMissingTests(): Promise<void> {
    if (launching.value || !canSuggest.value) return
    const pid = projectStore.currentProjectId
    const root = projectStore.currentProject?.path || ''
    if (!root || !pid) return
    const prompt = buildSuggestTestsPrompt({ marks: context.marks.value, stat: context.stat.value }, t as unknown as SuggestTestsTranslator)
    // 敏感场景提示确认（P-109 口径同 useCommitAgentMsg，文案复用其既有键——
    // 同一语义不复制翻译）：路径疑似含凭据/令牌时先确认，取消 = 不创建会话
    if (containsSensitiveValue(prompt)) {
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
      const info = await agentTerminal.create(undefined, { dir: root, launchArgs: prompt })
      if (!info) {
        message.error(t('commit.suggestTests.failed'))
        return
      }
      if (!info.launched) {
        message.warning(t('commit.suggestTests.degraded'))
      } else {
        message.success(t('commit.suggestTests.success'))
      }
      await agentTerminal.open('docked')
    } finally {
      launching.value = false
    }
  }

  // reactive 承载返回面（usePrDescription 同款）：子组件模板内 launching/
  // canSuggest 经代理解包为布尔，发起函数引用保持原样
  return reactive({ suggestMissingTests, launching, canSuggest })
}

export type SuggestTestsState = ReturnType<typeof useSuggestTests>
