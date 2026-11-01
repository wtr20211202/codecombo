import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useI18n } from './useI18n'
import { fitByBytes } from '../utils/promptFit'
import { assembleLaunchPrompt, type PromptSection } from '../utils/promptBuilder'
import { maskSensitive } from '../utils/sensitiveMask'

/**
 * 会话接力发射段（P-20261003-114 本机接力与 P-20261003-218 跨实例接力的共用
 * 尾段）：摘要遮蔽 → tailKeep 装箱（500 字节保尾）→ 本实例 createAgent →
 * 放弃/失败/无运行时/成功提示，一条龙收口。两接力前端取数通道不同（本机
 * claudeApi vs 跨实例 instanceFetch 只读），取数之后的链路完全同构——收编在
 * 此防漂移（改装箱/提示语义只改这里）。
 *
 * - summary 空串 = 无结论：如实提示放弃返回 null，不注空前言开会话
 * - 前言模板复用 claudeSessions.relay.prompt（跨实例不换模板——来源实例名
 *   不进 prompt，白耗 500 字节配额）；遮蔽在装箱前（P-108，结论可能复述密钥）
 * - okText 由调用方组装传入（两接力成功文案不同）；不传则成功无 toast
 *   （launched=false 时 helper 只发 noRuntime warning，调用方无需重复判断）
 */
export function useRelayLaunch() {
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useClaudeRelay 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 发射接力会话：成功返回新会话 id（调用方负责激活 + 管理页宿主接线），
   *  放弃/失败返回 null（提示已就地给出）。dir 由调用方决定：本机接力传会话
   *  cwd，跨实例接力不传（远端路径在本机不存在，携带必被目录校验拒绝）。
   *  ledgerLine（P-20261005-208 可选）：源会话结构化台账的本地化一行（已带
   *  「上次会话：」引导语）——原子段拼在结论行前，配额不够整行让位，自由文本
   *  结论仍是主体 */
  async function launchRelay(opts: {
    name: string
    summary: string
    ledgerLine?: string
    dir?: string
    okText?: string
  }): Promise<string | null> {
    if (!opts.summary) {
      message.error(t('claudeSessions.relay.noSummary'))
      return null
    }
    // 统一组装器（P-20261003-184）：接力前言声明为保尾可截段（tailKeep），
    // 500 字节配额内 fitByBytes 保尾收敛（… 前缀标注，越近越相关）；台账附行
    // 是原子前言且声明序在前——弃段阶梯先弃它，结论最后才动
    const masked = maskSensitive(opts.summary)
    const sections: PromptSection[] = []
    if (opts.ledgerLine) {
      sections.push({ id: 'relay-ledger', kind: 'atomic', text: opts.ledgerLine })
    }
    sections.push({
      id: 'relay',
      kind: 'tailKeep',
      text: '',
      fit: budget => fitByBytes(p => t('claudeSessions.relay.prompt', { summary: p }), masked, budget),
    })
    const { text } = assembleLaunchPrompt(sections)
    const info = await useTerminalSessionsStore().createAgent(
      opts.name,
      'claude',
      undefined,
      { dir: opts.dir, launchArgs: text },
    )
    if (!info) {
      message.error(t('claudeSessions.relay.fail'))
      return null
    }
    if (info.launched === false) {
      message.warning(t('claudeSessions.relay.noRuntime'))
    } else if (opts.okText) {
      message.success(opts.okText)
    }
    return info.id
  }

  return { launchRelay }
}
