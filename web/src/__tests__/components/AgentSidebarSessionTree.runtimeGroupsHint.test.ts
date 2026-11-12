import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentSidebarSessionTree from '../../components/agent/AgentSidebarSessionTree.vue'
import type { AgentTermSession } from '../../composables/useAgentTerminal'

// runtime 视图共存提示组件面（P-20261111-1-S3）：自定义分组整区让位时弱提示
// 行只计数不渲染组内容（双渲染红线），点击上抛 exit-runtime-view 由宿主切回
// 平铺。jsdom 真渲染 naive-ui（groupsCollapse.test.ts 同款装配）。
const sessions: AgentTermSession[] = [
  { id: 's1', name: '会话一', runtime: 'claude', launched: true },
  { id: 's2', name: '会话二', runtime: 'dsh', launched: true },
]
const groups = [
  { id: 'g1', name: '组A', sessionIds: ['s1'] },
  { id: 'g2', name: '组B', sessionIds: [] },
]
const runtimeGroups = [
  { key: 'claude', sessions: [sessions[0]!] },
  { key: 'dsh', sessions: [sessions[1]!] },
]

function mountTree(overrides: Partial<Record<string, unknown>> = {}) {
  return mount(AgentSidebarSessionTree, {
    props: {
      sessions,
      groups,
      projectGroups: [],
      filteredProjectGroups: [],
      filteredRootSessions: [],
      filteredNamedGroups: groups,
      activeId: '',
      ...overrides,
    },
  })
}

describe('AgentSidebarSessionTree runtime 视图共存提示（P-20261111-1-S3）', () => {
  it('runtime 视图 + 有自定义分组：提示行在场携计数（组内容不双渲染）', () => {
    const w = mountTree({ runtimeView: true, runtimeGroups })
    const hint = w.find('[data-test="session-runtime-groups-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('2')
    // 平铺两区（未分组 + 自定义分组段）让位：无 ats-section 组段、无自定义组头
    expect(w.findAll('.ats-group-head.is-group').length).toBe(0)
    // runtime 组段照常渲染
    expect(w.findAll('[data-test="session-runtime-group"]').length).toBe(2)
    w.unmount()
  })

  it('平铺视图 / 无自定义分组：提示行不渲染（无意义提示）', () => {
    const flat = mountTree()
    expect(flat.find('[data-test="session-runtime-groups-hint"]').exists()).toBe(false)
    flat.unmount()
    const noGroups = mountTree({ runtimeView: true, runtimeGroups, groups: [], filteredNamedGroups: [] })
    expect(noGroups.find('[data-test="session-runtime-groups-hint"]').exists()).toBe(false)
    noGroups.unmount()
  })

  it('计数取 filteredNamedGroups（宿主已按筛选收窄的平铺可见集，切回所见即所报）', () => {
    const w = mountTree({ runtimeView: true, runtimeGroups, filteredNamedGroups: [groups[0]!] })
    const hint = w.find('[data-test="session-runtime-groups-hint"]')
    expect(hint.text()).toContain('1')
    w.unmount()
  })

  it('click 上抛 exit-runtime-view（视图开关在宿主）；button 语义自带键盘可达', async () => {
    const w = mountTree({ runtimeView: true, runtimeGroups })
    const hint = w.find('[data-test="session-runtime-groups-hint"]')
    expect(hint.element.tagName).toBe('BUTTON')
    expect((hint.element as HTMLButtonElement).type).toBe('button')
    await hint.trigger('click')
    expect(w.emitted('exit-runtime-view')).toEqual([[]])
    w.unmount()
  })
})
