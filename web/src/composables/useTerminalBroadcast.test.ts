import { beforeEach, describe, expect, it, vi } from 'vitest'

// 终端域 API 全量 mock：composable 只依赖 broadcastWrite 与 list（广播模式
// 进入时的会话列表补拉）；远程域 mock 覆盖聚合列远程会话（P-20261005-11）
vi.mock('../api/domains/terminal', () => ({
  terminalApi: {
    broadcastWrite: vi.fn(),
    list: vi.fn(),
  },
}))
vi.mock('../api/domains/remote', () => ({
  remoteHostApi: {
    listAllTerminals: vi.fn(),
  },
}))

import { terminalApi } from '../api/domains/terminal'
import { remoteHostApi } from '../api/domains/remote'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { BROADCAST_INPUT_HISTORY_MAX, useTerminalBroadcast } from './useTerminalBroadcast'
import { nextTick, ref } from 'vue'

const mockedApi = vi.mocked(terminalApi, true)
const mockedRemoteApi = vi.mocked(remoteHostApi, true)

/** 统一包一层响应形态：axios 拦截器返回 gin body，业务负载在 res.data（真实形态） */
function apiRes<T>(data: T) {
  return Promise.resolve({ data }) as any
}

beforeEach(() => {
  vi.resetAllMocks()
  // 远程候选默认空表（历史用例不涉及远程组；远程组用例自行覆写）
  mockedRemoteApi.listAllTerminals.mockReturnValue(apiRes([]))
  useTerminalSessionsStore().resetForTest()
})

describe('useTerminalBroadcast 舰队式批量输入', () => {
  it('tab 点选切换选中集，targetIds 集成 tab + 显式勾选的 agent', () => {
    const tabs = ref([
      { id: 't-1', name: 'T1', projectId: 'p1' },
      { id: 't-2', name: 'T2', projectId: 'p1' },
    ])
    const bc = useTerminalBroadcast({ tabs })

    expect(bc.targetIds.value).toEqual([])
    bc.toggleTab('t-1')
    bc.toggleTab('t-2')
    expect([...bc.targetIds.value]).toEqual(['t-1', 't-2'])
    // 再点一次 = 取消
    bc.toggleTab('t-1')
    expect([...bc.targetIds.value]).toEqual(['t-2'])

    // agent 会话：显式勾选才进目标（默认不参与广播）
    bc.toggleAgent('agent-a')
    expect([...bc.targetIds.value]).toEqual(['t-2', 'agent-a'])
  })

  it('send 尾部无换行自动补 \\r（执行语义），有换行则原样透传', async () => {
    mockedApi.broadcastWrite.mockReturnValue(apiRes({ written: 2, missing: [], failed: [] }))
    const tabs = ref([
      { id: 't-1', name: 'T1', projectId: 'p1' },
      { id: 't-2', name: 'T2', projectId: 'p1' },
    ])
    const bc = useTerminalBroadcast({ tabs })
    bc.toggleTab('t-1')
    bc.toggleTab('t-2')

    const out = await bc.send('git status')
    expect(mockedApi.broadcastWrite).toHaveBeenCalledWith(['t-1', 't-2'], 'git status\r')
    expect(out).toEqual({ written: 2, missing: 0, failed: 0, failedHostNames: [] })

    // 已带尾部换行：不重复补
    await bc.send('git status\n')
    expect(mockedApi.broadcastWrite).toHaveBeenLastCalledWith(['t-1', 't-2'], 'git status\n')
  })

  it('send 回告逐类计数（missing/failed 来自服务端数组长度）', async () => {
    mockedApi.broadcastWrite.mockReturnValue(apiRes({ written: 1, missing: ['ghost'], failed: ['t-dead'] }))
    const tabs = ref([{ id: 't-1', name: 'T1', projectId: 'p1' }])
    const bc = useTerminalBroadcast({ tabs })
    bc.toggleTab('t-1')
    bc.toggleAgent('agent-a')

    const out = await bc.send('x')
    expect(out).toEqual({ written: 1, missing: 1, failed: 1, failedHostNames: [] })
  })

  it('发送成功落 lastResult 并自动展开结果面板；resultTargets 映射名称与失败态', async () => {
    mockedApi.broadcastWrite.mockReturnValue(apiRes({ written: 2, missing: ['ghost'], failed: [] }))
    const tabs = ref([
      { id: 't-1', name: 'Shell-1', projectId: 'p1' },
      { id: 't-2', name: 'Shell-2', projectId: 'p1' },
    ])
    const bc = useTerminalBroadcast({ tabs })
    const store = useTerminalSessionsStore()
    // agent 会话经统一 store 解析名称（store 里没有 ghost——它发送时已消失）
    mockedApi.list.mockReturnValue(apiRes([{ id: 'agent-a', name: 'Agent A', kind: 'agent' }]))
    await store.refresh()

    bc.toggleTab('t-1')
    bc.toggleTab('t-2')
    bc.toggleAgent('agent-a')
    bc.toggleAgent('ghost')

    expect(bc.showResultPanel.value).toBe(false)
    expect(bc.lastResult.value).toBeNull()
    const out = await bc.send('git status')
    expect(out).toEqual({ written: 2, missing: 1, failed: 0, failedHostNames: [] })

    // 回告快照完整落面板数据源；面板自动展开一次（可关）
    expect(bc.showResultPanel.value).toBe(true)
    expect(bc.lastResult.value).toEqual({
      targetIds: ['t-1', 't-2', 'agent-a', 'ghost'],
      written: 2,
      missing: ['ghost'],
      failed: [],
    })
    const tg = bc.resultTargets.value
    expect(tg.map(x => [x.id, x.name, x.state])).toEqual([
      ['t-1', 'Shell-1', 'ok'],
      ['t-2', 'Shell-2', 'ok'],
      ['agent-a', 'Agent A', 'ok'],
      ['ghost', `#${'ghost'.slice(0, 8)}`, 'missing'], // 已消失会话回退 id 短标，不虚构名字
    ])

    // 手动关闭不回弹（自动展开是一次性语义，重开走「查看结果」入口）
    bc.showResultPanel.value = false
    expect(bc.showResultPanel.value).toBe(false)
  })

  it('failed 回告映射灰态；发送抛错（网络/校验）不落面板不展开', async () => {
    mockedApi.broadcastWrite.mockReturnValueOnce(apiRes({ written: 0, missing: [], failed: ['t-1'] }))
    mockedApi.broadcastWrite.mockRejectedValueOnce(new Error('network down'))
    const tabs = ref([{ id: 't-1', name: 'T1', projectId: 'p1' }])
    const bc = useTerminalBroadcast({ tabs })
    bc.toggleTab('t-1')

    await bc.send('x')
    expect(bc.resultTargets.value.map(x => x.state)).toEqual(['failed'])

    // 手动关闭后再发送一次（模拟网络失败）：无新回告可看——上次快照不覆盖、面板不展开
    bc.showResultPanel.value = false
    await expect(bc.send('y')).rejects.toThrow('network down')
    expect(bc.lastResult.value?.failed).toEqual(['t-1'])
    expect(bc.showResultPanel.value).toBe(false)
  })

  it('会话关闭后选中集存活对账出清（tabs 与 store 双源）', async () => {
    // 服务端返回空表 = agent 会话均已消亡
    mockedApi.list.mockReturnValue(apiRes([]))
    const tabs = ref([{ id: 't-1', name: 'T1', projectId: 'p1' }])
    const store = useTerminalSessionsStore()
    const bc = useTerminalBroadcast({ tabs })

    bc.toggleTab('t-1')
    bc.toggleAgent('agent-a')
    expect(bc.targetIds.value).toHaveLength(2)

    // tab 关闭（tabs 移除 t-1）+ 服务端列表对账（agent-a 消亡）；对账 watch 为
    // pre flush，断言前先让出微任务队列令 watcher 跑完
    tabs.value = []
    await store.refresh()
    await nextTick()
    expect(bc.targetIds.value).toHaveLength(0)
  })

  it('退出广播模式清空全部选择；进入时对未加载的会话列表补拉一次', async () => {
    mockedApi.list.mockReturnValue(apiRes([{ id: 'agent-a', name: 'A', kind: 'agent' }]))
    const tabs = ref([{ id: 't-1', name: 'T1', projectId: 'p1' }])
    const bc = useTerminalBroadcast({ tabs })
    const store = useTerminalSessionsStore()

    bc.toggleTab('t-1')
    bc.broadcastMode.value = true
    await vi.waitFor(() => expect(mockedApi.list).toHaveBeenCalledTimes(1))
    expect(store.loaded).toBe(true)

    bc.exitBroadcastMode()
    expect(bc.broadcastMode.value).toBe(false)
    expect(bc.targetIds.value).toHaveLength(0)
  })

  // ============== 远程主机终端（P-20261005-11） ==============

  it('远程候选进广播模式时聚合拉取，显式勾选并入 targetIds（本地/远程混合一次发）', async () => {
    mockedRemoteApi.listAllTerminals.mockReturnValue(apiRes([
      { id: 'aabbccdd11223344556677889900aabb', hostId: 'sc_rh_1', host: '舰队-A', createdAt: '' },
      { id: 'ffee00dd11223344556677889900aabb', hostId: 'sc_rh_2', host: '舰队-B', createdAt: '' },
    ]))
    const tabs = ref([{ id: 't-1', name: 'T1', projectId: 'p1' }])
    const bc = useTerminalBroadcast({ tabs })

    bc.broadcastMode.value = true
    await vi.waitFor(() => expect(mockedRemoteApi.listAllTerminals).toHaveBeenCalledTimes(1))
    expect(bc.remoteCandidates.value).toHaveLength(2)

    // 默认不参与：勾选才进目标（与 agent 会话同语义）
    expect(bc.targetIds.value).toEqual([])
    bc.toggleTab('t-1')
    bc.toggleRemote('aabbccdd11223344556677889900aabb')
    expect([...bc.targetIds.value]).toEqual(['t-1', 'aabbccdd11223344556677889900aabb'])
  })

  it('send 回告 failedHosts 映射为主机别名列（哪台失败一目了然）；旧服务端缺字段降级空', async () => {
    mockedApi.broadcastWrite.mockReturnValue(apiRes({
      written: 1, missing: [], failed: ['aabbccdd11223344556677889900aabb'],
      failedHosts: [{ id: 'aabbccdd11223344556677889900aabb', hostId: 'sc_rh_1', host: '舰队-A' }],
    }))
    const tabs = ref([{ id: 't-1', name: 'T1', projectId: 'p1' }])
    const bc = useTerminalBroadcast({ tabs })
    bc.toggleTab('t-1')
    bc.toggleRemote('aabbccdd11223344556677889900aabb')

    const out = await bc.send('uptime')
    expect(mockedApi.broadcastWrite).toHaveBeenCalledWith(
      ['t-1', 'aabbccdd11223344556677889900aabb'], 'uptime\r')
    expect(out.failedHostNames).toEqual(['舰队-A'])
  })

  it('候选刷新即对账：已勾选但已消亡的远程会话出清；聚合拉取失败降级空候选不抛错', async () => {
    // 第一次拉到两个候选，重新进入广播模式时一个已消亡
    mockedRemoteApi.listAllTerminals
      .mockReturnValueOnce(apiRes([
        { id: 'alive-1', hostId: 'h1', host: 'A', createdAt: '' },
        { id: 'dying-1', hostId: 'h1', host: 'A', createdAt: '' },
      ]))
      .mockReturnValueOnce(apiRes([{ id: 'alive-1', hostId: 'h1', host: 'A', createdAt: '' }]))
    const tabs = ref([])
    const bc = useTerminalBroadcast({ tabs })

    bc.broadcastMode.value = true
    await vi.waitFor(() => expect(bc.remoteCandidates.value).toHaveLength(2))
    bc.toggleRemote('dying-1')
    expect(bc.targetIds.value).toEqual(['dying-1'])

    // 退出再进（触发重新拉取）：dying-1 已不在候选，勾选出清。
    // exit 与重进之间让出一帧——同一 tick 内 false→true 会被 watcher 批处理
    // 成「无变化」（用户操作天然跨帧，这里按真实节奏让出）
    bc.exitBroadcastMode()
    await nextTick()
    bc.broadcastMode.value = true
    await vi.waitFor(() => expect(bc.remoteCandidates.value).toHaveLength(1))
    expect(bc.targetIds.value).toEqual([])

    // 拉取失败降级空候选（分组隐藏），不向上抛
    mockedRemoteApi.listAllTerminals.mockRejectedValueOnce(new Error('net down'))
    bc.exitBroadcastMode()
    await nextTick()
    bc.broadcastMode.value = true
    await vi.waitFor(() => expect(mockedRemoteApi.listAllTerminals).toHaveBeenCalledTimes(3))
    expect(bc.remoteCandidates.value).toEqual([])
  })

  // ============== 输入历史（P-20261005-13） ==============

  it('发送成功入史去重置顶；失败不入史（与输入框保留原文重试同门槛）', async () => {
    mockedApi.broadcastWrite.mockReturnValue(apiRes({ written: 2, missing: [], failed: [] }))
    const tabs = ref([
      { id: 't-1', name: 'T1', projectId: 'p1' },
      { id: 't-2', name: 'T2', projectId: 'p1' },
    ])
    const bc = useTerminalBroadcast({ tabs })
    bc.toggleTab('t-1')
    bc.toggleTab('t-2')

    expect(bc.inputHistory.value).toEqual([])
    await bc.send('echo one')
    await bc.send('echo two')
    expect(bc.inputHistory.value).toEqual(['echo two', 'echo one'])

    // 重发已有命令：去重置顶而非重复入账
    await bc.send('echo one')
    expect(bc.inputHistory.value).toEqual(['echo one', 'echo two'])

    // 发送失败（网络）：不入史——输入框原文保留待重试，两处同门槛不错位
    mockedApi.broadcastWrite.mockRejectedValueOnce(new Error('network down'))
    await expect(bc.send('echo boom')).rejects.toThrow('network down')
    expect(bc.inputHistory.value).toEqual(['echo one', 'echo two'])
  })

  it('入史 trim 空串跳过；环形封顶裁最旧（上限 20）', async () => {
    mockedApi.broadcastWrite.mockReturnValue(apiRes({ written: 1, missing: [], failed: [] }))
    const tabs = ref([{ id: 't-1', name: 'T1', projectId: 'p1' }])
    const bc = useTerminalBroadcast({ tabs })
    bc.toggleTab('t-1')

    // 纯空白不占史位（组件 canSend 已挡，这里守 composable 自身口径）
    await bc.send('   ')
    expect(bc.inputHistory.value).toEqual([])

    for (let i = 0; i < BROADCAST_INPUT_HISTORY_MAX + 2; i++) {
      await bc.send(`cmd-${i}`)
    }
    expect(bc.inputHistory.value).toHaveLength(BROADCAST_INPUT_HISTORY_MAX)
    // 最新在顶，最旧两条（cmd-0/cmd-1）被环形裁掉
    expect(bc.inputHistory.value[0]).toBe(`cmd-${BROADCAST_INPUT_HISTORY_MAX + 1}`)
    expect(bc.inputHistory.value).not.toContain('cmd-0')
  })
})
