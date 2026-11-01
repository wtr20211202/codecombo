import { useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import { useAsksStore } from '../stores/asks'
import { useApprovalActions, agentLabelOf } from './useApprovalActions'

/**
 * 提问作答动作（P-20261001-27，自提问卡抽出供多处宿主复用）：
 * - answerText：自由文本/选项原文 → asks.answer（API + 本地清账），结果 toast
 *   与全局卡片堆文案一致
 * - jumpToSession / agentLabel：复用审批动作的会话跳转与来源标签实现——
 *   提问与审批同为 agent 发起的用户交互，归属展示口径一致
 *
 * 调用方须处于 NMessageProvider 内（useMessage 依赖注入）。
 */
export function useAskActions() {
  const { t } = useI18n()
  const message = useMessage()
  const asks = useAsksStore()
  const { jumpToSession } = useApprovalActions()

  function agentLabel(agent?: string): string {
    return agentLabelOf(agent, t('ops.ask.agentUnknown'))
  }

  async function answerText(id: string, answer: string) {
    const v = answer.trim()
    if (!v) {
      message.warning(t('ops.ask.emptyAnswer'))
      return
    }
    try {
      await asks.answer(id, v)
      message.success(t('ops.ask.answered'))
    } catch {
      message.error(t('ops.ask.answerFailed'))
    }
  }

  return { agentLabel, answerText, jumpToSession }
}
