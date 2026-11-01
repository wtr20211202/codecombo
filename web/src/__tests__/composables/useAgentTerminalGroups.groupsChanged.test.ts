import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'

// ── mock 边界：① vue-i18n（真 zh-CN 语言包插值，useI18n 即 vue-i18n 再导出）
// ② vue-router（openProject 的 useRouter 仅动作链用，挂载期不触）
// ③ naive-ui（useMessage 需 provider，桩掉；模块内 createDiscreteApi 均为惰性
// 调用不受整模块 mock 影响）④ uiStateApi（uiState 命名空间持久化通道）──
const { uiGet, uiPatch } = vi.hoisted(() => ({
  uiGet: vi.fn<() => Promise<{ data?: Record<string, unknown> }>>(),
  uiPatch: vi.fn<(data: Record<string, unknown>) => Promise<unknown>>(),
}))

vi.mock('vue-i18n', async () => {
  const zh = (await import('../../locales/zh-CN')).default
  const get = (o: Record<string, unknown>, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
  return {
    useI18n: () => ({
      t: (key: string) => (get(zh, key) as string) ?? key,
    }),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({
      currentRoute: ref({ name: '' }),
      push: vi.fn(),
    }),
  }
})

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => ({
      error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(),
    }),
  }
})

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, uiStateApi: { get: uiGet, patch: uiPatch } }
})

import { useAgentTerminalGroups } from '../../composables/useAgentTerminalGroups'
import { OPS_AGENT_GROUPS_CHANGED } from '../../utils/opsEvents'
import { useInstanceStore } from '../../stores/instance'
import { useProjectStore } from '../../stores/project'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import type { AgentTermSession } from '../../composables/useAgentTerminal'

/**
 * 会话组结构外部写回即时生效（P-20261004-79）单测：工作区预设恢复链在 groups
 * 落盘成功后派发 OPS_AGENT_GROUPS_CHANGED，live 挂载中的管理页（本组合式宿主）
 * 收到即重读 uiState 会话组段就地重应用——原「下次挂载 boot 生效」边界升级。
 * 宿主组件挂载触发 onMounted 注册 window 监听，真实 window Event 派发验证；
 * 卸载解绑 / booting 让位 / 读失败回落空表（loadState 吞错的既有容错口径）同验。
 */

function agentGroupsPayload(groups: unknown): { data: Record<string, unknown> } {
  return { data: { local: { agentTerminal: { groups } } } }
}

describe('useAgentTerminalGroups 会话组外部写回即时生效（P-20261004-79）', () => {
  let wrapper: VueWrapper | null = null
  let model: ReturnType<typeof useAgentTerminalGroups> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    uiGet.mockReset()
    uiPatch.mockReset()
    uiPatch.mockResolvedValue(undefined)
    uiGet.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    model = null
    document.body.innerHTML = ''
  })

  /** 宿主组件：setup 内装配组合式（onMounted 需组件实例），暴露模型供断言 */
  function mountHost(): ReturnType<typeof useAgentTerminalGroups> {
    const sessions = ref<AgentTermSession[]>([])
    const selectedId = ref('')
    const lastViewedSessionId = ref('')
    let m!: ReturnType<typeof useAgentTerminalGroups>
    const Host = defineComponent({
      setup() {
        m = useAgentTerminalGroups({
          sessions,
          selectedId,
          lastViewedSessionId,
          sessionsStore: useTerminalSessionsStore(),
          projectStore: useProjectStore(),
          rename: vi.fn(),
          destroy: vi.fn(),
          kill: vi.fn(),
          attachProject: vi.fn(),
          getSelectedProjectSession: () => null,
          hide: vi.fn(),
          afterRestore: vi.fn(),
        })
        return () => h('div')
      },
    })
    wrapper = mount(Host, { attachTo: document.body })
    model = m
    return m
  }

  it('恢复链广播 → live 挂载中的管理页重读 uiState 即时重应用组结构', async () => {
    const m = mountHost()
    // 初次 boot：盘上只有组 A
    uiGet.mockResolvedValue(agentGroupsPayload([{ id: 'g-a', name: '组A', sessionIds: [] }]))
    await m.boot()
    expect(m.groups.value.map(g => g.id)).toEqual(['g-a'])

    // 恢复链落盘新结构（组 B/C）后派发广播（useWorkspaceSnapshot.applyAgentGroups 侧）
    uiGet.mockResolvedValue(agentGroupsPayload([
      { id: 'g-b', name: '组B', sessionIds: ['s1'] },
      { id: 'g-c', name: '组C', sessionIds: [] },
    ]))
    window.dispatchEvent(new Event(OPS_AGENT_GROUPS_CHANGED))
    await flushPromises()

    // 即时重应用：不等下次挂载 boot
    expect(m.groups.value.map(g => g.id)).toEqual(['g-b', 'g-c'])
    // 收到即拉全量：重读 uiState（+1 GET），且赋值触发 persistUi 回写同内容（既有语义）
    expect(uiGet).toHaveBeenCalledTimes(2)
    expect(uiPatch).toHaveBeenCalled()
  })

  it('卸载解绑：卸载后广播不再触发重读', async () => {
    const m = mountHost()
    uiGet.mockResolvedValue(agentGroupsPayload([{ id: 'g-a', name: '组A', sessionIds: [] }]))
    await m.boot()
    expect(uiGet).toHaveBeenCalledTimes(1)

    wrapper?.unmount()
    wrapper = null
    window.dispatchEvent(new Event(OPS_AGENT_GROUPS_CHANGED))
    await flushPromises()
    expect(uiGet).toHaveBeenCalledTimes(1)
  })

  it('boot 进行中让位：事件不与 boot 竞写，最终态以 boot 读到的落盘值为准', async () => {
    const m = mountHost()
    uiGet.mockResolvedValue(agentGroupsPayload([{ id: 'g-new', name: '落盘新结构', sessionIds: [] }]))
    const pending = m.boot()
    // boot 尚在途中（booting=true）：广播派发被让位，不产生额外 GET
    window.dispatchEvent(new Event(OPS_AGENT_GROUPS_CHANGED))
    await pending
    await flushPromises()
    expect(m.groups.value.map(g => g.id)).toEqual(['g-new'])
    expect(uiGet).toHaveBeenCalledTimes(1)
  })

  it('读失败回落空表不炸（loadState 吞错返回空all的既有容错口径，与 boot 同形）', async () => {
    const m = mountHost()
    uiGet.mockResolvedValue(agentGroupsPayload([{ id: 'g-a', name: '组A', sessionIds: [] }]))
    await m.boot()

    uiGet.mockRejectedValue(new Error('network down'))
    expect(() => window.dispatchEvent(new Event(OPS_AGENT_GROUPS_CHANGED))).not.toThrow()
    await flushPromises()
    expect(m.groups.value).toEqual([])
  })

  it('uiState 键控按当前实例 id（local）读取 agentTerminal 段', async () => {
    const m = mountHost()
    expect(useInstanceStore().currentInstanceId).toBe('local')
    // 生产形态：宿主 onMounted 即 boot（booting 复位后才消费广播——上一用例专验）
    uiGet.mockResolvedValue({ data: {} })
    await m.boot()
    uiGet.mockResolvedValue(agentGroupsPayload([{ id: 'g-a', name: '组A', sessionIds: [] }]))
    window.dispatchEvent(new Event(OPS_AGENT_GROUPS_CHANGED))
    await flushPromises()
    expect(m.groups.value.map(g => g.id)).toEqual(['g-a'])
  })
})
