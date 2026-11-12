import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AgentSidebarSessionTree from '../../components/agent/AgentSidebarSessionTree.vue'
import type { AgentTermSession } from '../../composables/useAgentTerminal'

// 自定义分组折叠/计数徽标组件面（P-20261111-1-S1）：组头 chevron + 会话计数
// 徽标 + click 折叠语义与项目分组组头对齐——计数恒显、折叠只藏行；折叠集合
// 由宿主持有（prop 只读投影），切换经 toggle-group 事件上抛。jsdom 真渲染
// naive-ui（AgentTerminalSidebarFleet.test.ts 同款），store 走全局 setup 的
// fresh pinia + axios mock。
const sessions: AgentTermSession[] = [
  { id: 's1', name: '会话一', runtime: 'claude', launched: true },
  { id: 's2', name: '会话二', runtime: 'claude', launched: true },
]
const groups = [
  { id: 'g1', name: '组A', sessionIds: ['s1', 's2'] },
  { id: 'g2', name: '组B', sessionIds: [] },
]

function mountTree(collapsedGroups?: Set<string>) {
  return mount(AgentSidebarSessionTree, {
    props: {
      sessions,
      groups,
      projectGroups: [],
      filteredProjectGroups: [],
      filteredRootSessions: [],
      filteredNamedGroups: groups,
      activeId: '',
      collapsedGroups,
    },
  })
}

describe('AgentSidebarSessionTree 自定义分组折叠与计数徽标（P-20261111-1-S1）', () => {
  it('组头渲染折叠箭头与会话计数徽标：计数恒显（含空组 0）', () => {
    const w = mountTree()
    const sections = w.findAll('.ats-section')
    expect(sections.length).toBe(2)
    // 折叠箭头与计数徽标同款项目分组视觉语
    expect(sections[0]!.find('.ats-fold').exists()).toBe(true)
    expect(sections[1]!.find('.ats-fold').exists()).toBe(true)
    expect(sections[0]!.find('.ats-group-count').text()).toBe('2')
    expect(sections[1]!.find('.ats-group-count').text()).toBe('0')
    w.unmount()
  })

  it('折叠只藏行：collapsedGroups 命中组不渲染会话行，组头与计数照常在场', () => {
    const w = mountTree(new Set(['g1']))
    const sections = w.findAll('.ats-section')
    expect(sections[0]!.find('.ats-group-count').text()).toBe('2')
    // g1 折叠：两行会话都藏；g2 本就无行
    expect(sections[0]!.findAll('.ats-item').length).toBe(0)
    expect(sections[1]!.findAll('.ats-item').length).toBe(0)
    // 展开组照常渲染行
    const w2 = mountTree(new Set(['g2']))
    expect(w2.findAll('.ats-section')[0]!.findAll('.ats-item').length).toBe(2)
    w.unmount()
    w2.unmount()
  })

  it('组头 click 上抛 toggle-group（持久化语义在宿主）；⋯ 菜单钮 stopPropagation 不触发折叠', async () => {
    const w = mountTree()
    const sections = w.findAll('.ats-section')
    await sections[0]!.find('.ats-group-head').trigger('click')
    expect(w.emitted('toggle-group')).toEqual([['g1']])
    await sections[1]!.find('.ats-group-head').trigger('click')
    expect(w.emitted('toggle-group')).toEqual([['g1'], ['g2']])
    // ⋯ 按钮 @click.stop：只开菜单不改折叠
    await sections[0]!.find('.ats-group-more').trigger('click')
    expect(w.emitted('toggle-group')).toEqual([['g1'], ['g2']])
    w.unmount()
  })

  it('未传 collapsedGroups（缺省）= 全展开不炸', () => {
    const w = mountTree(undefined)
    expect(w.findAll('.ats-section')[0]!.findAll('.ats-item').length).toBe(2)
    w.unmount()
  })
})
