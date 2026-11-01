import { computed, onScopeDispose, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { agentChainApi } from '../api/domains/agentchain'
import type { AgentChainItem } from '../api/domains/agentchain'
import { useI18n } from './useI18n'
import { OPS_CHAIN_TRIGGERED } from '../utils/opsEvents'
import { byteLength, LAUNCH_ARGS_MAX_BYTES } from '../utils/promptFit'

/**
 * 会话接续链（P-20261004-38）：「会话 A 完成后自动拉起会话 B 接续」的事件
 * 触发链。两个交互面共用本组合式（useCompareExperiment/useCrossReview 同范式
 * 的模块级单例）：
 *   - 会话行右键「完成后接续…」→ 接续弹层（ChainContinueDialog）填模板与运行时
 *   - agent 管理页头部「接续链」→ 链列表面板（AgentChainPanel）管理已建链
 *
 * - 模板字节配额客户端先行校验（服务端 500 字节同口径，utils/promptFit 常量
 *   单一事实源）；占位符 {prevTask}/{prevStatus}/{prevStep} 由服务端触发时替换，
 *   前端不展开只透传
 * - 链列表面板打开期间监听 chain.triggered 直通分发窗口事件（服务端广播），
 *   外部触发（含本页之外的拉起）即重读列表——触发事实 lastTriggeredAt/深度
 *   演进在面板内可见，免轮询
 */

/** 接续源会话信息（会话行宿主传入，纯展示字段） */
export interface ChainSourceSession {
  id: string
  name: string
  runtime: string
  /** 会话工作目录（表单 dir 预填建议值） */
  dir?: string
}

// ── 模块级单例状态（入口动作与唯一弹层实例共享；链列表数据同为共享——
// 弹层创建后 refresh 推进的是同一份，面板重开即见，useCompareExperiment 同范式） ──
const chainSource = ref<ChainSourceSession | null>(null)
const chainShow = ref(false)
const panelShow = ref(false)
const chains = ref<AgentChainItem[]>([])
const loading = ref(false)
const creating = ref(false)

/** 入口动作（免组合式实例）：会话行右键直接调用打开接续弹层 */
export function openChainContinue(s: ChainSourceSession): void {
  chainSource.value = s
  chainShow.value = true
}

/** 入口动作（免组合式实例）：agent 管理页头部/命令面板直接调用打开链列表 */
export function openAgentChains(): void {
  panelShow.value = true
}

export function useAgentChain() {
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useCrossReview 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const res = await agentChainApi.list()
      chains.value = (res?.data || []) as AgentChainItem[]
    } catch {
      /* 静默保留旧列表：面板是浏览面，网络抖动不清空已有事实 */
    } finally {
      loading.value = false
    }
  }

  /** 创建链（模板字节配额客户端先行校验；成功 toast 并返回 true 供弹层收口） */
  async function create(payload: {
    sourceTerminalId: string
    promptTemplate: string
    runtime?: string
    dir?: string
    onFailure?: boolean
  }): Promise<boolean> {
    const template = payload.promptTemplate.trim()
    if (!template) {
      message.error(t('agentchain.promptRequired'))
      return false
    }
    if (byteLength(template) > LAUNCH_ARGS_MAX_BYTES) {
      message.error(t('agentchain.promptTooLong'))
      return false
    }
    creating.value = true
    try {
      await agentChainApi.create({ ...payload, promptTemplate: template })
      message.success(t('agentchain.created'))
      await refresh()
      return true
    } catch {
      return false // 错误 toast 由 http 拦截器统一入账
    } finally {
      creating.value = false
    }
  }

  async function removeChain(id: string): Promise<void> {
    try {
      await agentChainApi.remove(id)
      message.success(t('agentchain.deleted'))
    } catch {
      return
    }
    await refresh()
  }

  // chain.triggered 直通分发（服务端广播）：面板打开期间外部触发即重读。
  // 监听随组合式实例生命周期挂卸（面板宿主在 setup 期调用本组合式）
  const onChainTriggered = (): void => {
    if (panelShow.value) void refresh()
  }
  window.addEventListener(OPS_CHAIN_TRIGGERED, onChainTriggered)
  onScopeDispose(() => window.removeEventListener(OPS_CHAIN_TRIGGERED, onChainTriggered))

  return {
    chainSource, chainShow, panelShow,
    chains, loading, creating,
    refresh, create, removeChain,
  }
}
