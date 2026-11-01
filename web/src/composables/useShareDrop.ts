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
import { shareApi, SHDROP_PAYLOAD_PREFIX, type ShareDropItem } from '../api/domains/share'
import { terminalApi } from '../api/domains/terminal'

/**
 * 协作素材行内动作消费链（P-20261024-1）：通知中心 + sc-ops:share.drop
 * 广播两条出口的统一编排（useQuickdrop 同构先例）——
 *
 *  - 「交给当前会话」（action=shdrop-active）：回查 GET /api/share/:token/drops
 *    取素材绝对路径 → broadcast-write 把路径**贴进**最近激活会话（不带 \r，
 *    语义 = 键入而非执行——applyPaste 既有链的等价形态：agent 读路径即析图
 *    析文件，主人随后自定提交；shell 会话同样只是贴入路径文本不执行）→
 *    consumeDrop 标已消费（TTL 消费语义：已消费 24h 清）。
 *  - 「新会话处理」（secondAction=shdrop-new）：createAgent 以路径为 launchArgs
 *    种子（prompt 模板头 + 绝对路径；路径本身短文本不触 500 字节墙，仍走
 *    resolveTaskLaunchArgs 同链以防极端路径）；疑似敏感值确认同 quickdrop 口径。
 *
 * 零路径泄露边界：绝对路径只在主人侧清单（服务端 DropAbsPath 投影）出现，
 * 访客响应与广播载荷都只有净化文件名——本组合式是路径唯一的消费点。
 */

/** 组装新会话 prompt 模板（纯函数）：模板头 + 素材绝对路径 */
function buildDropPrompt(t: (key: string) => string): (p: string) => string {
  return (p) => [t('share.drop.promptHead'), p].join('\n')
}

/** 回查素材（清单内按 id 检索；已清/未知 → null——TTL 清账后的陈旧通知如实降级） */
async function fetchDrop(token: string, id: string): Promise<ShareDropItem | null> {
  try {
    const res = (await shareApi.listDrops(token)) as unknown as { data?: ShareDropItem[] }
    return (res.data || []).find((x) => x.id === id) ?? null
  } catch {
    return null
  }
}

/** 解析行内动作/广播载荷为 (token, id)；异形载荷返回空对 */
export function parseShDropPayload(payload: unknown): { token: string; id: string } {
  const raw = String(payload ?? '')
  if (!raw.startsWith(SHDROP_PAYLOAD_PREFIX)) return { token: '', id: '' }
  const rest = raw.slice(SHDROP_PAYLOAD_PREFIX.length)
  const i = rest.indexOf(':')
  if (i <= 0 || i === rest.length - 1) return { token: '', id: '' }
  return { token: rest.slice(0, i), id: rest.slice(i + 1) }
}

export function useShareDrop() {
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

  /** 交给当前会话：路径贴进最近激活会话（不自动执行）+ 标已消费 */
  async function forwardToActiveSession(n: { actionPayload?: unknown }): Promise<void> {
    const { token, id } = parseShDropPayload(n.actionPayload)
    if (!token || !id) return
    const drop = await fetchDrop(token, id)
    if (!drop) {
      message.warning(t('share.drop.gone'))
      return
    }
    const activeId = sessionsStore.activeId
    if (!activeId) {
      message.warning(t('quickdrop.noActiveSession'))
      return
    }
    try {
      // 贴路径不带 \r：与 applyPaste（term.paste）同语义——文本进输入行，
      // agent/shell 由主人回车才消费（素材是「给人看的现场」不是待执行命令）
      await terminalApi.broadcastWrite([activeId], drop.absPath)
      message.success(t('share.drop.forwarded'))
    } catch {
      message.error(t('quickdrop.forwardFailed'))
      return
    }
    try {
      await shareApi.consumeDrop(token, id)
    } catch { /* 消费标记尽力而为：失败只影响 TTL 提前清，素材仍可手动删 */ }
  }

  /** 新会话处理：createAgent 以素材绝对路径为种子（敏感确认 + 装箱族降级
   *  全复用 useAgentFix 链；dir 取当前项目根） */
  async function handToNewSession(n: { secondActionPayload?: unknown; actionPayload?: unknown }): Promise<void> {
    const payload = n.secondActionPayload ?? n.actionPayload
    const { token, id } = parseShDropPayload(payload)
    if (!token || !id) return
    const drop = await fetchDrop(token, id)
    if (!drop) {
      message.warning(t('share.drop.gone'))
      return
    }
    const tpl = buildDropPrompt(t)
    const full = tpl(drop.absPath)
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
    // 路径本身是短文本，理论上不触装箱墙；走 resolveTaskLaunchArgs 同链
    // 保持「新会话处理」两键行为完全同构（quickdrop 同款）
    const plan = await resolveTaskLaunchArgs(projectStore.currentProjectId, full, fitByBytes(tpl, drop.absPath))
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
      message.success(t('share.drop.newLaunched'))
    }
    await agentTerminal.open('docked')
    try {
      await shareApi.consumeDrop(token, id)
    } catch { /* 同上：尽力而为旁路 */ }
  }

  return { forwardToActiveSession, handToNewSession }
}
