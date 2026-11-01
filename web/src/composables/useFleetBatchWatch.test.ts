import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  evaluateFleetBatches,
  resetFleetBatchWatchForTest,
} from './useFleetBatchWatch'
import { collectFleetBatches, type FleetBatchMeta } from '../utils/fleetBatches'
import { useNotificationStore } from '../stores/notification'
import { useAssistantTaskStore } from '../stores/assistantTask'

// 编队批级完成通知（P-20261005-145）单测：收敛沿三守卫（观察过运行/有真实
// 终态/批级去重）+ 类别开关把门 + 通知形态（warning 级、monitor-fleet 直达
// action）。通知副作用经 notification store add 侦听断言（真 store 不发网络）

function batch(over: Partial<FleetBatchMeta> = {}): FleetBatchMeta {
  return {
    batchId: 'fleet-1',
    launchedAt: '2026-10-09T10:00:00Z',
    members: ['m1', 'm2'],
    ...over,
  }
}

/** 快照+进度 → 聚合视图（与生产 startFleetBatchWatch 同一条调用链） */
function evalWith(
  sessions: Array<{ id: string; name: string; projectId: string; fleetBatch?: FleetBatchMeta }>,
): void {
  const taskStore = useAssistantTaskStore()
  evaluateFleetBatches(collectFleetBatches(sessions, taskStore.bySession))
}

function fleetSession(id: string, name: string, fb: FleetBatchMeta) {
  return { id, name, projectId: '', fleetBatch: fb }
}

const META = batch()

beforeEach(() => {
  setActivePinia(createPinia())
  resetFleetBatchWatchForTest()
})

describe('evaluateFleetBatches 收敛沿通知', () => {
  it('观察过运行 → 全员终态 → 单条批级通知（monitor-fleet 直达 + 编队名正文）', () => {
    const store = useNotificationStore()
    const addSpy = vi.spyOn(store, 'add')
    const sessions = [
      fleetSession('m1', 'fleet: 审计', META),
      fleetSession('m2', 'fleet: 审计', META),
    ]
    const taskStore = useAssistantTaskStore()
    // 第 1 轮：全员 running（无上报也计 running）→ 只登记运行沿
    evalWith(sessions)
    expect(addSpy).not.toHaveBeenCalled()
    // 第 2 轮：一名完成 → 未收敛，无通知
    taskStore.progressFor('m1', { task: '审计', status: 'done' })
    evalWith(sessions)
    expect(addSpy).not.toHaveBeenCalled()
    // 第 3 轮：全员终态 → 单条通知
    taskStore.progressFor('m2', { task: '审计', status: 'done' })
    evalWith(sessions)
    expect(addSpy).toHaveBeenCalledTimes(1)
    const n = vi.mocked(addSpy).mock.calls[0]![0]!
    expect(n.category).toBe('task')
    expect(n.type).toBe('success')
    expect(n.action).toBe('monitor-fleet')
    expect(n.actionPayload).toBe('fleet-1')
    expect(String(n.title)).toContain('2 成功')
    expect(n.body).toBe('fleet: 审计')
  })

  it('打开前已收口的批不补放（无运行沿观察），刷新语义=不重放旧完成', () => {
    const store = useNotificationStore()
    const addSpy = vi.spyOn(store, 'add')
    const taskStore = useAssistantTaskStore()
    taskStore.progressFor('m1', { status: 'done' })
    taskStore.progressFor('m2', { status: 'failed' })
    // 页面打开首评即见全员终态：没有观察过运行 → 不通知
    evalWith([fleetSession('m1', 'fleet: 审计', META), fleetSession('m2', 'fleet: 审计', META)])
    expect(addSpy).not.toHaveBeenCalled()
  })

  it('失败成员 → warning 级样式；重复评估批级去重不二次入账', () => {
    const store = useNotificationStore()
    const addSpy = vi.spyOn(store, 'add')
    const taskStore = useAssistantTaskStore()
    const sessions = [
      fleetSession('m1', 'fleet: 审计', META),
      fleetSession('m2', 'fleet: 审计', META),
    ]
    taskStore.progressFor('m1', { status: 'failed' })
    taskStore.progressFor('m2', { status: 'running' })
    evalWith(sessions)
    taskStore.progressFor('m2', { status: 'done' })
    evalWith(sessions)
    evalWith(sessions)
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(addSpy).mock.calls[0]![0]!.type).toBe('warning')
  })

  it('成员全部关闭（批消失）后观察态随账清理；同批不复活不重放', () => {
    const store = useNotificationStore()
    const addSpy = vi.spyOn(store, 'add')
    const taskStore = useAssistantTaskStore()
    const sessions = [
      fleetSession('m1', 'fleet: 审计', META),
      fleetSession('m2', 'fleet: 审计', META),
    ]
    evalWith(sessions) // running 登记
    // 成员全会话关闭（快照对账）：批消失，观察态剪枝
    evalWith([])
    // 会话表已无批 → 不可能再通知；即便 bySession 终态后到也无批入口
    taskStore.progressFor('m1', { status: 'done' })
    taskStore.progressFor('m2', { status: 'done' })
    evalWith([])
    expect(addSpy).not.toHaveBeenCalled()
  })

  it('任务类别开关关闭 → 中心与桌面双静默（agentTaskNotify 同款前置门）', () => {
    const store = useNotificationStore()
    store.prefs.enabled.task = false
    const addSpy = vi.spyOn(store, 'add')
    const taskStore = useAssistantTaskStore()
    const sessions = [
      fleetSession('m1', 'fleet: 审计', META),
      fleetSession('m2', 'fleet: 审计', META),
    ]
    evalWith(sessions)
    taskStore.progressFor('m1', { status: 'done' })
    taskStore.progressFor('m2', { status: 'done' })
    evalWith(sessions)
    expect(addSpy).not.toHaveBeenCalled()
  })
})
