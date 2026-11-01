import { computed, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useAgentTerminal } from './useAgentTerminal'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { resolveTaskLaunchArgs } from './useTaskFileLaunch'
import { byteLength, fitListByBudget, LAUNCH_ARGS_MAX_BYTES } from '../utils/promptFit'
import { containsSensitiveValue } from './useAgentFix'
import type { DiffComment } from '../utils/diffComments'

/**
 * diff 审阅留言「交给智能体修复」（P-20261006-55）：把未解决留言（文件 + 行 +
 * 留言正文）批量拼成 prompt 一键新建 agent 修复会话——「交给智能体」动作族
 * 第五数据源（P-150 失败命令 / P-159 TODO / P-289 部署失败 / P-20261005-150
 * 哨兵通知之后），发起链复用 useTodoAgentFix 同款范式（createAgentTerminal →
 * docked 激活）。
 *
 * - 清单 = 未解决留言逐条 `path:line 正文`（useDiffComments 既有数据面）；
 *   resolved 留言不入清单——那是已复核闭环的留痕，不是待办
 * - 装箱沿族内 P-159 直系先例（贪心装箱 + 「另有 M 条未列入」分批注记）而非
 *   fitListPrompt（P-138 清单域）：后者无分批注记、截断时头部计数失真，与本族
 *   「agent 知道还有余量、人知道要再发起」的语义不合；装箱判定序列经
 *   utils/promptFit.fitListByBudget 单一原语（P-20261006-41 收口，P-159 同形
 *   装配），字节度量与 500 上限同走该单一事实源
 * - 超限走任务文件降级（P-20261006-44 resolveTaskLaunchArgs，P-159 同款）：
 *   全部条目落项目根 .sc-task.md、launchArgs 换短引用指令，分批注记消失，写
 *   失败退回装箱截断
 * - 留言正文单行化后入清单：留言输入是单行框，此处防御历史脏数据的换行破坏
 *   「逐行 = 逐条」的清单形态
 * - 敏感值确认复用 useAgentFix containsSensitiveValue 与 agent.fix 文案（留言
 *   正文可能贴有凭据/令牌样例，宁可误报弹确认不可静默外发）
 * - 安全边界：留言状态不自动翻转——本组合式只发起会话，不触碰 resolved 位；
 *   agent 修完由人复核勾选解除（P-279 的解除语义是人的复核权，agent 不代行），
 *   prompt 模板亦明示该边界
 */

/** prompt 组装所需的极小翻译面（纯函数可测；组合式内传 useI18n 的 t） */
export type DiffCommentFixTranslator = (key: string, params?: Record<string, unknown>) => string

/** 待修留言条目：文件项目相对路径（锚点形态同 useDiffComments）+ 留言本体 */
export interface DiffCommentFixItem {
  path: string
  comment: DiffComment
}

/** 清单行：`path:line 正文`（cwd=项目根可直接引用；反斜杠归一 / 与 P-28 惯例
 *  一致；正文压成单行——多空白折一空格，多字节内容不破坏逐行清单形态） */
export function commentItemLine(item: DiffCommentFixItem): string {
  return `${item.path.replace(/\\/g, '/')}:${item.comment.line} ${item.comment.text.trim().replace(/\s+/g, ' ')}`
}

/** 批量 prompt 装箱结果：included = 实际列入条数（会话将收到的），omitted =
 *  超出字节上限未列入的条数（>0 时 prompt 尾部附分批注记） */
export interface BatchCommentFixPromptResult {
  prompt: string
  included: number
  omitted: number
}

/** 批量全文（未装箱）：批量头（n=全部条数）+ 全部清单行。超限降级时作为任务
 *  文件全文，敏感判定面也用它（P-20261006-44 修正案：全文比装箱摘要更完整，
 *  「另有 M 条未列入」分批注记随文件面消失） */
export function buildBatchCommentFixFullPrompt(items: DiffCommentFixItem[], t: DiffCommentFixTranslator): string {
  return [t('diff.comment.fix.headBatch', { n: items.length }), ...items.map(commentItemLine)].join('\n')
}

/** 保头裁剪（P-159 fitTodoLineHead 同款语义、独立域拷贝）：留言定位头
 *  「path:line」在文本头部，丢头就丢了定位语义，与 promptFit fitByBytes 的
 *  保尾方向相反；字节度量仍走同一事实源 byteLength。仅服务极端超长单行
 *  （留言正文上限 DIFF_COMMENT_MAX_TEXT=500 字符，CJK 可达 ~1500 字节） */
function fitCommentLineHead(head: string, line: string): string {
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

/** 批量 prompt：逐条贪心装箱进 500 字节，溢出即止并附分批注记（超额条目
 *  不静默丢弃——agent 知道还有余量，人知道要再发起）。全部单条都装不下时
 *  退化为第一条保头裁剪（至少把第一条交给 agent）。装箱判定序列（贪心装入/
 *  注记计入预算/尾部回吐腾位/降级记账）收口 utils/promptFit.fitListByBudget
 *  单一原语（P-20261006-41），本域只保留装配知识：计数头与「另有 M 条未列入」
 *  注记模板、单条保头降级 */
export function buildBatchCommentFixPrompt(items: DiffCommentFixItem[], t: DiffCommentFixTranslator): BatchCommentFixPromptResult {
  const r = fitListByBudget(items.map(commentItemLine), LAUNCH_ARGS_MAX_BYTES, {
    assemble: (lines, omitted) => {
      const parts = [t('diff.comment.fix.headBatch', { n: lines.length }), ...lines]
      if (omitted > 0) parts.push(t('diff.comment.fix.omitted', { n: omitted }))
      return parts.join('\n')
    },
    fallback: (first) => fitCommentLineHead(t('diff.comment.fix.headSingle') + '\n', first),
  })
  return { prompt: r.text, included: r.included, omitted: r.omittedCount }
}

export function useDiffCommentAgentFix() {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useTodoAgentFix 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })
  // 发起中标志：入口防重复点击（会话创建成功即交由 docked 管理页接管）
  const launching = ref(false)

  /** 发起修复会话：未解决留言批量装箱。返回 true = 会话已创建（调用方据此
   *  反馈/收口）；无项目/busy/取消确认/创建失败返回 false（失败可恢复重试）。
   *  批量全文超 500 字节走任务文件降级（P-20261006-44）：全部条目落项目根
   *  .sc-task.md，launchArgs 换短引用指令，分批注记消失；写失败退回装箱截断 */
  async function handCommentsToAgent(items: DiffCommentFixItem[]): Promise<boolean> {
    if (launching.value) return false
    const root = projectStore.currentProject?.path || ''
    const pid = projectStore.currentProjectId
    if (!root || !pid || items.length === 0) return false
    const tt = t as unknown as DiffCommentFixTranslator
    const full = buildBatchCommentFixFullPrompt(items, tt)
    // 敏感判定面对未装箱全文（P-20261006-44 修正案：覆盖被装箱截掉的条目）
    if (containsSensitiveValue(full)) {
      const ok = await confirmDialog({
        title: t('agent.fix.sensitiveTitle'),
        content: t('agent.fix.sensitiveBody'),
        type: 'warning',
      })
      if (!ok) return false
    }
    launching.value = true
    try {
      const agentTerminal = useAgentTerminal()
      if (agentTerminal.busy.value) return false
      const batch = buildBatchCommentFixPrompt(items, tt)
      // 超限降级：全文写项目根 .sc-task.md + 短引用指令（写失败退回装箱截断）
      const plan = await resolveTaskLaunchArgs(pid, full, batch.prompt)
      const info = await agentTerminal.create(undefined, { dir: root, launchArgs: plan.launchArgs })
      if (!info) {
        message.error(t('agent.fix.failed'))
        return false
      }
      const included = plan.taskFile ? items.length : batch.included
      if (plan.taskFile) {
        message.info(t('agent.taskFile.fallbackNote'))
      } else if (plan.degraded) {
        message.warning(t('agent.taskFile.fallbackWriteFailed'))
      }
      if (!info.launched) {
        message.warning(t('agent.fix.degraded'))
      } else {
        message.success(t('diff.comment.fix.success', { n: included }))
      }
      await agentTerminal.open('docked')
      return true
    } finally {
      launching.value = false
    }
  }

  return { handCommentsToAgent, launching }
}
