import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// 终端域 API 全量 mock：store 只依赖 list/createAgent/create/attachExternal/rename/close
vi.mock('../api/domains/terminal', () => ({
  terminalApi: {
    list: vi.fn(),
    createAgent: vi.fn(),
    create: vi.fn(),
    attachExternal: vi.fn(),
    rename: vi.fn(),
    close: vi.fn(),
    resize: vi.fn(),
  },
  getTerminalWsUrl: (id: string) => `ws://${id}`,
}))

import { terminalApi } from '../api/domains/terminal'
import { createDiscreteApi } from 'naive-ui'
import { getFailedCommandRecord, markCommandOutcome } from '../composables/terminalCommandMarks'
import { termInstances } from '../composables/useTerminalInstances'
import { sessionWorkingDir, useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useAssistantTaskStore } from '../stores/assistantTask'

const mockedApi = vi.mocked(terminalApi, true)

/** 统一包一层响应形态：axios 拦截器返回 gin body，业务负载在 res.data（真实形态） */
function apiRes<T>(data: T) {
  return Promise.resolve({ data }) as any
}

beforeEach(() => {
  vi.resetAllMocks()
  useTerminalSessionsStore().resetForTest()
})

describe('terminal-sessions store', () => {
  it('refresh 快照全量替换并分类：agent → systemSessions，shell+projectId → projectSessions', async () => {
    mockedApi.list.mockReturnValue(apiRes([
      { id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1', path: '/x' },
      { id: 'term-2', name: 'T2', kind: 'shell', projectId: 'p2', path: '/y' },
      { id: 'agent-a', name: '智能体 1', kind: 'agent' },
    ]) as any)

    const store = useTerminalSessionsStore()
    expect(await store.refresh()).toBe(true)
    expect(store.loaded).toBe(true)
    expect(store.systemSessions.map(s => s.id)).toEqual(['agent-a'])
    expect(store.projectSessions.map(s => s.id)).toEqual(['term-1', 'term-2'])
    expect(store.sessionsByProject.get('p1')?.map(s => s.id)).toEqual(['term-1'])
    expect(store.sessionsByProject.get('p2')?.map(s => s.id)).toEqual(['term-2'])
  })

  it('refresh 失败保留现状不置 loaded', async () => {
    mockedApi.list.mockRejectedValueOnce(new Error('network') as any)
    const store = useTerminalSessionsStore()
    store.applySnapshot([{ id: 'agent-a', name: 'x', kind: 'agent' }])
    expect(await store.refresh()).toBe(false)
    expect(store.loaded).toBe(false)
    expect(store.sessions).toHaveLength(1)
  })

  it('applySnapshot 保留已知 runtime/runtimeVersion 并清理挂接表/运行态孤儿', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([{ id: 'agent-a', name: 'A', kind: 'agent' }])
    store.sessions.find(s => s.id === 'agent-a')!.runtime = 'claude'
    store.sessions.find(s => s.id === 'agent-a')!.runtimeVersion = '2.1.3'
    store.attachToManager('term-1')
    store.reportOsc('term-1', 'C')
    store.reportOsc('ghost', 'C')

    // 新快照：agent-a 仍在（runtime/runtimeVersion 保留）、term-1 消亡、ghost 从运行态清理
    store.applySnapshot([{ id: 'agent-a', name: 'A2', kind: 'agent' }])
    expect(store.sessions[0]!.runtime).toBe('claude')
    expect(store.sessions[0]!.runtimeVersion).toBe('2.1.3')
    expect(store.managerAttached.size).toBe(0)
    expect(store.runningMap).not.toHaveProperty('ghost')
  })

  // 运行时版本快照（P-20261003-134）：快照携带即透传（服务端 meta 反查持久
  // 面），缺省保留已知值（创建响应先行、meta 异步落库窗口）；旧会话无值空显
  it('applySnapshot 透传 runtimeVersion，缺省保留已知值，旧会话无值缺省', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'agent-a', name: 'A', kind: 'agent' },
      { id: 'agent-old', name: 'Old', kind: 'agent' },
    ])
    store.sessions.find(s => s.id === 'agent-a')!.runtimeVersion = 'v22.1.0'

    store.applySnapshot([
      { id: 'agent-a', name: 'A', kind: 'agent', runtimeVersion: 'v22.2.0' },
      { id: 'agent-old', name: 'Old', kind: 'agent' },
    ])
    // 快照携带 → 以快照为准（服务端 meta 是持久事实源）
    expect(store.sessions.find(s => s.id === 'agent-a')!.runtimeVersion).toBe('v22.2.0')
    // 旧会话快照无值且无已知值 → undefined（tooltip 空显）
    expect(store.sessions.find(s => s.id === 'agent-old')!.runtimeVersion).toBeUndefined()
  })

  // 初始指令（P-20261003-146）：快照携带即透传（「重新发起」预填数据面），
  // 缺省保留已知值（创建响应先行、meta 异步落库窗口——字段创建后不变更，
  // 兜底无过期风险）；无记录会话 undefined（入口空显不虚构）
  it('applySnapshot 透传 initialPrompt，缺省保留已知值，无记录 undefined', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'agent-a', name: 'A', kind: 'agent' },
      { id: 'agent-old', name: 'Old', kind: 'agent' },
    ])
    store.sessions.find(s => s.id === 'agent-a')!.initialPrompt = '审计任务'

    store.applySnapshot([
      { id: 'agent-a', name: 'A', kind: 'agent', initialPrompt: '审计任务 v2' },
      { id: 'agent-old', name: 'Old', kind: 'agent' },
    ])
    // 快照携带 → 以快照为准（服务端 meta 是持久事实源）
    expect(store.sessions.find(s => s.id === 'agent-a')!.initialPrompt).toBe('审计任务 v2')
    // 无记录且无已知值 → undefined
    expect(store.sessions.find(s => s.id === 'agent-old')!.initialPrompt).toBeUndefined()

    // 创建响应先行的已知值在快照缺 key（meta 异步落库窗口）时不被冲掉
    store.applySnapshot([{ id: 'agent-a', name: 'A', kind: 'agent' }])
    expect(store.sessions.find(s => s.id === 'agent-a')!.initialPrompt).toBe('审计任务 v2')
  })

  // 关闭清账（P-20261003-303）：快照对账知会 assistantTask——已关会话的
  // running 进度归属随之清掉（done 终态保留），值班大屏假阳性卡消失。
  // 假时钟 + 逐笔推进：updatedAt 需严格递增才能锚定「最新归属」判定
  it('applySnapshot 知会 assistantTask 关闭清账：running 归属清除、done 保留', () => {
    vi.useFakeTimers()
    try {
      const sessions = useTerminalSessionsStore()
      const taskStore = useAssistantTaskStore()
      taskStore.progressFor('agent-b', { task: '已完成任务', status: 'done' })
      vi.advanceTimersByTime(10)
      taskStore.progressFor('agent-a', { task: '运行中任务' }) // 最新归属

      sessions.applySnapshot([{ id: 'agent-a', name: 'A', kind: 'agent' }])
      expect(taskStore.bySession['agent-a']?.status).toBe('running') // 存活不动

      // agent-a 消亡 → running 归属清；agent-b 的 done 终态保留供回看
      sessions.applySnapshot([])
      expect(taskStore.bySession['agent-a']).toBeUndefined()
      expect(taskStore.bySession['agent-b']?.status).toBe('done')
      // 最新归属（agent-a）被清且无其他 running → 全局 running 收敛
      expect(taskStore.active).toBe(false)
      expect(taskStore.status).toBe('')
    } finally {
      useAssistantTaskStore().resetForTest()
      vi.useRealTimers()
    }
  })

  it('reportOsc：C 点亮 / D 熄灭运行态，E 不改变运行态但刷新活动时间戳', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([{ id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1' }])

    store.reportOsc('term-1', 'C')
    expect(store.runningMap['term-1']).toBe(true)
    // E（命令文本）在 C 与 D 之间到达：不得把运行点闪灭
    store.reportOsc('term-1', 'E')
    expect(store.runningMap['term-1']).toBe(true)
    expect(store.activityMap['term-1']).toBeGreaterThan(0)
    store.reportOsc('term-1', 'D')
    expect(store.runningMap['term-1']).toBe(false)
  })

  // 最近命令面（P-20261004-37 停滞分诊数据面）：E 记命令文本（正在跑什么），
  // D 覆盖为 命令+退出码（最后跑完什么）；只留最近一条，死会话随快照清账
  it('reportOsc detail 写 lastCmdMap：E 先行记命令，D 覆盖为命令+退出码，孤儿清理', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([{ id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1' }])

    store.reportOsc('term-1', 'E', { command: 'npm test' })
    expect(store.lastCmdMap['term-1']).toMatchObject({ command: 'npm test' })
    expect(store.lastCmdMap['term-1']!.exitCode).toBeUndefined()
    store.reportOsc('term-1', 'D', { command: 'npm test', exitCode: 1 })
    expect(store.lastCmdMap['term-1']).toMatchObject({ command: 'npm test', exitCode: 1 })
    // 无 detail 的旧形态调用方零回归：不覆盖既有记录
    store.reportOsc('term-1', 'C')
    expect(store.lastCmdMap['term-1']).toMatchObject({ command: 'npm test', exitCode: 1 })
    // 快照对账清理孤儿
    store.reportOsc('ghost', 'D', { command: 'x', exitCode: 0 })
    store.applySnapshot([{ id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1' }])
    expect(store.lastCmdMap).not.toHaveProperty('ghost')
    expect(store.lastCmdMap).toHaveProperty('term-1')
  })

  it('排序：default 保持服务端序；name 按名称；activity 按活动时间倒序（无记录殿后）', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'b', name: 'Bravo', kind: 'agent' },
      { id: 'a', name: 'alpha', kind: 'agent' },
      { id: 'c', name: 'Charlie', kind: 'agent' },
    ])

    expect(store.sortedSessions.map(s => s.id)).toEqual(['b', 'a', 'c'])

    store.setSortMode('name')
    expect(store.sortedSessions.map(s => s.id)).toEqual(['a', 'b', 'c'])

    store.setSortMode('activity')
    // 直接盖时间戳保证确定性（reportOsc 的 Date.now() 同毫秒会持平）
    store.activityMap['c'] = 200
    store.activityMap['a'] = 100
    // c 后活动 → 最前；b 无活动记录 → 殿后
    expect(store.sortedSessions.map(s => s.id)).toEqual(['c', 'a', 'b'])

    store.setSortMode('default')
    expect(store.sortedSessions.map(s => s.id)).toEqual(['b', 'a', 'c'])
  })

  it('createAgent / createProject upsert 本地并携带响应字段', async () => {
    mockedApi.createAgent.mockReturnValue(apiRes({
      id: 'agent-1', name: '终端 1', path: '~', createdAt: 't1', runtime: 'claude',
      runtimeVersion: '2.1.3 (Claude Code)',
    }) as any)
    mockedApi.create.mockReturnValue(apiRes({
      id: 'term-9', name: 'Terminal', path: '/p', createdAt: 't2',
    }) as any)

    const store = useTerminalSessionsStore()
    const agent = await store.createAgent('终端 1', 'claude')
    expect(agent?.runtime).toBe('claude')
    // 创建响应同步携带版本（P-20261003-134：meta 异步落库，响应先行防闪断）
    expect(agent?.runtimeVersion).toBe('2.1.3 (Claude Code)')
    const proj = await store.createProject('p1', 'Terminal')
    expect(proj?.kind).toBe('shell')
    expect(store.sessions).toHaveLength(2)
  })

  it('attach/return 独占挂接：attachToManager → returnAllToPanel 清空', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1' },
      { id: 'term-2', name: 'T2', kind: 'shell', projectId: 'p1' },
    ])
    store.attachToManager('term-1')
    store.attachToManager('term-2')
    expect(store.managerAttached.has('term-1')).toBe(true)
    store.returnToPanel('term-1')
    expect([...store.managerAttached]).toEqual(['term-2'])
    store.returnAllToPanel()
    expect(store.managerAttached.size).toBe(0)
  })

  it('destroy 调 API 并本地清理；markExited 仅本地清理', async () => {
    mockedApi.close.mockResolvedValue({} as any)
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1' },
      { id: 'agent-a', name: 'A', kind: 'agent' },
    ])
    store.attachToManager('term-1')

    await store.destroy('term-1')
    expect(mockedApi.close).toHaveBeenCalledWith('term-1')
    expect(store.sessions.map(s => s.id)).toEqual(['agent-a'])

    store.markExited('agent-a')
    expect(store.sessions).toHaveLength(0)
    expect(mockedApi.close).toHaveBeenCalledTimes(1)
  })

  // 外部 tmux 会话接管（P-20261005-189）：attachExternal upsert 本地（origin=
  // external，快照对账保留）；killExternal 携 kill=1 显式终结
  it('attachExternal upsert 本地并标 origin=external；快照对账透传 origin', async () => {
    mockedApi.attachExternal.mockReturnValue(apiRes({
      id: 'build-task', name: 'build-task', path: '/srv', createdAt: '2026-10-08T00:00:00Z', kind: 'agent', origin: 'external', attached: 1, totalSessions: 2,
    }) as any)
    const store = useTerminalSessionsStore()
    const info = await store.attachExternal('build-task')
    expect(mockedApi.attachExternal).toHaveBeenCalledWith('build-task', undefined)
    expect(info?.origin).toBe('external')
    expect(store.systemSessions.map(s => s.id)).toEqual(['build-task'])

    // 快照对账：服务端携带的 origin 透传；旧服务端无 origin 字段缺省（undefined 视为 self）
    store.applySnapshot([{ id: 'build-task', name: 'build-task', kind: 'agent', origin: 'external' }])
    expect(store.sessions.find(s => s.id === 'build-task')?.origin).toBe('external')
    store.applySnapshot([{ id: 'term-9', name: 'T', kind: 'shell', projectId: 'p1' }])
    expect(store.sessions.find(s => s.id === 'term-9')?.origin).toBeUndefined()
  })

  it('killExternal 调 close 携 kill=1；destroy 不带（外部 close 缺省=解除接管）', async () => {
    mockedApi.close.mockResolvedValue({} as any)
    const store = useTerminalSessionsStore()
    store.applySnapshot([{ id: 'build-task', name: 'B', kind: 'agent', origin: 'external' }])

    await store.destroy('build-task')
    expect(mockedApi.close).toHaveBeenCalledWith('build-task')
    expect(store.sessions).toHaveLength(0)

    store.applySnapshot([{ id: 'build-task', name: 'B', kind: 'agent', origin: 'external' }])
    await store.killExternal('build-task')
    expect(mockedApi.close).toHaveBeenCalledWith('build-task', true)
    expect(store.sessions).toHaveLength(0)
  })

  // 后台 tab 未读活动点（P-20261003-310）：输出钩子 markUnread 只点亮后台会话；
  // 宿主可见登记 setHostVisible 即清除；快照对账清理死会话
  it('markUnread/setHostVisible：后台点亮、可见不亮、登记即清、已亮幂等', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1' },
      { id: 'term-2', name: 'T2', kind: 'shell', projectId: 'p1' },
    ])

    // 无宿主登记（页面刚起/宿主未挂）：任何会话都是后台
    store.markUnread('term-1')
    expect(store.unreadMap['term-1']).toBe(true)
    // 已亮幂等：重复点亮不产生新状态（一次性布尔）
    store.markUnread('term-1')
    expect(store.unreadMap['term-1']).toBe(true)

    // 登记可见（激活语义）：清除该会话未读；其输出不再点亮
    store.setHostVisible('bottomTerminal', ['term-1'])
    expect(store.unreadMap['term-1']).toBeUndefined()
    store.markUnread('term-1')
    expect(store.unreadMap['term-1']).toBeUndefined()

    // 可见登记之外的会话照常点亮；撤登记（宿主隐藏）后恢复后台语义
    store.markUnread('term-2')
    expect(store.unreadMap['term-2']).toBe(true)
    store.setHostVisible('bottomTerminal', [])
    store.markUnread('term-1')
    expect(store.unreadMap['term-1']).toBe(true)

    // 多宿主槽位并存：任一宿主可见即不算后台
    store.setHostVisible('bottomTerminal', [])
    store.setHostVisible('agentManager', ['term-1'])
    store.markUnread('term-1')
    expect(store.unreadMap['term-1']).toBeUndefined()
  })

  it('applySnapshot 清理未读点与可见登记中的死会话', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([{ id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1' }])
    store.markUnread('term-1')
    store.setHostVisible('bottomTerminal', ['term-1'])

    // term-1 消亡：未读点与可见登记随快照清理
    store.applySnapshot([])
    expect(store.unreadMap['term-1']).toBeUndefined()
    expect(store.visibleSlots['bottomTerminal']).toEqual([])
  })

  // 定向消息未读点（P-20261004-68）：clearUnread 按服务端已读事实熄灭单会话，
  // 与宿主可见清除路径（setHostVisible）并存互不覆盖；未亮早退无新状态
  it('clearUnread：定向消息已读熄灭单会话，不影响其他会话', () => {
    const store = useTerminalSessionsStore()
    store.markUnread('term-1')
    store.markUnread('term-2')

    store.clearUnread('term-1')
    expect(store.unreadMap['term-1']).toBeUndefined()
    expect(store.unreadMap['term-2']).toBe(true)

    // 未亮早退：clearUnread 不产生空状态写入
    store.clearUnread('term-1')
    expect(store.unreadMap['term-2']).toBe(true)

    // 已读后同会话再次到达消息仍可重新点亮（一次性布尔随事件重建）
    store.markUnread('term-1')
    expect(store.unreadMap['term-1']).toBe(true)
  })

  // ============== 会话数量软阈值提示（P-20261003-183，非阻断） ==============
  // 断言面 = 全局 setup 对 createDiscreteApi 的 mock：resetForTest 复位懒创建
  // 单例后，每个用例首次提示都会重新调用，从 mock.results[0] 取 warning 调用
  const discreteMock = vi.mocked(createDiscreteApi)
  function warningToasts(): unknown[] {
    return discreteMock.mock.results.flatMap((r) => {
      const msg = (r.value as { message?: { warning?: Mock } }).message
      return msg?.warning?.mock.calls.map(c => c[0]) ?? []
    })
  }
  /** 造 n 个会话快照（agent + shell 各半，id 唯一） */
  function manySessions(n: number): { id: string; name: string; kind: string; projectId: string }[] {
    return Array.from({ length: n }, (_, i) => i % 2 === 0
      ? { id: `agent-${i}`, name: `A${i}`, kind: 'agent', projectId: '' }
      : { id: `term-${i}`, name: `T${i}`, kind: 'shell', projectId: 'p1' })
  }

  it('创建越过软阈值轻提示一次：21 → toast，持续创建不刷屏（episode 门控）', async () => {
    const store = useTerminalSessionsStore()
    mockedApi.createAgent.mockReturnValue(apiRes({ id: 'agent-21', name: 'A21', kind: 'agent', totalSessions: 21 }))
    expect(await store.createAgent()).not.toBeNull()
    expect(warningToasts()).toEqual(['会话较多（21 个），注意资源'])

    // 已在超阈时段内：继续创建不重复弹
    mockedApi.createAgent.mockReturnValue(apiRes({ id: 'agent-22', name: 'A22', kind: 'agent', totalSessions: 22 }))
    expect(await store.createAgent()).not.toBeNull()
    expect(warningToasts()).toHaveLength(1)
  })

  it('阈值内创建不提示；旧服务端无 totalSessions 回退本地列表长度', async () => {
    const store = useTerminalSessionsStore()
    // 阈值内：安静
    mockedApi.createAgent.mockReturnValue(apiRes({ id: 'agent-1', name: 'A', kind: 'agent', totalSessions: 3 }))
    expect(await store.createAgent()).not.toBeNull()
    expect(warningToasts()).toHaveLength(0)

    // 升级兼容：响应无 totalSessions（旧服务端）→ 回退本地对账后的列表长度
    store.resetForTest()
    store.applySnapshot(manySessions(20))
    mockedApi.createAgent.mockReturnValue(apiRes({ id: 'agent-new', name: 'N', kind: 'agent' }))
    expect(await store.createAgent()).not.toBeNull()
    expect(warningToasts()).toEqual(['会话较多（21 个），注意资源'])
  })

  it('落回阈值以内复位 episode：再次越阈重新提示', async () => {
    const store = useTerminalSessionsStore()
    mockedApi.createAgent.mockReturnValue(apiRes({ id: 'agent-21', name: 'A21', kind: 'agent', totalSessions: 21 }))
    await store.createAgent()
    expect(warningToasts()).toHaveLength(1)

    // 快照落回 5 个（≤20）→ episode 复位；再越阈（22）→ 重新提示
    store.applySnapshot(manySessions(5))
    mockedApi.createAgent.mockReturnValue(apiRes({ id: 'agent-22', name: 'A22', kind: 'agent', totalSessions: 22 }))
    await store.createAgent()
    expect(warningToasts()).toHaveLength(2)
  })

  it('启动首拉大量会话不提示（提示只跟创建动作走，不对存量弹）', async () => {
    mockedApi.list.mockReturnValue(apiRes(manySessions(25)))
    expect(await useTerminalSessionsStore().refresh()).toBe(true)
    expect(warningToasts()).toHaveLength(0)
  })

  it('观察路径：已加载后快照冒出新 id 且超阈 → 提示一次（直调 API/他方创建）', async () => {
    const store = useTerminalSessionsStore()
    mockedApi.list.mockReturnValue(apiRes(manySessions(20)))
    await store.refresh() // 首拉 20：不提示，置 loaded

    // 快照冒出新 id（绕过 store action 的创建：底部面板直调 API / 别的标签页）
    store.applySnapshot([...manySessions(20), { id: 'agent-other', name: 'X', kind: 'agent', projectId: '' }])
    expect(warningToasts()).toEqual(['会话较多（21 个），注意资源'])

    // 已提示过：后续快照（无新 id，仅重命名）不重复弹
    store.applySnapshot([...manySessions(20), { id: 'agent-other', name: 'X2', kind: 'agent', projectId: '' }])
    expect(warningToasts()).toHaveLength(1)
  })

  // ============== 会话 cwd 实时追踪（P-20261004-59） ==============
  it('reportCurrentDir 写入会话 currentDir；sessionWorkingDir 无帧回落创建 dir', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'agent-a', name: 'A', kind: 'agent', path: 'D:\\proj' },
      { id: 'agent-b', name: 'B', kind: 'agent', path: '/home/u/proj' },
    ])
    expect(store.sessions.find(s => s.id === 'agent-a')!.currentDir).toBeUndefined()

    // OSC 7 写路径上报（cd 后的 prompt）：直写实时值
    store.reportCurrentDir('agent-a', 'D:\\proj\\sub')
    expect(store.sessions.find(s => s.id === 'agent-a')!.currentDir).toBe('D:\\proj\\sub')

    // 消费口统一收口：有实时值用实时值，无帧回落创建 dir（旧 shell 零回归）
    expect(sessionWorkingDir(store.sessions.find(s => s.id === 'agent-a')!)).toBe('D:\\proj\\sub')
    expect(sessionWorkingDir(store.sessions.find(s => s.id === 'agent-b')!)).toBe('/home/u/proj')
  })

  it('applySnapshot 对账 currentDir：服务端值优先，快照缺字段保留本连接实时值', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([{ id: 'agent-a', name: 'A', kind: 'agent', path: '/p' }])
    // 快路径先行：本连接 OSC 7 解析已上报
    store.reportCurrentDir('agent-a', '/p/sub')

    // 旧服务端快照（无 currentDir 字段）不冲掉实时值
    store.applySnapshot([{ id: 'agent-a', name: 'A2', kind: 'agent', path: '/p' }])
    expect(store.sessions[0]!.currentDir).toBe('/p/sub')

    // 新服务端快照携带（跨标签页/恢复场景慢路对账）：以快照为准
    store.applySnapshot([{ id: 'agent-a', name: 'A3', kind: 'agent', path: '/p', currentDir: '/p/other' }])
    expect(store.sessions[0]!.currentDir).toBe('/p/other')
  })
})

// ============== 会话 tab 置顶（P-20261004-53） ==============
describe('terminal-sessions pin', () => {
  it('togglePin 翻转置顶集并落 safeStorage；isPinned 读数；空 id 守卫', () => {
    const store = useTerminalSessionsStore()
    expect(store.isPinned('t1')).toBe(false)
    store.togglePin('t1')
    expect(store.isPinned('t1')).toBe(true)
    expect(JSON.parse(localStorage.getItem('sc.terminalSessions.pinnedIds') || '[]')).toEqual(['t1'])

    store.togglePin('t1')
    expect(store.isPinned('t1')).toBe(false)
    expect(JSON.parse(localStorage.getItem('sc.terminalSessions.pinnedIds') || '[]')).toEqual([])

    // 空 id 不入集（右键菜单对已消亡 tab 的竞态兜底）
    store.togglePin('')
    expect(store.pinnedIds.size).toBe(0)
  })

  it('applySnapshot 剪枝已消亡会话的置顶 id（他端关闭随快照同汰，防集合无界）', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 't1', name: 'T1', kind: 'shell', projectId: 'p1' },
      { id: 't2', name: 'T2', kind: 'shell', projectId: 'p1' },
    ])
    store.togglePin('t1')
    store.togglePin('t2')

    store.applySnapshot([{ id: 't1', name: 'T1', kind: 'shell', projectId: 'p1' }])
    expect(store.isPinned('t1')).toBe(true)
    expect(store.isPinned('t2')).toBe(false)
  })

  it('markExited（shell 自行退出）同步剪枝置顶 id', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([{ id: 't1', name: 'T1', kind: 'shell', projectId: 'p1' }])
    store.togglePin('t1')
    expect(store.isPinned('t1')).toBe(true)

    store.markExited('t1')
    expect(store.isPinned('t1')).toBe(false)
  })

  it('resetForTest 清空置顶集（用例隔离，不写 localStorage）', () => {
    const store = useTerminalSessionsStore()
    store.togglePin('t1')
    store.resetForTest()
    expect(store.pinnedIds.size).toBe(0)
  })
})

// ============== runtime 筛选选中集（P-20261004-84） ==============
describe('terminal-sessions runtime filter', () => {
  it('toggleRuntimeFilter 翻转多选集并落 safeStorage；clearRuntimeFilter 恢复不过滤', () => {
    const store = useTerminalSessionsStore()
    expect(store.runtimeFilter.size).toBe(0)

    store.toggleRuntimeFilter('shell')
    store.toggleRuntimeFilter('claude')
    expect([...store.runtimeFilter].sort()).toEqual(['claude', 'shell'])
    expect(JSON.parse(localStorage.getItem('sc.terminalSessions.runtimeFilter') || '[]').sort())
      .toEqual(['claude', 'shell'])

    // 再点已选芯片 = 取消（多选 toggle）
    store.toggleRuntimeFilter('shell')
    expect([...store.runtimeFilter]).toEqual(['claude'])

    store.clearRuntimeFilter()
    expect(store.runtimeFilter.size).toBe(0)
    expect(JSON.parse(localStorage.getItem('sc.terminalSessions.runtimeFilter') || '[]')).toEqual([])
  })

  it('空键 toggle 是 no-op（竞态兜底同置顶集口径）', () => {
    const store = useTerminalSessionsStore()
    store.toggleRuntimeFilter('')
    expect(store.runtimeFilter.size).toBe(0)
  })

  it('applySnapshot 剪枝绝迹 runtime 的选中键（芯片消失后选中态残留 = 无处退出的死胡同）', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'a', name: 'A', kind: 'agent', runtime: 'claude' },
      { id: 'b', name: 'B', kind: 'agent', runtime: 'shell' },
    ])
    store.toggleRuntimeFilter('claude')
    store.toggleRuntimeFilter('shell')

    // claude 会话全部消亡（他端关闭经快照对账）→ claude 键摘除、shell 保留
    store.applySnapshot([{ id: 'b', name: 'B', kind: 'agent', runtime: 'shell' }])
    expect(store.runtimeFilter.has('claude')).toBe(false)
    expect(store.runtimeFilter.has('shell')).toBe(true)

    // 空 runtime 归 shell 口径：项目会话（无 runtime 字段）保住 shell 选中键
    store.clearRuntimeFilter()
    store.toggleRuntimeFilter('shell')
    expect(store.runtimeFilter.has('shell')).toBe(true)
    store.applySnapshot([{ id: 'p2', name: 'P2', kind: 'shell', projectId: 'p1' }])
    expect(store.runtimeFilter.has('shell')).toBe(true)
  })

  it('removeLocal（会话自行消亡）同步剪枝；全部绝迹时选中集清空', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([{ id: 'a', name: 'A', kind: 'agent', runtime: 'codex' }])
    store.toggleRuntimeFilter('codex')
    expect(store.runtimeFilter.size).toBe(1)

    store.markExited('a')
    expect(store.runtimeFilter.size).toBe(0)
  })

  it('载入容错：脏数据（非数组/非字符串元素）回落不过滤，合法数组恢复选中', async () => {
    // loadRuntimeFilter 只在 store 首建时执行：换新 pinia 触发重新载入
    const { createPinia, setActivePinia } = await import('pinia')
    localStorage.setItem('sc.terminalSessions.runtimeFilter', '{"x":1}')
    setActivePinia(createPinia())
    expect(useTerminalSessionsStore().runtimeFilter.size).toBe(0)

    localStorage.setItem('sc.terminalSessions.runtimeFilter', '[1,null]')
    setActivePinia(createPinia())
    expect(useTerminalSessionsStore().runtimeFilter.size).toBe(0)

    localStorage.setItem('sc.terminalSessions.runtimeFilter', '["codex"]')
    setActivePinia(createPinia())
    expect([...useTerminalSessionsStore().runtimeFilter]).toEqual(['codex'])
    localStorage.removeItem('sc.terminalSessions.runtimeFilter')
  })

  it('resetForTest 清空选中集（用例隔离，不写 localStorage）', () => {
    const store = useTerminalSessionsStore()
    store.toggleRuntimeFilter('dsh')
    store.resetForTest()
    expect(store.runtimeFilter.size).toBe(0)
  })
})

// ============== 失败命令记录清账（P-20261006-37） ==============
// lastFailed 是 terminalCommandMarks 的模块级 Map（无公开写入口）：经
// markCommandOutcome 灌入需要最简 xterm 桩——失败记账发生在装饰锚定之前
// （start=0 无锚行时 registerMarker 不被触达），buffer 桩即可
function seedFailedRecord(sessionId: string): void {
  termInstances.set(sessionId, {
    term: {
      buffer: { active: { length: 1, baseY: 0, cursorY: 0, getLine: () => undefined } },
      registerMarker: () => undefined,
      registerDecoration: () => undefined,
    },
  } as never)
  markCommandOutcome(sessionId, 7, 'boom', { startLine: 0, endLine: 0 })
}

describe('terminal-sessions 失败命令记录清账（P-20261006-37 会话真死收口）', () => {
  beforeEach(() => {
    termInstances.delete('term-fail')
    termInstances.delete('term-keep')
    termInstances.delete('term-dead')
  })

  it('destroy（用户关 tab）同步清失败记录', async () => {
    mockedApi.close.mockResolvedValue({} as any)
    const store = useTerminalSessionsStore()
    store.applySnapshot([{ id: 'term-fail', name: 'T', kind: 'shell', projectId: 'p1', path: '/x' }])
    seedFailedRecord('term-fail')
    expect(getFailedCommandRecord('term-fail')).toBeDefined()
    await store.destroy('term-fail')
    expect(getFailedCommandRecord('term-fail')).toBeUndefined()
  })

  it('applySnapshot 快照对账剪枝：消失会话的失败记录清、存活保留（他端关闭/服务端重启同清）', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'term-keep', name: 'K', kind: 'shell', projectId: 'p1', path: '/x' },
      { id: 'term-dead', name: 'D', kind: 'shell', projectId: 'p1', path: '/y' },
    ])
    seedFailedRecord('term-keep')
    seedFailedRecord('term-dead')
    store.applySnapshot([{ id: 'term-keep', name: 'K', kind: 'shell', projectId: 'p1', path: '/x' }])
    expect(getFailedCommandRecord('term-dead')).toBeUndefined()
    expect(getFailedCommandRecord('term-keep')).toBeDefined()
  })
})
