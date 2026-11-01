import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTerminalSidebar from '../../components/agent/AgentTerminalSidebar.vue'
import { useProjectStore } from '../../stores/project'

// 侧栏「舰队发起」入口组件测试（P-20261005-152）：桥未注入降级隐藏、项目数
// 置灰门槛（title 门槛文案）与点击上抛。项目 store 以 reactive 外置状态注入
//（组件读取面同源，测试经同一 proxy 写入可验证 computed 响应式自愈——生产里
// 引导期拉取/变更流刷新即此路径）；i18n 走 setup.ts 真实 zh 文案直译，
// naive-ui 组件真渲染（NButton 无 teleport，jsdom 可查询）。
const projectState = vi.hoisted(() => ({
  projects: [] as { id: string; name: string; valid?: boolean }[],
}))
vi.mock('../../stores/project', async () => {
  const { reactive } = await import('vue')
  return { useProjectStore: () => reactive(projectState) }
})

const baseProps = {
  sessions: [],
  groups: [],
  activeId: '',
  booting: false,
}

function mountSidebar(provide?: Record<string, unknown>) {
  return mount(AgentTerminalSidebar, {
    props: baseProps,
    global: { provide },
    attachTo: document.body,
  })
}

describe('AgentTerminalSidebar 舰队发起入口', () => {
  it('桥未注入：舰队钮降级隐藏，新建会话钮照常', () => {
    const w = mountSidebar()
    expect(w.find('[data-test="fleet-launch-entry"]').exists()).toBe(false)
    expect(w.findAll('button').some(b => b.text().includes('新建会话'))).toBe(true)
    w.unmount()
  })

  it('零/单项目：置灰且 title 为门槛说明（与弹层内校验同语义前置）', async () => {
    const store = useProjectStore()
    projectState.projects = [{ id: 'p1', name: 'only-one' }]
    const w = mountSidebar({ openFleetBulkAgent: vi.fn() })
    const btn = w.find('[data-test="fleet-launch-entry"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toContain('需两个以上项目')
    // 补第二项目（经 reactive proxy 写入）：computed 自愈解禁、title 换功能说明
    store.projects = [{ id: 'p1', name: 'a' }, { id: 'p2', name: 'b' }]
    await w.vm.$nextTick()
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('title')).toContain('舰队发起')
    w.unmount()
  })

  it('两项目：可点且 title 携 Ctrl+K 可搜说明，点击上抛桥回调', async () => {
    projectState.projects = [{ id: 'p1', name: 'a' }, { id: 'p2', name: 'b' }]
    const opener = vi.fn()
    const w = mountSidebar({ openFleetBulkAgent: opener })
    const btn = w.find('[data-test="fleet-launch-entry"]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('title')).toContain('Ctrl+K')
    await btn.trigger('click')
    expect(opener).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})
