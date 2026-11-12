import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'

// ── 自定义分组折叠（P-20261111-1-S1）组合式单测：collapsedGroups 与
// collapsedProjects 同一 persist 链路同一折叠语义——boot 恢复落盘折叠集、
// 切换即持久化（PATCH 快照携 collapsedGroups）、缺键回落全展开（旧数据零迁移）。
// mock 边界循 useAgentTerminalGroups.groupsChanged.test.ts 同款四件
// （vue-i18n / vue-router / naive-ui / uiStateApi）──
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
import { useProjectStore } from '../../stores/project'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import type { AgentTermSession } from '../../composables/useAgentTerminal'

describe('useAgentTerminalGroups 自定义分组折叠（P-20261111-1-S1）', () => {
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

  function agentPayload(state: Record<string, unknown>): { data: Record<string, unknown> } {
    return { data: { local: { agentTerminal: state } } }
  }

  it('boot 恢复落盘折叠集：collapsedGroups 缺键回落空集（全展开，旧数据零迁移）', async () => {
    const m = mountHost()
    uiGet.mockResolvedValue(agentPayload({
      groups: [{ id: 'g-a', name: '组A', sessionIds: [] }],
    }))
    await m.boot()
    expect(m.collapsedGroups.value.size).toBe(0)

    uiGet.mockResolvedValue(agentPayload({
      groups: [{ id: 'g-a', name: '组A', sessionIds: [] }],
      collapsedGroups: ['g-a'],
    }))
    await m.boot()
    expect(m.collapsedGroups.value.has('g-a')).toBe(true)
    expect(m.collapsedGroups.value.has('g-b')).toBe(false)
  })

  it('onToggleGroup 切换即持久化：PATCH 快照携最新 collapsedGroups，二次切换复原', async () => {
    const m = mountHost()
    uiGet.mockResolvedValue(agentPayload({
      groups: [{ id: 'g-a', name: '组A', sessionIds: [] }],
    }))
    await m.boot()

    m.onToggleGroup('g-a')
    expect(m.collapsedGroups.value.has('g-a')).toBe(true)
    await flushPromises()
    expect(uiPatch).toHaveBeenCalled()
    const firstPatch = uiPatch.mock.calls.at(-1)![0] as { local?: { agentTerminal?: { collapsedGroups?: string[] } } }
    expect(firstPatch.local?.agentTerminal?.collapsedGroups).toEqual(['g-a'])

    m.onToggleGroup('g-a')
    expect(m.collapsedGroups.value.has('g-a')).toBe(false)
    await flushPromises()
    const secondPatch = uiPatch.mock.calls.at(-1)![0] as { local?: { agentTerminal?: { collapsedGroups?: string[] } } }
    expect(secondPatch.local?.agentTerminal?.collapsedGroups).toEqual([])
  })

  it('折叠集与项目分组折叠互不串扰：切换自定义分组不动 collapsedProjects', async () => {
    const m = mountHost()
    uiGet.mockResolvedValue(agentPayload({
      groups: [{ id: 'g-a', name: '组A', sessionIds: [] }],
      collapsedProjects: ['p1'],
    }))
    await m.boot()
    expect(m.collapsedProjects.value.has('p1')).toBe(true)

    m.onToggleGroup('g-a')
    await flushPromises()
    expect(m.collapsedProjects.value.has('p1')).toBe(true)
    expect(m.collapsedGroups.value.has('g-a')).toBe(true)
    // 快照两集合并存互不覆盖
    const lastPatch = uiPatch.mock.calls.at(-1)![0] as { local?: { agentTerminal?: { collapsedProjects?: string[]; collapsedGroups?: string[] } } }
    expect(lastPatch.local?.agentTerminal?.collapsedProjects).toEqual(['p1'])
    expect(lastPatch.local?.agentTerminal?.collapsedGroups).toEqual(['g-a'])
  })

  it('删组/外部恢复剪枝：折叠集中已不存在组的 id 被摘除，防持久化集合无界累积', async () => {
    const m = mountHost()
    uiGet.mockResolvedValue(agentPayload({
      groups: [
        { id: 'g-a', name: '组A', sessionIds: [] },
        { id: 'g-b', name: '组B', sessionIds: [] },
      ],
    }))
    await m.boot()
    m.onToggleGroup('g-a')
    m.onToggleGroup('g-b')
    expect(m.collapsedGroups.value.size).toBe(2)

    // 删组：折叠态随组消亡剪枝，仍在册组保留
    await m.onGroupAction({ key: 'delete:g-a' })
    await flushPromises()
    expect(m.collapsedGroups.value.has('g-a')).toBe(false)
    expect(m.collapsedGroups.value.has('g-b')).toBe(true)

    // 外部恢复链换结构：不在新结构里的折叠 id 同口径剪枝
    uiGet.mockResolvedValue(agentPayload({
      groups: [{ id: 'g-c', name: '组C', sessionIds: [] }],
    }))
    window.dispatchEvent(new Event(OPS_AGENT_GROUPS_CHANGED))
    await flushPromises()
    expect(m.groups.value.map(g => g.id)).toEqual(['g-c'])
    expect(m.collapsedGroups.value.size).toBe(0)
  })
})
