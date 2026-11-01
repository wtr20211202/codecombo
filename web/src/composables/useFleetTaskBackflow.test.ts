import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  startFleetTaskBackflow,
  stopFleetTaskBackflow,
  resetFleetTaskBackflowForTest,
  FLEET_BACKFLOW_POLL_MS,
  BACKFLOW_NOTIFY_FRESH_MS,
} from '@/composables/useFleetTaskBackflow'
import { useAssistantTaskStore } from '@/stores/assistantTask'
import { useNotificationStore } from '@/stores/notification'
import { useLockStore } from '@/stores/lock'
import { resetAgentTaskNotifyStateForTest } from '@/utils/agentTaskNotify'
import { instanceFetch } from '@/api/instanceFetch'
import type { DispatchRecord } from '@/api/domains/system'

// 联邦派发进度回流（P-20261004-131）单测：mock instanceFetch 双跳数据源——
// 中心寻址账 + 对端任务事件流，驱动 15s 轮询映射与终态沿通知的完整决策面。
// 假时钟推进 setInterval；通知副作用经 notification store add 侦听断言

vi.mock('@/api/instanceFetch', () => ({
  instanceFetch: vi.fn(),
}))

const instanceFetchMock = vi.mocked(instanceFetch)

const NOW = 1_700_000_000_000

function record(over: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    id: 'rec-1',
    instanceId: 'inst-1',
    instanceName: 'worker-1',
    remoteSessionId: 'term-remote-1',
    remoteSessionName: '派发会话',
    runtime: 'claude',
    at: new Date(NOW - 60_000).toISOString(),
    ...over,
  }
}

/** 等一轮 in-flight 轮询收口（轮询是 async 链，间隔宏任务数拍干） */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  instanceFetchMock.mockReset()
  // 轮询有锁定态闸（isLocked 默认 true——应用启动时由 checkStatus 翻转），
  // 用例显式解锁对齐「已解锁应用」前提
  useLockStore().isLocked = false
  // 通知链指纹表（模块级）随例清空——回流轮询会真实驱动通知链，指纹跨例
  // 残留会把同键终态误判为「3s 窗口内已入账」而静默
  resetAgentTaskNotifyStateForTest()
  // 通知子开关默认开（通知偏好默认全开，store 缺省即开——无需额外桩）
})

afterEach(() => {
  resetFleetTaskBackflowForTest()
  vi.useRealTimers()
})

describe('useFleetTaskBackflow 轮询映射', () => {
  it('对端最新 task.progress 映射进 bySession（remote: 键 + 实例元数据）', async () => {
    instanceFetchMock.mockImplementation(async (_id, _method, path) => {
      if (path === '/instances/dispatched') return { data: [record()] }
      return { data: [{ type: 'task.progress', task: '远端任务', status: 'running', step: '编译中', at: new Date(NOW).toISOString() }] }
    })
    startFleetTaskBackflow()
    await settle()
    const entry = useAssistantTaskStore().bySession['remote:inst-1:term-remote-1']
    expect(entry).toBeDefined()
    expect(entry?.task).toBe('远端任务')
    expect(entry?.status).toBe('running')
    expect(entry?.remote?.instanceName).toBe('worker-1')
    expect(entry?.remote?.sessionName).toBe('派发会话')
    stopFleetTaskBackflow()
  })

  it('对端事件流取第一条 task.progress（approval.* 混入不映射）', async () => {
    instanceFetchMock.mockImplementation(async (_id, _method, path) => {
      if (path === '/instances/dispatched') return { data: [record()] }
      return { data: [
        { type: 'approval.pending', at: new Date(NOW).toISOString() },
        { type: 'task.progress', task: '远端任务', status: 'running', at: new Date(NOW - 1000).toISOString() },
      ] }
    })
    startFleetTaskBackflow()
    await settle()
    expect(useAssistantTaskStore().bySession['remote:inst-1:term-remote-1']?.task).toBe('远端任务')
    stopFleetTaskBackflow()
  })

  it('对端 404（无任务事件流端点）→ 该实例本页降级跳过，不再重试', async () => {
    instanceFetchMock.mockImplementation(async (id, _method, path) => {
      if (id === 'local') return { data: [record()] }
      throw new Error('404')
    })
    startFleetTaskBackflow()
    await settle()
    expect(instanceFetchMock).toHaveBeenCalledTimes(2) // 寻址 1 + 对端 1
    await vi.advanceTimersByTimeAsync(FLEET_BACKFLOW_POLL_MS)
    await settle()
    // 第二轮：对端拉取不再发生（跳过），仅寻址账查询
    expect(instanceFetchMock).toHaveBeenCalledTimes(3)
    stopFleetTaskBackflow()
  })

  it('对端网络失败 → 静默跳过本轮，下一轮自愈重试', async () => {
    instanceFetchMock.mockImplementation(async (id, _method, path) => {
      if (id === 'local') return { data: [record()] }
      if (path.startsWith('/agent-tasks')) throw new Error('network dead')
      return { data: [] }
    })
    startFleetTaskBackflow()
    await settle()
    await vi.advanceTimersByTimeAsync(FLEET_BACKFLOW_POLL_MS)
    await settle()
    const peerCalls = instanceFetchMock.mock.calls.filter(c => c[2].startsWith('/agent-tasks')).length
    expect(peerCalls).toBe(2) // 未被拉黑，每轮都重试
    stopFleetTaskBackflow()
  })

  it('终态收口：done 观察后该记录不再轮询', async () => {
    instanceFetchMock.mockImplementation(async (id, _method, path) => {
      if (id === 'local') return { data: [record()] }
      return { data: [{ type: 'task.progress', task: '远端任务', status: 'done', at: new Date(NOW).toISOString() }] }
    })
    startFleetTaskBackflow()
    await settle()
    const peerCallsAfterFirst = instanceFetchMock.mock.calls.filter(c => c[2].startsWith('/agent-tasks')).length
    expect(peerCallsAfterFirst).toBe(1)
    await vi.advanceTimersByTimeAsync(FLEET_BACKFLOW_POLL_MS * 2)
    await settle()
    // 收口后对端拉取不再增长
    expect(instanceFetchMock.mock.calls.filter(c => c[2].startsWith('/agent-tasks')).length).toBe(1)
    stopFleetTaskBackflow()
  })

  it('回流态收账：记录消失（过期/被删）后 running 条目随账清掉，终态保留', async () => {
    const store = useAssistantTaskStore()
    // 手工预置两条 remote 条目（running + done），本轮寻址账为空
    store.progressForRemote('remote:inst-1:term-run', { status: 'running' }, { instanceId: 'inst-1', instanceName: 'w', sessionName: 's' })
    vi.advanceTimersByTime(1000)
    store.progressForRemote('remote:inst-1:term-done', { status: 'done' }, { instanceId: 'inst-1', instanceName: 'w', sessionName: 's' })
    instanceFetchMock.mockResolvedValue({ data: [] })
    startFleetTaskBackflow()
    await settle()
    expect(store.bySession['remote:inst-1:term-run']).toBeUndefined()
    // done 真终态保留供回看（pruneClosedSessions 同一裁决）
    expect(store.bySession['remote:inst-1:term-done']).toBeDefined()
    stopFleetTaskBackflow()
  })
})

describe('useFleetTaskBackflow 终态通知', () => {
  let addSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    addSpy = vi.spyOn(useNotificationStore(), 'add')
  })

  function mockEvents(status: string, at: number): void {
    instanceFetchMock.mockImplementation(async (id, _method, path) => {
      if (id === 'local') return { data: [record()] }
      if (path.startsWith('/agent-tasks')) {
        return { data: [{ type: 'task.progress', task: '远端任务', status, at: new Date(at).toISOString() }] }
      }
      return { data: [] }
    })
  }

  it('running→done 沿 + 事件新鲜 → 通知链入账（switch-instance 跳实例）', async () => {
    mockEvents('done', NOW - 1000)
    startFleetTaskBackflow()
    await settle()
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
      category: 'task',
      action: 'switch-instance',
      actionPayload: 'inst-1',
    }))
    stopFleetTaskBackflow()
  })

  it('旧终态（页面关闭期间错过）→ 只映射状态不通知（补账不重放）', async () => {
    mockEvents('done', NOW - BACKFLOW_NOTIFY_FRESH_MS - 60_000)
    startFleetTaskBackflow()
    await settle()
    expect(addSpy).not.toHaveBeenCalled()
    expect(useAssistantTaskStore().bySession['remote:inst-1:term-remote-1']?.status).toBe('done')
    stopFleetTaskBackflow()
  })

  it('首轮直接观察到 done 再到 failed 的终态间不重复通知（终态已收口不再轮询）', async () => {
    mockEvents('done', NOW)
    startFleetTaskBackflow()
    await settle()
    expect(addSpy).toHaveBeenCalledTimes(1)
    // 对端翻为 failed：记录已收口，不再轮询也就不会二次入账
    mockEvents('failed', NOW)
    await vi.advanceTimersByTimeAsync(FLEET_BACKFLOW_POLL_MS)
    await settle()
    expect(addSpy).toHaveBeenCalledTimes(1)
    stopFleetTaskBackflow()
  })
})
