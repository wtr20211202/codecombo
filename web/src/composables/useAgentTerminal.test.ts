import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 终端域 API 全量 mock：composable 只依赖 list/createAgent/rename/close
vi.mock('../api/domains/terminal', () => ({
  terminalApi: {
    list: vi.fn(),
    createAgent: vi.fn(),
    rename: vi.fn(),
    close: vi.fn(),
    resize: vi.fn(),
  },
  getTerminalWsUrl: (id: string) => `ws://${id}`,
}))

import { terminalApi } from '../api/domains/terminal'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useProjectStore } from '../stores/project'
import router from '../router'
import {
  resetAgentTerminalStateForTest,
  useAgentTerminal,
} from './useAgentTerminal'
import { usePanelLayout } from './usePanelLayout'

// 全局 setup.ts 把 vue-router 整体 mock（业务单测不触路由）——本文件的导航语义
// 用例（P-20261107-3）要真实路由表驱动 afterEach 记忆链，且 useAgentTerminal
// 现依赖 router.afterEach 安装，文件级还原真实现（presentAtoms.test.ts 同款）。
// 路由组件换空壳桩：导航触发的懒加载会拖入 HomeView/Layout 全量依赖
// （Monaco 等），jsdom 下既慢又脆——记忆链只吃路由 name，不渲染组件
vi.mock('vue-router', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()) }))
vi.mock('../views/home/HomeView.vue', () => ({ default: { render: () => null } }))
vi.mock('../views/Layout.vue', () => ({ default: { render: () => null } }))

const mockedApi = vi.mocked(terminalApi, true)

/** 统一包一层响应形态：axios 拦截器返回 gin body，业务负载在 res.data（真实形态） */
function apiRes<T>(data: T) {
  return Promise.resolve({ data }) as any
}

beforeEach(() => {
  resetAgentTerminalStateForTest()
  // resetAllMocks（而非 clearAllMocks）：连同 mockReturnValue 实现一起重置，
  // 否则上一个用例的返回值会泄漏进后续用例（refresh 列表复用导致会话数翻倍）
  vi.resetAllMocks()
})

describe('useAgentTerminal 多会话', () => {
  it('refresh 按 kind=agent 过滤并修正 activeId', async () => {
    mockedApi.list.mockReturnValue(apiRes([
      { id: 'term-1', name: 'T1', kind: 'shell' },
      { id: 'agent-a', name: '智能体 1', kind: 'agent' },
      { id: 'agent-b', name: '智能体 2', kind: 'agent' },
    ]) as any)

    const { sessions, activeId, refresh } = useAgentTerminal()
    expect(await refresh()).toBe(true)
    expect(sessions.value.map(s => s.id)).toEqual(['agent-a', 'agent-b'])
    expect(activeId.value).toBe('agent-a')
  })

  it('refresh 失败返回 false 且不清空现有列表', async () => {
    mockedApi.list.mockRejectedValueOnce(new Error('network') as any)
    const { sessions, refresh } = useAgentTerminal()
    // 会话列表是 computed 视图（数据在 terminal-sessions store）：经快照播种
    useTerminalSessionsStore().applySnapshot([{ id: 'agent-a', name: 'x', kind: 'agent' }])
    expect(await refresh()).toBe(false)
    expect(sessions.value).toHaveLength(1)
  })

  it('create 追加会话并置为活动；未显式命名不传名（服务端命名/槽位继承）', async () => {
    mockedApi.createAgent.mockReturnValue(apiRes({
      id: 'agent-1', name: '终端 1', runtime: 'claude', launched: true,
    }) as any)

    const { sessions, activeId, create } = useAgentTerminal()
    const s = await create('codex')
    expect(s?.id).toBe('agent-1')
    expect(mockedApi.createAgent).toHaveBeenCalledWith(undefined, 'codex', undefined, { dir: undefined })
    expect(sessions.value).toHaveLength(1)
    expect(activeId.value).toBe('agent-1')

    // 第二个会话：同样不传默认名（服务端命名，mock 返回服务端名，本地尊重服务端）
    mockedApi.createAgent.mockReturnValue(apiRes({ id: 'agent-2', name: 'Agent 2' }) as any)
    const s2 = await create()
    expect(mockedApi.createAgent).toHaveBeenLastCalledWith(undefined, undefined, undefined, { dir: undefined })
    expect(activeId.value).toBe(s2?.id)
  })

  it('create 透传 launchArgs（prompt 预填场景，编辑器询问智能体）', async () => {
    mockedApi.createAgent.mockReturnValue(apiRes({
      id: 'agent-9', name: '智能体 1', runtime: 'claude', launched: true,
    }) as any)

    const { create } = useAgentTerminal()
    const s = await create(undefined, { dir: '/repo', launchArgs: '请分析 src/a.ts' })
    expect(s?.id).toBe('agent-9')
    expect(mockedApi.createAgent).toHaveBeenLastCalledWith(undefined, undefined, undefined, { dir: '/repo', launchArgs: '请分析 src/a.ts' })
  })

  it('rename 同步服务端与本地', async () => {
    mockedApi.rename.mockResolvedValue({} as any)
    const { sessions, create, rename } = useAgentTerminal()
    mockedApi.createAgent.mockReturnValue(apiRes({ id: 'agent-1', name: '智能体 1' }) as any)
    const s = await create()
    expect(s).toBeTruthy()
    await rename(s!.id, '新名字')
    expect(sessions.value[0]?.name).toBe('新名字')
  })

  it('destroy 移除会话并把活动会话让渡给剩余项', async () => {
    mockedApi.close.mockResolvedValue({} as any)
    const { sessions, activeId, create, destroy } = useAgentTerminal()
    mockedApi.createAgent.mockReturnValueOnce(apiRes({ id: 'agent-1', name: 'A1' }) as any)
    mockedApi.createAgent.mockReturnValueOnce(apiRes({ id: 'agent-2', name: 'A2' }) as any)
    await create()
    const second = await create()
    expect(activeId.value).toBe('agent-2')

    await destroy('agent-2')
    expect(sessions.value.map(s => s.id)).toEqual(['agent-1'])
    expect(activeId.value).toBe('agent-1')
    expect(second).toBeTruthy()
  })

  it('ensureOne：无会话时仅刷新对账，不再静默创建', async () => {
    mockedApi.list.mockReturnValueOnce(apiRes([]) as any)

    const { ensureOne, sessions } = useAgentTerminal()
    expect(await ensureOne()).toBe(true)
    expect(sessions.value).toHaveLength(0)
    expect(mockedApi.createAgent).not.toHaveBeenCalled()
  })
})

describe('useAgentTerminal 形态', () => {
  it('open(docked) 置可见并关闭远程控制台主区视图', async () => {
    const layout = usePanelLayout()
    layout.showRemoteConsole.value = true

    const { open, visible, mode } = useAgentTerminal()
    await open('docked')
    expect(visible.value).toBe(true)
    expect(mode.value).toBe('docked')
    expect(layout.showRemoteConsole.value).toBe(false)
  })

  // 笔记独立视图（P-20261108-2，第六主区占用者）：docked 管理页打开即收起——
  // 首页 overlay 与项目页主区两宿主共用同一开态，closeMainViews 一处收口
  it('open(docked) 收起笔记独立视图（主区互斥 closeMainViews 扩员）', async () => {
    const layout = usePanelLayout()
    layout.openNotesView()
    expect(layout.showNotesView.value).toBe(true)

    const { open, visible } = useAgentTerminal()
    await open('docked')
    expect(visible.value).toBe(true)
    expect(layout.showNotesView.value).toBe(false)
  })

  it('open(float) 不收笔记视图（悬浮窗是全局悬浮层，与主区视图共存）', async () => {
    mockedApi.list.mockReturnValue(apiRes([]) as any)
    const layout = usePanelLayout()
    layout.openNotesView()
    const { open } = useAgentTerminal()
    await open('float')
    expect(layout.showNotesView.value).toBe(true)
    layout.closeNotesView()
  })

  it('open(float) 缺会话不再自动创建（空态引导显式新建，防多出未分组会话）', async () => {
    mockedApi.list.mockReturnValue(apiRes([]) as any)
    const { open, visible, mode, sessions } = useAgentTerminal()
    await open('float')
    expect(visible.value).toBe(true)
    expect(mode.value).toBe('float')
    expect(sessions.value).toHaveLength(0)
    expect(mockedApi.createAgent).not.toHaveBeenCalled()
  })

  it('collapse 记录展开形态，mini 单击展开回到该形态', async () => {
    mockedApi.createAgent.mockReturnValue(apiRes({ id: 'agent-1', name: '智能体 1' }) as any)
    const { open, collapse, mode, expandedMode, visible } = useAgentTerminal()
    await open('float')
    collapse()
    expect(mode.value).toBe('mini')
    expect(expandedMode.value).toBe('float')
    expect(visible.value).toBe(true)

    // mini 下无参 open 回到 float
    const { open: open2 } = useAgentTerminal()
    await open2()
    expect(mode.value).toBe('float')
  })

  it('toggleDocked：关 → 开(docked) → 关', async () => {
    const { toggleDocked, visible, mode } = useAgentTerminal()
    toggleDocked()
    await vi.waitFor(() => expect(visible.value).toBe(true))
    expect(mode.value).toBe('docked')

    toggleDocked()
    expect(visible.value).toBe(false)
  })

  it('hide 仅隐藏不销毁会话', async () => {
    mockedApi.createAgent.mockReturnValue(apiRes({ id: 'agent-1', name: '智能体 1' }) as any)
    const { open, hide, visible, sessions, create } = useAgentTerminal()
    await open('float')
    await create()
    hide()
    expect(visible.value).toBe(false)
    expect(sessions.value).toHaveLength(1)
    expect(mockedApi.close).not.toHaveBeenCalled()
  })
})

// ============== 导航语义（P-20261107-3）：回首页=纯首页，进项目恢复此前布局 ==============
// 走真实 router（jsdom 下 web history）驱动 afterEach 记忆链；项目 id 直写
// project store（与 TopBar 切项目/首页 enterProject 同一写入面）
describe('useAgentTerminal 导航语义（P-20261107-3）', () => {
  it('回首页路过收起 docked；再进项目恢复此前布局（开态）', async () => {
    await router.push({ name: 'home' })
    useProjectStore().currentProjectId = 'p-nav-1'
    await router.push({ name: 'project' })

    const t = useAgentTerminal()
    await t.open('docked')
    expect(t.visible.value).toBe(true)

    await router.push({ name: 'home' })
    expect(t.visible.value).toBe(false) // 路过收起，首页=纯首页

    await router.push({ name: 'project' })
    expect(t.visible.value).toBe(true) // 布局还原
    expect(t.mode.value).toBe('docked')
  })

  it('记忆为关也恢复：项目内关掉→回首页→进项目不开', async () => {
    await router.push({ name: 'home' })
    useProjectStore().currentProjectId = 'p-nav-2'
    await router.push({ name: 'project' })

    const t = useAgentTerminal()
    await t.open('docked')
    t.hide()

    await router.push({ name: 'home' })
    await router.push({ name: 'project' })
    expect(t.visible.value).toBe(false)
  })

  it('float 活跃时进项目不降级打断（悬浮层跟随导航既有行为）', async () => {
    await router.push({ name: 'home' })
    useProjectStore().currentProjectId = 'p-nav-3'
    await router.push({ name: 'project' })

    const t = useAgentTerminal()
    await t.open('docked')
    await router.push({ name: 'home' }) // 采集 {开} + 路过收起
    await t.setMode('float') // 用户在首页主动切 float
    await router.push({ name: 'project' }) // 记忆开但 float 活跃 → 不打断
    expect(t.mode.value).toBe('float')
    expect(t.visible.value).toBe(true)
  })

  it('项目路由内切项目（TopBar 同款）：离旧采集、进新恢复（含关态）', async () => {
    await router.push({ name: 'home' })
    const projectStore = useProjectStore()
    projectStore.currentProjectId = 'p-a'
    await router.push({ name: 'project' })

    const t = useAgentTerminal()
    await t.open('docked')
    // 在项目路由内切到 B（首次进入，记忆缺席 → 现状流入），再以关态离场播种 B。
    // 切换是 pre-flush watch：等一拍调度刷新让采集读到切换时的真实开态，
    // 再做后续同步动作（真实应用里两次用户输入天然不同 tick）
    projectStore.currentProjectId = 'p-b'
    await nextTick()
    t.hide()
    await router.push({ name: 'home' })
    await router.push({ name: 'project' })

    // 项目路由内切回 A：记忆开 → 恢复；再切到 B：记忆关 → 收起
    projectStore.currentProjectId = 'p-a'
    await nextTick()
    await vi.waitFor(() => expect(t.visible.value).toBe(true))
    projectStore.currentProjectId = 'p-b'
    await nextTick()
    await vi.waitFor(() => expect(t.visible.value).toBe(false))
  })
})
