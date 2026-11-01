import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useAgentTerminal } from './useAgentTerminal'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { resolveTaskLaunchArgs } from './useTaskFileLaunch'
import { fitByBytes } from '../utils/promptFit'
import { containsSensitiveValue } from './useAgentFix'
import { quickdropApi, QUICKDROP_PAYLOAD_PREFIX, type QuickdropItem } from '../api/domains/share'
import { terminalApi } from '../api/domains/terminal'

/**
 * 快投递行内动作消费链（P-20261006-51）：通知中心两条出口的统一编排——
 *
 *  - 「交给当前会话」（action=quickdrop-active）：broadcast-write 把投递内容
 *    写入最近激活的终端会话（terminal-sessions.activeId 信标，P-20261004-52
 *    的「用户正看哪个会话」）；尾部自动补 \r（PTY Enter，广播/队列同惯例）。
 *    agent TUI 会话 = 以该内容为提示提交；shell 会话 = 作为命令行执行——
 *    出口由用户主动点选（写入会话即其语义），无隐式触发路径
 *  - 「新会话处理」（secondAction=quickdrop-new）：createAgent 以投递内容为
 *    launchArgs 种子——全文超 500 字节墙自动走任务文件降级（P-20261006-44
 *    resolveTaskLaunchArgs 装箱族，与 useAgentFix 同链）；内容疑似含敏感值
 *    先弹确认（useAgentFix 同一口径）
 *
 * 内容取数：payload 只携 id（审计/通知不含正文），点击后回查
 * GET /api/quickdrop 收件箱取明文；已过期/已摘除（24h TTL）如实提示。
 * 提示走离散 message（useAgentFix 同范式，组合式不依赖祖先 NMessageProvider），
 * 文案不持有 jsdom 不可测依赖以外的东西（i18n 经 useI18n）
 */

/** 组装新会话 prompt 模板（纯函数）：模板头 + 投递原文。装箱面与任务文件全文
 *  面同源（fitByBytes 与 resolveTaskLaunchArgs 共用同一 build 形） */
function buildDropPrompt(t: (key: string) => string): (c: string) => string {
  return (c) => [t('quickdrop.promptHead'), c].join('\n')
}

/** 从收件箱回查单条投递（清单 ≤20 条，单请求零 N+1）；已过期/已摘除 → null */
async function fetchDrop(dropId: string): Promise<QuickdropItem | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await quickdropApi.list()
    const items = (res?.data || []) as QuickdropItem[]
    return items.find((x) => x.id === dropId) ?? null
  } catch {
    return null
  }
}

export function useQuickdrop() {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const sessionsStore = useTerminalSessionsStore()
  const { t } = useI18n()
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 解析行内动作载荷为投递 id（「quickdrop:<id>」前缀分流，异形载荷忽略） */
  function dropIdFromPayload(payload: unknown): string {
    const raw = String(payload ?? '')
    if (!raw.startsWith(QUICKDROP_PAYLOAD_PREFIX)) return ''
    return raw.slice(QUICKDROP_PAYLOAD_PREFIX.length)
  }

  /** 交给当前会话：broadcast-write 写入最近激活会话（尾部补 \r = PTY Enter） */
  async function forwardToActiveSession(n: { actionPayload?: unknown }): Promise<void> {
    const dropId = dropIdFromPayload(n.actionPayload)
    if (!dropId) return
    const drop = await fetchDrop(dropId)
    if (!drop) {
      message.warning(t('quickdrop.gone'))
      return
    }
    const activeId = sessionsStore.activeId
    if (!activeId) {
      message.warning(t('quickdrop.noActiveSession'))
      return
    }
    try {
      await terminalApi.broadcastWrite([activeId], drop.content + '\r')
      message.success(t('quickdrop.forwarded'))
    } catch {
      message.error(t('quickdrop.forwardFailed'))
    }
  }

  /** 新会话处理：createAgent 以投递内容为 launchArgs 种子（敏感确认 + 装箱族
   *  降级全复用 useAgentFix 链；dir 取当前项目根，无项目 = 免项目 agent 会话） */
  async function handToNewSession(n: { secondActionPayload?: unknown; actionPayload?: unknown }): Promise<void> {
    const dropId = dropIdFromPayload(n.secondActionPayload) || dropIdFromPayload(n.actionPayload)
    if (!dropId) return
    const drop = await fetchDrop(dropId)
    if (!drop) {
      message.warning(t('quickdrop.gone'))
      return
    }
    const tpl = buildDropPrompt(t)
    const full = tpl(drop.content)
    if (containsSensitiveValue(full)) {
      const ok = await confirmDialog({
        title: t('agent.fix.sensitiveTitle'),
        content: t('agent.fix.sensitiveBody'),
        type: 'warning',
      })
      if (!ok) return
    }
    const dir = projectStore.currentProject?.path || ''
    const agentTerminal = useAgentTerminal()
    if (agentTerminal.busy.value) return
    // 超限降级：全文写项目根 .sc-task.md + 短引用指令（写失败退回装箱截断）
    const plan = await resolveTaskLaunchArgs(projectStore.currentProjectId, full, fitByBytes(tpl, drop.content))
    const info = await agentTerminal.create(undefined, { dir: dir || undefined, launchArgs: plan.launchArgs })
    if (!info) {
      message.error(t('quickdrop.newFailed'))
      return
    }
    if (plan.taskFile) {
      message.info(t('agent.taskFile.fallbackNote'))
    } else if (plan.degraded) {
      message.warning(t('agent.taskFile.fallbackWriteFailed'))
    }
    if (!info.launched) {
      message.warning(t('agent.fix.degraded'))
    } else {
      message.success(t('quickdrop.newLaunched'))
    }
    await agentTerminal.open('docked')
  }

  return { forwardToActiveSession, handToNewSession }
}
