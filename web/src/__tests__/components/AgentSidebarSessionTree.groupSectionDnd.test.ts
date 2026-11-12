import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentSidebarSessionTree from '../../components/agent/AgentSidebarSessionTree.vue'
import type { AgentTermSession } from '../../composables/useAgentTerminal'
import type { ProjectGroupItem } from '../../composables/useAgentSidebarDnd'

// 组段整区落点组件面（P-20261111-1-S2）：组头窄行落点外扩到整段组区——dragover/
// drop 挂 .ats-section 容器，组内行/空白也承接（内层落点在目标层 preventDefault
// 认领时让位），高亮同键挂组段（整段虚线框）不再只描组头。drop 契约（认领先吞
// 源、不认领不吞源）经真实冒泡链验证：组源 drop 在会话行上须冒泡到组段出口
// 重排序（旧实现行层无条件吞源会把这类 drop 吃成无动作）。
// jsdom 真渲染 naive-ui（groupsCollapse 同款全局 setup：fresh pinia + axios mock）。
const sessions: AgentTermSession[] = [
  { id: 's1', name: '会话一', runtime: 'claude', launched: true },
  { id: 's2', name: '会话二', runtime: 'claude', launched: true },
  { id: 's3', name: '会话三', runtime: 'claude', launched: true },
]
const groups = [
  { id: 'g1', name: '组A', sessionIds: ['s1'] },
  { id: 'g2', name: '组B', sessionIds: ['s2'] },
]
const projectGroups: ProjectGroupItem[] = [
  { projectId: 'p1', name: '项目一', sessions: [{ id: 'ps1', name: '项目会话一', running: false, attached: false }] },
  { projectId: 'p2', name: '项目二', sessions: [{ id: 'ps2', name: '项目会话二', running: false, attached: false }] },
]

function mountTree(withProjects = false) {
  return mount(AgentSidebarSessionTree, {
    props: {
      sessions,
      groups,
      projectGroups: withProjects ? projectGroups : [],
      filteredProjectGroups: withProjects ? projectGroups : [],
      filteredRootSessions: [sessions[2]!],
      filteredNamedGroups: groups,
      activeId: '',
    },
  })
}

/** 组段定位：带项目分组时区序 = [p1, p2, 未分组, g1, g2]；否则 [未分组, g1, g2] */
function sectionsOf(w: ReturnType<typeof mountTree>, withProjects: boolean) {
  const all = w.findAll('.ats-section')
  const base = withProjects ? 2 : 0
  return {
    root: all[base]!,
    g1: all[base + 1]!,
    g2: all[base + 2]!,
    p1: all[0]!,
    p2: all[1]!,
  }
}

describe('AgentSidebarSessionTree 组段整区落点（P-20261111-1-S2）', () => {
  it('组源 dragover 掠过组内行/组段：高亮挂整段组区（行不再单独描框），行层拒绝由组段承接', async () => {
    const w = mountTree()
    const { g1, g2 } = sectionsOf(w, false)
    // 拖组B → 悬停组A组段元素（组头外的空白区）
    await g2.find('.ats-group-head').trigger('dragstart')
    await g1.trigger('dragover')
    expect(g1.classes()).toContain('ats-drag-over')
    expect(g2.classes()).not.toContain('ats-drag-over')
    expect(g1.find('.ats-group-head').classes()).not.toContain('ats-drag-over')
    // 掠过组A内会话行：行层对组源拒绝（非会话源），冒泡由组段承接——同一高亮键
    await g1.find('.ats-item').trigger('dragover')
    expect(g1.classes()).toContain('ats-drag-over')
    expect(g1.find('.ats-item').classes()).not.toContain('ats-drag-over')
    w.unmount()
  })

  it('组源 drop 落在组内会话行上：行层不吞源，冒泡到组段出口重排序（回归修复）', async () => {
    const w = mountTree()
    const { g1, g2 } = sectionsOf(w, false)
    await g2.find('.ats-group-head').trigger('dragstart')
    await g1.find('.ats-item').trigger('drop')
    expect(w.emitted('reorder-groups')).toEqual([[['g2', 'g1']]])
    w.unmount()
  })

  it('会话源 dragover/drop 打在组段元素（非组头非行）：整区承接为移入该组', async () => {
    const w = mountTree()
    const { g2 } = sectionsOf(w, false)
    const s3 = w.findAll('.ats-section')[0]!.find('.ats-item')
    await s3.trigger('dragstart')
    await g2.trigger('dragover')
    expect(g2.classes()).toContain('ats-drag-over')
    await g2.trigger('drop')
    expect(w.emitted('move-session')).toEqual([[{ sessionId: 's3', toGroupId: 'g2' }]])
    w.unmount()
  })

  it('会话源悬停组内行：行级插入态优先（组段让位），drop 插到行前（既有语义保持）', async () => {
    const w = mountTree()
    const { g1 } = sectionsOf(w, false)
    const s3 = w.findAll('.ats-section')[0]!.find('.ats-item')
    await s3.trigger('dragstart')
    await g1.find('.ats-item').trigger('dragover')
    const row = g1.find('.ats-item')
    expect(row.classes()).toContain('ats-drag-over')
    expect(g1.classes()).not.toContain('ats-drag-over')
    await row.trigger('drop')
    expect(w.emitted('reorder-group-sessions')).toEqual([[{ groupId: 'g1', orderedIds: ['s3', 's1'] }]])
    w.unmount()
  })

  it('会话源自拖自落：吞掉无动作，不冒泡成伪移动', async () => {
    const w = mountTree()
    const { g1 } = sectionsOf(w, false)
    const s1row = g1.find('.ats-item')
    await s1row.trigger('dragstart')
    await s1row.trigger('drop')
    expect(w.emitted('move-session')).toBeUndefined()
    expect(w.emitted('reorder-group-sessions')).toBeUndefined()
    w.unmount()
  })

  it('未分组段整区承接：组内会话 drop 在未分组行/组段上 = 归根（拖出分组不须命中组头）', async () => {
    const w = mountTree()
    const { root, g1 } = sectionsOf(w, false)
    const s1row = g1.find('.ats-item')
    // dragover 未分组段元素（组头外空白）
    await s1row.trigger('dragstart')
    await root.trigger('dragover')
    expect(root.classes()).toContain('ats-drag-over')
    await root.trigger('drop')
    expect(w.emitted('move-session')).toEqual([[{ sessionId: 's1', toGroupId: '__root__' }]])
    // 行层拒绝路径：drop 打在未分组会话行上，冒泡到未分组段承接同语义
    await s1row.trigger('dragstart')
    await root.find('.ats-item').trigger('drop')
    expect(w.emitted('move-session')!.length).toBe(2)
    w.unmount()
  })

  it('项目组段整区同款：组源掠过项目会话行承接组序，项目会话 drop 组段 = 移入组尾', async () => {
    const w = mountTree(true)
    const { p1, p2 } = sectionsOf(w, true)
    // 拖项目组二 → 悬停项目组一组段元素与组内行：整段承接（移到目标组之前）
    await p2.find('.ats-group-head').trigger('dragstart')
    await p1.trigger('dragover')
    expect(p1.classes()).toContain('ats-drag-over')
    await p1.find('.ats-item').trigger('dragover')
    expect(p1.find('.ats-item').classes()).not.toContain('ats-drag-over')
    await p1.find('.ats-item').trigger('drop')
    expect(w.emitted('reorder-project-groups')).toEqual([[['p2', 'p1']]])
    // 项目会话 drop 在自己项目的组段元素上 = 移到组内末尾（组头落点同语义）
    await p1.find('.ats-item').trigger('dragstart')
    await p1.trigger('drop')
    expect(w.emitted('reorder-project-sessions')).toEqual([[{ projectId: 'p1', orderedIds: ['ps1'] }]])
    w.unmount()
  })
})
