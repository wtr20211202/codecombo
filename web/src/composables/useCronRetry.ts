import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useI18n } from './useI18n'
import { useAgentTerminal } from './useAgentTerminal'
import { agentCronApi } from '../api/domains/agentcron'
import { OPS_AGENT_CRONS_CHANGED } from '../utils/opsEvents'

/**
 * 定时任务发起失败通知的一键重试（P-20261006-14，通知行动化族的失败态补全）：
 * 失败通知（action='cron-retry'，Go 侧 notifyLaunchFailed 落档）点击后调既有
 * 试跑端点 POST /api/agent-crons/:id/run 重新发起，随后打开智能体终端看现场
 * （设置页「立即试跑」同款 UX：refresh→激活→open）并广播清单变更（任务面板
 * 刷新联动，AgentCronSettings 消费）。重试再失败由服务端再入账失败通知、
 * 此处就地 toast 报错——人工决定是否再点，不自动递归（重试风暴防线）。
 *
 * 语义边界（提案口径「同槽重跑——防重复计费」）：重试走 RunNow 既有语义按
 * 当下时刻发起（launchArgs 时间戳后缀取当下），不回补历史槽点——payload 携带
 * 的 slot 是失败当次的计划槽点，仅作语义注记；陈旧通知（槽过期 >1 天）点击
 * 的语义是「新开一次」而非补跑昨日槽点（服务端不存在补跑参数面，试跑亦不经
 * runDue 的 checkedFor 同槽去重）。任务已删除等失效面由端点 404 就地报错。
 */

/** cron-retry 通知 payload（服务端 notifyLaunchFailed 落档形态的 TS 镜像） */
export interface CronRetryPayload {
  /** 失败任务的 ID（sc_cron_ 前缀，试跑端点寻址锚） */
  cronId: string
  /** 失败当次的计划槽点（RFC3339，信息性——重试本身按当下发起） */
  slot?: string
}

/** 解析 cron-retry payload（纯函数，单测锚点）：非法 JSON / 缺 cronId 返回
 *  null——陈旧/损坏通知不可重试，调用方就地提示失败（不发无效请求） */
export function parseCronRetryPayload(raw: string): CronRetryPayload | null {
  try {
    const v = JSON.parse(raw) as Partial<CronRetryPayload>
    if (!v || typeof v.cronId !== 'string' || !v.cronId) return null
    return { cronId: v.cronId, slot: typeof v.slot === 'string' ? v.slot : undefined }
  } catch {
    return null
  }
}

export function useCronRetry() {
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useAgentFix 同范式）：本组合式在 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 通知 cron-retry 动作入口：重试发起 + 终端直达 + 任务面板刷新联动。
   *  toast 复用试跑同族文案（runStarted/runFailed）——同一动作语义不重复养文案 */
  async function retryFromNotification(payload: string): Promise<void> {
    const parsed = parseCronRetryPayload(payload)
    if (!parsed) {
      message.error(t('agentcron.runFailed'))
      return
    }
    try {
      const res: unknown = await agentCronApi.run(parsed.cronId)
      const data = (res as { data?: { id?: string } })?.data
      if (data?.id) {
        // 打开智能体终端看现场（AgentCronSettings.runNow 同款三步）
        const at = useAgentTerminal()
        await at.refresh()
        at.activeId.value = String(data.id)
        at.open()
      }
      message.success(t('agentcron.runStarted'))
      // 任务面板刷新联动：设置·定时任务分区在挂载中即重拉（lastRunAt/lastResult
      // 刚被本次重试翻写）；未挂载时无人监听，下次打开 fetchCrons 自然读到新值
      window.dispatchEvent(new CustomEvent(OPS_AGENT_CRONS_CHANGED))
    } catch {
      // 发起失败就地提示（run 端点 silent，拦截器不弹）；服务端失败通知照常
      // 再入账，人工决定是否再点（不自动递归）
      message.error(t('agentcron.runFailed'))
    }
  }

  return { retryFromNotification }
}
