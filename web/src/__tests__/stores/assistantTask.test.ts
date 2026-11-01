import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAssistantTaskStore, isTaskStale, TASK_STALE_MS, type TaskProgressStep } from '@/stores/assistantTask'
import { opsTaskApi, type ActiveOpsTask } from '@/api/domains/opstask'

// seedActive 的 API 面打桩（applyActiveSnapshot 走纯 store 动作不经此桩）
vi.mock('@/api/domains/opstask', () => ({
  opsTaskApi: { listActive: vi.fn() },
}))

// Date.now() 驱动 updatedAt/bySession 时间戳，用假时钟保证同毫秒/跨毫秒可控
const BASE = 1_700_000_000_000

// 文件级钩子：全部 describe 共用（假时钟 + 每例重置 store——resetForTest 停掉
// 陈旧判定心跳，防真实定时器挂住 vitest worker）
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
})

afterEach(() => {
  useAssistantTaskStore().resetForTest()
  vi.useRealTimers()
})

describe('assistantTaskStore', () => {

  it('初始状态无任务', () => {
    const store = useAssistantTaskStore()
    expect(store.active).toBe(false)
    expect(store.task).toBe('')
    expect(store.step).toBe('')
    expect(store.status).toBe('')
    expect(store.updatedAt).toBe(0)
    expect(store.bySession).toEqual({})
    expect(store.latestSessionId).toBeNull()
    expect(store.displayTask).toBe('')
  })

  it('progress 置全局字段并打时间戳', () => {
    const store = useAssistantTaskStore()
    store.progress({ task: '重构 store', step: '写单测' })
    expect(store.active).toBe(true)
    expect(store.task).toBe('重构 store')
    expect(store.step).toBe('写单测')
    expect(store.status).toBe('running')
    expect(store.updatedAt).toBe(BASE)
  })

  it('progress 未带 task 保留旧值；缺省 status 兜底 running', () => {
    const store = useAssistantTaskStore()
    store.progress({ task: 't1' })
    store.progress({ step: '第二步' })
    expect(store.task).toBe('t1')
    expect(store.step).toBe('第二步')
    expect(store.status).toBe('running')
  })

  it('progress 显式空 step 可清空步骤描述（!== undefined 判定）', () => {
    const store = useAssistantTaskStore()
    store.progress({ task: 't1', step: '旧步骤' })
    store.progress({ step: '' })
    expect(store.step).toBe('')
  })

  it('finish 结束任务（默认 done，可自定义终态）', () => {
    const store = useAssistantTaskStore()
    store.progress({ task: 't1' })
    store.finish()
    expect(store.active).toBe(false)
    expect(store.status).toBe('done')
    store.progress({ task: 't2' })
    expect(store.active).toBe(true)
    store.finish('failed')
    expect(store.status).toBe('failed')
  })

  it('finish 不清 bySession（悬浮球点击跳转归属仍可用）', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: 'A' })
    store.finish()
    expect(store.bySession.s1?.task).toBe('A')
  })

  it('progressFor 写会话归属并透传全局字段（旧消费方不感知变化）', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: 'A 会话任务', step: '步骤 1' })
    expect(store.bySession.s1).toEqual({
      task: 'A 会话任务',
      step: '步骤 1',
      status: 'running',
      updatedAt: BASE,
      steps: [],
    })
    expect(store.task).toBe('A 会话任务')
    expect(store.status).toBe('running')
    expect(store.active).toBe(true)
  })

  it('progressFor 增量上报缺省字段沿用该会话上次值', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: 'A', step: '旧步骤' })
    vi.advanceTimersByTime(1000)
    store.progressFor('s1', { status: 'running' })
    expect(store.bySession.s1).toEqual({
      task: 'A',
      step: '旧步骤',
      status: 'running',
      updatedAt: BASE + 1000,
      steps: [],
    })
  })

  // —— 结构化步骤清单（P-20261004-7）：整包替换、缺省保留、畸形防御 ——

  it('progress steps 整包替换（最后一份为准）；缺省 steps 保留既有清单', () => {
    const store = useAssistantTaskStore()
    const plan = [{ name: '第一步', done: false }, { name: '第二步', done: false }]
    store.progress({ task: 't1', steps: plan })
    expect(store.steps).toEqual(plan)
    store.progress({ step: '第二步' })
    expect(store.steps).toEqual(plan)
    const done = [{ name: '第一步', done: true }, { name: '第二步', done: false }]
    store.progress({ step: '第二步', steps: done })
    expect(store.steps).toEqual(done)
  })

  it('progress steps 畸形项防御：剔除无 name 项、done 严格布尔、name 去空白', () => {
    const store = useAssistantTaskStore()
    // 模拟未过服务端规整的畸形清单（直调 store 的路径防呆）
    const malformed = [
      { name: ' 有效 ', done: true },
      { name: '   ', done: false },
      { name: '', done: false },
      { done: true },
      null,
    ] as unknown as TaskProgressStep[]
    store.progress({ steps: malformed })
    expect(store.steps).toEqual([{ name: '有效', done: true }])
  })

  it('progressFor steps 会话清单独立；缺省 steps 沿用该会话上次清单', () => {
    const store = useAssistantTaskStore()
    const plan = [{ name: '读', done: true }, { name: '写', done: false }]
    store.progressFor('s1', { task: 'A', steps: plan })
    vi.advanceTimersByTime(1000)
    store.progressFor('s1', { step: '写' })
    expect(store.bySession.s1?.steps).toEqual(plan)
    vi.advanceTimersByTime(1000)
    const done = [{ name: '读', done: true }, { name: '写', done: true }]
    store.progressFor('s1', { step: '完', steps: done })
    expect(store.bySession.s1?.steps).toEqual(done)
  })

  it('displaySteps 优先最新归属会话清单；最新会话无清单回退全局镜像（P7 透传语义）', () => {
    const store = useAssistantTaskStore()
    const globalPlan = [{ name: '全局步骤', done: false }]
    store.progress({ task: '全局任务', steps: globalPlan })
    expect(store.displaySteps).toEqual(globalPlan)
    const s1Plan = [{ name: 'S1 步骤', done: false }]
    store.progressFor('s1', { task: 'A', steps: s1Plan })
    // progressFor 透传全局字段（P7 既有语义：管理页状态点等旧消费方不感知变化）
    // ——全局 steps 是「最近一次上报」的镜像，s1 的清单覆盖最初的全局清单
    expect(store.steps).toEqual(s1Plan)
    vi.advanceTimersByTime(1000)
    store.progressFor('s2', { task: 'B' }) // s2 无清单 → 回退全局镜像（s1 最近一次上报的清单）
    expect(store.displaySteps).toEqual(s1Plan)
    vi.advanceTimersByTime(1000)
    store.progressFor('s1', { task: 'A2', steps: s1Plan })
    expect(store.latestSessionId).toBe('s1')
    expect(store.displaySteps).toEqual(s1Plan)
  })

  it('progressFor 各会话归属互不串写', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: 'A' })
    vi.advanceTimersByTime(1000)
    store.progressFor('s2', { task: 'B' })
    expect(store.bySession.s1?.task).toBe('A')
    expect(store.bySession.s2?.task).toBe('B')
  })

  it('latestSessionId 取 updatedAt 最新的会话', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: 'A' })
    vi.advanceTimersByTime(1000)
    store.progressFor('s2', { task: 'B' })
    expect(store.latestSessionId).toBe('s2')
    vi.advanceTimersByTime(2000)
    store.progressFor('s1', { task: 'A2' })
    expect(store.latestSessionId).toBe('s1')
  })

  it('latestSessionId 同毫秒并列时先写入者优先（严格大于判定）', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: 'A' })
    store.progressFor('s2', { task: 'B' })
    expect(store.latestSessionId).toBe('s1')
  })

  it('displayTask 优先取最新归属会话的任务', () => {
    const store = useAssistantTaskStore()
    store.progress({ task: '全局任务' })
    store.progressFor('s1', { task: 'A 任务' })
    vi.advanceTimersByTime(1000)
    store.progressFor('s2', { task: 'B 任务' })
    expect(store.displayTask).toBe('B 任务')
  })

  it('displayTask 最新归属会话任务为空时回退全局任务（最近一次透传值）', () => {
    const store = useAssistantTaskStore()
    store.progress({ task: '全局任务' })
    // progressFor 透传全局字段：全局 task 随之变为 'A'
    store.progressFor('s1', { task: 'A' })
    vi.advanceTimersByTime(1000)
    // 新会话仅上报状态，无 task/step → 该会话任务为空串
    store.progressFor('s2', { status: 'running' })
    expect(store.latestSessionId).toBe('s2')
    expect(store.displayTask).toBe('A')
  })

  it('无归属上报时 displayTask 即全局任务', () => {
    const store = useAssistantTaskStore()
    store.progress({ task: '仅全局' })
    expect(store.displayTask).toBe('仅全局')
  })
})

// —— 陈旧失联判定（P-20261003-303）：running 超时无上报 =「可能已失联」——

describe('isTaskStale 纯判定', () => {
  it('running 且距上次上报超阈值 → true；阈值参数可注入', () => {
    expect(isTaskStale('running', BASE, BASE + TASK_STALE_MS, TASK_STALE_MS)).toBe(true)
    // 注入短阈值：同一时间点，阈值小则判陈旧
    expect(isTaskStale('running', BASE, BASE + 5_000, 3_000)).toBe(true)
    expect(isTaskStale('running', BASE, BASE + 2_999, 3_000)).toBe(false)
  })

  it('终态/从未上报/未超阈值 → false', () => {
    expect(isTaskStale('done', BASE - TASK_STALE_MS * 2, BASE)).toBe(false)
    expect(isTaskStale('failed', BASE - TASK_STALE_MS * 2, BASE)).toBe(false)
    expect(isTaskStale('running', 0, BASE)).toBe(false)
    expect(isTaskStale('running', BASE - 1, BASE)).toBe(false)
    expect(isTaskStale(undefined, BASE - TASK_STALE_MS * 2, BASE)).toBe(false)
  })
})

describe('陈旧判定 getter（P-20261003-303）', () => {
  it('isStale：running 超时无上报点亮，心跳推进 nowTick 后随时间重算', () => {
    const store = useAssistantTaskStore()
    store.progress({ task: '长任务' })
    expect(store.isStale).toBe(false)
    // 心跳 30s 一跳：推进超过阈值 + 一个心跳周期后必已跨线
    vi.advanceTimersByTime(TASK_STALE_MS + 30_000)
    expect(store.isStale).toBe(true)
  })

  it('真实终态到达仍可覆盖：陈旧态 finish 后立即熄灭（不清数据的另一面）', () => {
    const store = useAssistantTaskStore()
    store.progress({ task: '长任务' })
    vi.advanceTimersByTime(TASK_STALE_MS + 30_000)
    expect(store.isStale).toBe(true)
    store.finish('done')
    expect(store.isStale).toBe(false)
    // 数据仍在：任务文本未丢
    expect(store.task).toBe('长任务')
    expect(store.status).toBe('done')
  })

  it('staleSessionIds：仅收集陈旧的 running 会话，终态/新鲜会话不在列', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: '旧任务' })
    vi.advanceTimersByTime(TASK_STALE_MS + 30_000)
    store.progressFor('s2', { task: '新任务' }) // 新鲜上报
    vi.advanceTimersByTime(30_000)
    store.progressFor('s3', { task: '完', status: 'done' }) // 终态不陈旧
    expect(store.staleSessionIds.has('s1')).toBe(true)
    expect(store.staleSessionIds.has('s2')).toBe(false)
    expect(store.staleSessionIds.has('s3')).toBe(false)
    expect(store.staleSessionIds.size).toBe(1)
  })
})

describe('联邦派发回流（P-20261004-131）', () => {
  it('progressForRemote 写 remote: 键 + 元数据，全局字段同步透传', () => {
    const store = useAssistantTaskStore()
    store.progressForRemote('remote:inst-1:term-9',
      { task: '远端任务', status: 'running', step: '编译中' },
      { instanceId: 'inst-1', instanceName: 'worker-1', sessionName: '派发会话' })
    const entry = store.bySession['remote:inst-1:term-9']
    expect(entry).toBeDefined()
    expect(entry?.task).toBe('远端任务')
    expect(entry?.status).toBe('running')
    expect(entry?.remote).toEqual({ instanceId: 'inst-1', instanceName: 'worker-1', sessionName: '派发会话' })
    // 全局字段透传（远程任务也是「有活在跑」——悬浮球呼吸/收起判断同口径）
    expect(store.active).toBe(true)
    expect(store.task).toBe('远端任务')
    // latestSessionId 指向远程键（悬浮球点击跳实例的锚）
    expect(store.latestSessionId).toBe('remote:inst-1:term-9')
  })

  it('progressForRemote 元数据逐次整包替换（实例改名快照随最新回流到位）', () => {
    const store = useAssistantTaskStore()
    store.progressForRemote('remote:i:t', { status: 'running' }, { instanceId: 'i', instanceName: '旧名', sessionName: 's' })
    store.progressForRemote('remote:i:t', { status: 'running' }, { instanceId: 'i', instanceName: '新名', sessionName: 's' })
    expect(store.bySession['remote:i:t']?.remote?.instanceName).toBe('新名')
  })

  it('pruneClosedSessions 不清 remote: 条目（远程会话不在本地快照是常态非死亡）', () => {
    const store = useAssistantTaskStore()
    store.progressForRemote('remote:i:t', { task: '远端任务' }, { instanceId: 'i', instanceName: 'w', sessionName: 's' })
    store.pruneClosedSessions([]) // 本地快照为空也不得波及远程条目
    expect(store.bySession['remote:i:t']).toBeDefined()
    expect(store.active).toBe(true)
  })

  it('本地会话关闭清账照常（远程条目在场不改变本地语义）', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: '本地任务' })
    vi.advanceTimersByTime(1000)
    store.progressForRemote('remote:i:t', { task: '远端任务' }, { instanceId: 'i', instanceName: 'w', sessionName: 's' })
    store.pruneClosedSessions([])
    expect(store.bySession.s1).toBeUndefined()
    // 远程条目仍在 running → 全局 running 不收敛（远程任务也在跑）
    expect(store.bySession['remote:i:t']).toBeDefined()
    expect(store.active).toBe(true)
  })
})

describe('pruneClosedSessions 关闭清账（P-20261003-303）', () => {
  it('已关会话的 running 归属移除；最新归属被清且无其他 running 时收敛全局态', () => {
    const store = useAssistantTaskStore()
    // s2 的 done 先报（旧），s1 的 running 后报（最新归属）——全局镜像由最后
    // 一次上报决定，收敛前提（status=running）由此锚定
    store.progressFor('s2', { task: '已完成任务', status: 'done' })
    vi.advanceTimersByTime(1000)
    store.progressFor('s1', { task: '死会话任务' })
    store.pruneClosedSessions(['s2']) // 快照里只剩 s2，s1 已关
    expect(store.bySession.s1).toBeUndefined()
    // done 真终态保留供回看（不清真实终态）
    expect(store.bySession.s2?.status).toBe('done')
    // 最新归属 s1 被清、再无 running 归属 → 全局 running 收敛为空态
    expect(store.active).toBe(false)
    expect(store.status).toBe('')
  })

  it('其他会话仍在 running 时全局不收敛', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: 'A' })
    vi.advanceTimersByTime(1000)
    store.progressFor('s2', { task: 'B' })
    store.pruneClosedSessions(['s1']) // s1 存活，较新的 s2 已关
    expect(store.bySession.s2).toBeUndefined()
    expect(store.bySession.s1?.status).toBe('running')
    expect(store.active).toBe(true)
    expect(store.status).toBe('running')
  })

  it('被关会话非最新归属时全局不动（仍以最新归属为准）', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: 'A' })
    vi.advanceTimersByTime(1000)
    store.progressFor('s2', { task: 'B' })
    // 最新归属 s2 存活，只关较旧的 s1：全局 running 继续由 s2 承载
    store.pruneClosedSessions(['s2'])
    expect(store.bySession.s1).toBeUndefined()
    expect(store.bySession.s2).toBeDefined()
    expect(store.active).toBe(true)
    expect(store.status).toBe('running')
  })

  it('快照名单为空的极端形态：全部 running 归属清空，最新被清即收敛', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: 'A' })
    vi.advanceTimersByTime(1000)
    store.progressFor('s2', { task: 'B' })
    store.pruneClosedSessions([])
    expect(store.bySession.s1).toBeUndefined()
    expect(store.bySession.s2).toBeUndefined()
    expect(store.active).toBe(false)
    expect(store.status).toBe('')
  })

  it('无归属上报（纯全局任务）不受会话关闭影响', () => {
    const store = useAssistantTaskStore()
    store.progress({ task: '全局任务' })
    store.pruneClosedSessions([])
    expect(store.active).toBe(true)
    expect(store.status).toBe('running')
  })

  it('存活名单内的归属一律不动', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: 'A' })
    store.pruneClosedSessions(['s1'])
    expect(store.bySession.s1?.task).toBe('A')
    expect(store.active).toBe(true)
  })
})

describe('重启恢复补账（P-20261004-120）', () => {
  /** active 快照条目构造（缺省字段兜底，测试可读性） */
  function snap(sessionId: string, receivedAt: number, payload: ActiveOpsTask['payload']): ActiveOpsTask {
    return { sessionId, receivedAt, payload }
  }

  it('applyActiveSnapshot 回填 bySession + 全局字段；receivedAt 升序下最新一条最后落位', () => {
    const store = useAssistantTaskStore()
    store.applyActiveSnapshot([
      snap('s1', BASE - 60_000, { task: '任务A', status: 'running', step: '步骤A' }),
      snap('s2', BASE, { task: '任务B', status: 'running', step: '步骤B', steps: [{ name: '清单项', done: true }] }),
    ])
    // 条目时刻对齐服务端 receivedAt（陈旧判活的诚实时钟）
    expect(store.bySession.s1).toMatchObject({ task: '任务A', status: 'running', step: '步骤A' })
    expect(store.bySession.s1?.updatedAt).toBe(BASE - 60_000)
    expect(store.bySession.s2?.updatedAt).toBe(BASE)
    expect(store.bySession.s2?.steps).toEqual([{ name: '清单项', done: true }])
    // 全局字段收敛为最新一条（悬浮球显示「进度所属会话」同源）
    expect(store.active).toBe(true)
    expect(store.task).toBe('任务B')
    expect(store.latestSessionId).toBe('s2')
    // 全局时刻同源对齐服务端 receivedAt（悬浮球 isStale 不因补账「现在起算」）
    expect(store.updatedAt).toBe(BASE)
  })

  it('终态条目与实时链同净效果：归属 done + 全局 status 翻转（悬浮球沉淀入口照常可见）', () => {
    const store = useAssistantTaskStore()
    store.applyActiveSnapshot([snap('s1', BASE, { task: '已完成任务', status: 'done' })])
    expect(store.bySession.s1?.status).toBe('done')
    expect(store.status).toBe('done')
    // 与 OpsChannelBridge.onTaskProgress 的 finish+progressFor 净效果一致：
    // 终态后悬浮球保持可见（沉淀到笔记入口依赖该形态）
    expect(store.active).toBe(true)
  })

  it('陈旧诚实计入：页面关闭期间的沉默在补账后立刻进 staleSessionIds（复用 P-303 阈值）', () => {
    const store = useAssistantTaskStore()
    store.applyActiveSnapshot([
      snap('s-old', BASE - TASK_STALE_MS - 60_000, { task: '旧任务', status: 'running' }),
      snap('s-new', BASE, { task: '新任务', status: 'running' }),
    ])
    expect(store.staleSessionIds.has('s-old')).toBe(true)
    expect(store.staleSessionIds.has('s-new')).toBe(false)
  })

  it('补账与广播竞态：快照旧于既有实时条目时不倒退覆盖（会话与全局同保护）', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: '实时新任务', status: 'running', step: '新步骤' })
    store.applyActiveSnapshot([
      snap('s1', BASE - 120_000, { task: '旧快照任务', status: 'running', step: '旧步骤' }),
      // 其他会话的旧条目照常回填（跳过只按会话自身的新旧判定，不误伤）
      snap('s2', BASE - 60_000, { task: '旧快照任务二', status: 'running' }),
    ])
    expect(store.bySession.s1).toMatchObject({ task: '实时新任务', step: '新步骤', updatedAt: BASE })
    expect(store.bySession.s2?.task).toBe('旧快照任务二')
    // 快照内最新条目仍早于既有全局时刻 → 全局字段不倒退
    expect(store.task).toBe('实时新任务')
    expect(store.updatedAt).toBe(BASE)
  })

  it('补账条目更新于既有实时条目时整条覆盖并推进全局时刻（断线期间的新进展）', () => {
    const store = useAssistantTaskStore()
    store.progressFor('s1', { task: '断线前', status: 'running' })
    store.applyActiveSnapshot([snap('s1', BASE + 60_000, { task: '断线期间', status: 'running', step: '新步骤' })])
    expect(store.bySession.s1).toMatchObject({ task: '断线期间', step: '新步骤', updatedAt: BASE + 60_000 })
    expect(store.task).toBe('断线期间')
    expect(store.updatedAt).toBe(BASE + 60_000)
  })

  it('畸形快照防御：缺 sessionId/payload 跳过、receivedAt=0 回落补账时刻、null 列表不抛', () => {
    const store = useAssistantTaskStore()
    store.applyActiveSnapshot(null as unknown as ActiveOpsTask[])
    expect(store.bySession).toEqual({})
    store.applyActiveSnapshot([
      snap('', BASE, { task: '无归属', status: 'running' }),
      snap('s1', 0, { task: '无时刻', status: 'running' }),
      { sessionId: 's2', receivedAt: BASE, payload: undefined as unknown as ActiveOpsTask['payload'] },
    ])
    expect(store.bySession.s1?.task).toBe('无时刻')
    expect(store.bySession.s1?.updatedAt).toBe(BASE)
    expect(store.bySession.s2).toBeUndefined()
    expect(Object.keys(store.bySession)).toEqual(['s1'])
  })

  it('seedActive 拉快照回填；失败静默不抛（WS 广播兜底增量）', async () => {
    const store = useAssistantTaskStore()
    vi.mocked(opsTaskApi.listActive).mockResolvedValue({
      data: { tasks: [snap('s1', BASE, { task: '快照任务', status: 'running', step: '编译中' })], serverTime: BASE },
    } as Awaited<ReturnType<typeof opsTaskApi.listActive>>)
    await store.seedActive()
    expect(store.bySession.s1).toMatchObject({ task: '快照任务', step: '编译中' })
    expect(store.active).toBe(true)

    vi.mocked(opsTaskApi.listActive).mockRejectedValue(new Error('423 locked'))
    await expect(store.seedActive()).resolves.toBeUndefined()
    // 失败不清既有补账结果
    expect(store.bySession.s1?.task).toBe('快照任务')
  })
})
