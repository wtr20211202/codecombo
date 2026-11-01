import { mount, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'

// 系统域 API 全量 mock：composable 依赖 fleetRun / fleetAbort / fleetRetry；
// 远程域 mock 覆盖候选聚合拉取（广播同款三组候选语义）
vi.mock('../api/domains/system', () => ({
  runbookApi: {
    fleetRun: vi.fn(),
    fleetAbort: vi.fn(),
    fleetRetry: vi.fn(),
  },
}))
vi.mock('../api/domains/remote', () => ({
  remoteHostApi: {
    listAllTerminals: vi.fn(),
  },
}))

import { runbookApi, type FleetRunResult } from '../api/domains/system'
import { remoteHostApi } from '../api/domains/remote'
import { OPS_TASK_PROGRESS } from '../utils/opsEvents'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useRunbookFleet, type FleetProgressPayload } from './useRunbookFleet'
import type { TermTab } from './useTerminalTabs'

const mockedApi = vi.mocked(runbookApi, true)
const mockedRemoteApi = vi.mocked(remoteHostApi, true)

function apiRes<T>(data: T) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios 拦截器 unwrap 形态在类型外（useTerminalBroadcast.test 同款）
  return Promise.resolve({ data }) as any
}

/** 宿主组件：setup 内挂 window 监听（onMounted 需组件实例），返回 composable */
function mountHost(tabs: TermTab[] = []): { wrapper: VueWrapper; fleet: ReturnType<typeof useRunbookFleet> } {
  let instance: ReturnType<typeof useRunbookFleet>
  const tabsRef = ref(tabs)
  const Host = defineComponent({
    setup() {
      instance = useRunbookFleet({ tabs: tabsRef })
      return () => h('div')
    },
  })
  const wrapper = mount(Host)
  return { wrapper, fleet: instance! }
}

function dispatchProgress(payload: FleetProgressPayload): void {
  window.dispatchEvent(new CustomEvent(OPS_TASK_PROGRESS, { detail: payload }))
}

function snapshot(overrides: Partial<FleetRunResult> = {}): FleetRunResult {
  return {
    runId: 'frb_1',
    bookId: 'bk1',
    title: '部署三连',
    targetIds: ['t-a', 't-b'],
    onFailure: 'stop',
    status: 'completed',
    steps: [
      { index: 0, command: 'echo one', status: 'done', targets: [
        { id: 't-a', status: 'done', exitCode: 0 },
        { id: 't-b', status: 'done', exitCode: 0 },
      ] },
      { index: 1, command: 'echo two', status: 'done', targets: [
        { id: 't-a', status: 'done', exitCode: 0 },
        { id: 't-b', status: 'done', exitCode: 0 },
      ] },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  mockedRemoteApi.listAllTerminals.mockReturnValue(apiRes([]))
  useTerminalSessionsStore().resetForTest()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useRunbookFleet 目标候选与选择', () => {
  it('toggleTarget 勾选/取消，targetName 按 tabs→store→远程别名→id 短标解析', async () => {
    const store = useTerminalSessionsStore()
    store.resetForTest()
    mockedRemoteApi.listAllTerminals.mockReturnValue(apiRes([
      { id: 'remote-1', hostId: 'h1', host: '生产机', createdAt: 't' },
    ]))
    const { wrapper, fleet } = mountHost([{ id: 't-a', name: 'shell 一号' } as TermTab])
    await fleet.refreshCandidates()
    await Promise.resolve()

    fleet.toggleTarget('t-a')
    fleet.toggleTarget('agent-1')
    expect([...fleet.selectedIds.value]).toEqual(['t-a', 'agent-1'])
    fleet.toggleTarget('t-a')
    expect([...fleet.selectedIds.value]).toEqual(['agent-1'])

    expect(fleet.targetName('t-a')).toBe('shell 一号')
    expect(fleet.targetName('remote-1')).toBe('生产机')
    expect(fleet.targetName('ghost-1234567890')).toBe('#ghost-12')
    wrapper.unmount()
  })

  it('存活对账：tabs/统一 store/远程候选里消失的会话即时出清选中集', async () => {
    const store = useTerminalSessionsStore()
    store.resetForTest()
    mockedRemoteApi.listAllTerminals.mockReturnValue(apiRes([
      { id: 'remote-1', hostId: 'h1', host: '生产机', createdAt: 't' },
    ]))
    const { wrapper, fleet } = mountHost([{ id: 't-a', name: 'a' } as TermTab])
    await fleet.refreshCandidates()
    await Promise.resolve()

    fleet.toggleTarget('t-a')
    fleet.toggleTarget('remote-1')
    expect(fleet.selectedIds.value.size).toBe(2)
    // 远程候选消失（断连回收）→ 选中集出清
    mockedRemoteApi.listAllTerminals.mockReturnValue(apiRes([]))
    await fleet.refreshCandidates()
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect([...fleet.selectedIds.value]).toEqual(['t-a'])
    wrapper.unmount()
  })
})

describe('useRunbookFleet 发车与快照采纳', () => {
  it('launch 成功：响应快照整体落矩阵（status/steps/targetIds）', async () => {
    mockedApi.fleetRun.mockReturnValue(apiRes(snapshot()))
    const { wrapper, fleet } = mountHost()
    const ok = await fleet.launch({ bookId: 'bk1', title: '部署三连', targetIds: ['t-a', 't-b'], onFailure: 'stop' })
    expect(ok).toBe(true)
    expect(mockedApi.fleetRun).toHaveBeenCalledWith('bk1', expect.objectContaining({ targetIds: ['t-a', 't-b'] }))
    expect(fleet.run.value?.runId).toBe('frb_1')
    expect(fleet.run.value?.status).toBe('completed')
    expect(fleet.run.value?.cells[0]!['t-a']?.status).toBe('done')
    wrapper.unmount()
  })

  it('launch 网络级失败（60s 响应墙断连）：占位矩阵保留 + connectionLost 如实标注', async () => {
    mockedApi.fleetRun.mockRejectedValue(new TypeError('network down'))
    const { wrapper, fleet } = mountHost()
    const ok = await fleet.launch({ bookId: 'bk1', title: 'x', targetIds: ['t-a'], onFailure: 'stop' })
    expect(ok).toBe(false)
    expect(fleet.connectionLost.value).toBe(true)
    // 占位视图仍在（事件继续合并的落点）
    expect(fleet.run.value?.bookId).toBe('bk1')
    expect(fleet.run.value?.status).toBe('running')
    wrapper.unmount()
  })

  it('launch 4xx（校验失败有响应）：清占位不误导，交宿主错误链', async () => {
    mockedApi.fleetRun.mockRejectedValue(Object.assign(new Error('bad'), { response: { status: 400 } }))
    const { wrapper, fleet } = mountHost()
    await fleet.launch({ bookId: 'bk1', title: 'x', targetIds: ['t-a'], onFailure: 'stop' })
    expect(fleet.connectionLost.value).toBe(false)
    expect(fleet.run.value).toBe(null)
    wrapper.unmount()
  })

  it('abort / retryCell：服务端快照整体替换（事实源）', async () => {
    mockedApi.fleetRun.mockReturnValue(apiRes(snapshot({ status: 'failed', steps: [
      { index: 0, command: 's1', status: 'failed', targets: [
        { id: 't-a', status: 'done', exitCode: 0 },
        { id: 't-b', status: 'failed', exitCode: 7 },
      ] },
    ] })))
    mockedApi.fleetAbort.mockReturnValue(apiRes(snapshot({ status: 'aborted' })))
    mockedApi.fleetRetry.mockReturnValue(apiRes(snapshot()))
    const { wrapper, fleet } = mountHost()
    await fleet.launch({ bookId: 'bk1', title: 'x', targetIds: ['t-a', 't-b'], onFailure: 'stop' })

    await fleet.abort()
    expect(mockedApi.fleetAbort).toHaveBeenCalledWith('bk1', 'frb_1', { silent: true })
    expect(fleet.run.value?.status).toBe('aborted')

    await fleet.retryCell('bk1', 0, 't-b')
    expect(mockedApi.fleetRetry).toHaveBeenCalledWith('bk1', 'frb_1', 0, 't-b', { silent: true })
    expect(fleet.run.value?.status).toBe('completed')
    wrapper.unmount()
  })

  it('retryCell 运行中拒发（矩阵在变化）', async () => {
    mockedApi.fleetRun.mockReturnValue(apiRes(snapshot({ status: 'running' })))
    const { wrapper, fleet } = mountHost()
    await fleet.launch({ bookId: 'bk1', title: 'x', targetIds: ['t-a'], onFailure: 'stop' })
    await fleet.retryCell('bk1', 0, 't-a')
    expect(mockedApi.fleetRetry).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('useRunbookFleet task.progress 事件合并', () => {
  it('start 建骨架（列序/行序）→ step 逐格增量 → final 终态', async () => {
    mockedApi.fleetRun.mockReturnValue(apiRes(snapshot()))
    const { wrapper, fleet } = mountHost()
    // 占位期（响应未回）：start 按 bookId 归属
    const launching = fleet.launch({ bookId: 'bk1', title: 'x', targetIds: ['t-a', 't-b'], onFailure: 'stop' })
    dispatchProgress({
      runId: 'frb_9', bookId: 'bk1', status: 'running',
      fleet: { phase: 'start', stepIndex: -1, stepTotal: 2, targetIds: ['t-a', 't-b'], stepNames: ['拉取', '构建'] },
    })
    expect(fleet.run.value?.stepNames).toEqual(['拉取', '构建'])
    expect(fleet.run.value?.cells.length).toBe(2)
    expect(fleet.run.value?.runId).toBe('frb_9')

    dispatchProgress({
      runId: 'frb_9', bookId: 'bk1', status: 'running',
      fleet: { phase: 'step', stepIndex: 0, stepTotal: 2, targetIds: ['t-a', 't-b'], results: [
        { id: 't-a', status: 'done', exitCode: 0 },
        { id: 't-b', status: 'failed', exitCode: 7 },
      ] },
    })
    expect(fleet.run.value?.cells[0]!['t-b']).toMatchObject({ status: 'failed', exitCode: 7 })

    dispatchProgress({
      runId: 'frb_9', bookId: 'bk1', status: 'failed',
      fleet: { phase: 'final', stepIndex: 0, stepTotal: 2 },
    })
    expect(fleet.run.value?.status).toBe('failed')
    await launching
    wrapper.unmount()
  })

  it('他书/他 run 的事件不串账；stepNames 已建后 start 不覆盖', async () => {
    mockedApi.fleetRun.mockReturnValue(apiRes(snapshot()))
    const { wrapper, fleet } = mountHost()
    await fleet.launch({ bookId: 'bk1', title: 'x', targetIds: ['t-a'], onFailure: 'stop' })
    const before = fleet.run.value?.stepNames
    dispatchProgress({
      runId: 'frb_other', bookId: 'other-book', status: 'running',
      fleet: { phase: 'start', targetIds: ['x'], stepNames: ['别家'] },
    })
    dispatchProgress({
      runId: 'frb_other', bookId: 'other-book', status: 'running',
      fleet: { phase: 'step', stepIndex: 0, results: [{ id: 'x', status: 'done' }] },
    })
    expect(fleet.run.value?.stepNames).toEqual(before)
    expect(fleet.run.value?.cells[0]!['t-a']?.status).toBe('done')
    wrapper.unmount()
  })

  it('final status=done 映射 completed（服务端终态词与前端状态词折算）', async () => {
    mockedApi.fleetRun.mockReturnValue(apiRes(snapshot()))
    const { wrapper, fleet } = mountHost()
    await fleet.launch({ bookId: 'bk1', title: 'x', targetIds: ['t-a'], onFailure: 'stop' })
    dispatchProgress({
      runId: 'frb_1', bookId: 'bk1', status: 'done',
      fleet: { phase: 'final', stepIndex: 1, stepTotal: 2 },
    })
    expect(fleet.run.value?.status).toBe('completed')
    wrapper.unmount()
  })
})

describe('useRunbookFleet reset 清账', () => {
  it('reset 清运行视图与断连标注', async () => {
    mockedApi.fleetRun.mockRejectedValue(new TypeError('network down'))
    const { wrapper, fleet } = mountHost()
    await fleet.launch({ bookId: 'bk1', title: 'x', targetIds: ['t-a'], onFailure: 'stop' })
    expect(fleet.run.value).not.toBe(null)
    fleet.reset()
    expect(fleet.run.value).toBe(null)
    expect(fleet.connectionLost.value).toBe(false)
    wrapper.unmount()
  })
})
