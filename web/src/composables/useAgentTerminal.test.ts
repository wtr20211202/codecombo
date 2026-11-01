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
import {
  resetAgentTerminalStateForTest,
  useAgentTerminal,
} from './useAgentTerminal'
import { usePanelLayout } from './usePanelLayout'

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
