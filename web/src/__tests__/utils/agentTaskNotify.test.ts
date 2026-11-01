import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  handleAgentTaskProgressNotify,
  seenTaskEndRecently,
  takeTaskElapsed,
  clipNotifySummary,
  resetAgentTaskNotifyStateForTest,
} from '@/utils/agentTaskNotify'
import { useNotificationStore } from '@/stores/notification'
import { useLockStore } from '@/stores/lock'
import { useDesktopNotify } from '@/composables/useDesktopNotify'

// agent 任务终态通知链（P-20261002-15）：幂等（同 terminalId+status 短窗口
// 只入账一次）+ 聚焦跳过（页面可见不弹桌面通知、通知中心仍入账）+ 偏好开关
// 门控 + 耗时估算。模块级指纹表经 reset 钩子在用例间隔离，时间显式注入

// 桌面通知构造器替身：记录调用入参（permission 预置 granted）
function stubNotificationCtor(): Array<[string, unknown]> {
  const calls: Array<[string, unknown]> = []
  class FakeNotification {
    static permission = 'granted'
    constructor(title: string, opts?: unknown) {
      calls.push([title, opts])
    }
    close() { /* noop */ }
  }
  vi.stubGlobal('Notification', FakeNotification)
  return calls
}

// jsdom 的 document.hidden 默认 false（可见）；用例内按需切换
function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

describe('seenTaskEndRecently 幂等', () => {
  beforeEach(() => resetAgentTaskNotifyStateForTest())

  it('同键短窗口内重复 → 抑制；窗口外放行', () => {
    const t0 = 1_000_000
    expect(seenTaskEndRecently('term-1|done', t0)).toBe(false)
    expect(seenTaskEndRecently('term-1|done', t0 + 2999)).toBe(true)
    expect(seenTaskEndRecently('term-1|done', t0 + 3000)).toBe(false)
  })

  it('不同键互不影响（terminalId 或 status 维度隔离）', () => {
    const t0 = 1_000_000
    expect(seenTaskEndRecently('term-1|done', t0)).toBe(false)
    expect(seenTaskEndRecently('term-1|failed', t0)).toBe(false)
    expect(seenTaskEndRecently('term-2|done', t0)).toBe(false)
  })

  it('指纹表封顶（200）逐出最早：长会话无界增长防线，被逐出键可重新入账', () => {
    const t0 = 1_000_000
    expect(seenTaskEndRecently('term-k0|done', t0)).toBe(false)
    for (let i = 1; i <= 200; i++) {
      seenTaskEndRecently(`term-k${i}|done`, t0 + i)
    }
    // k0 已被 FIFO 逐出 → 视同未见过（可重新入账），而非被误抑制
    expect(seenTaskEndRecently('term-k0|done', t0 + 500)).toBe(false)
  })
})

describe('联邦派发回流终态通知（P-20261004-131）', () => {
  let addSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetAgentTaskNotifyStateForTest()
    useLockStore().isLocked = false
    addSpy = vi.spyOn(useNotificationStore(), 'add')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('remote: 键 done → switch-instance 跳实例 action + 正文来源实例注记', () => {
    stubNotificationCtor()
    handleAgentTaskProgressNotify({
      task: '远端构建',
      status: 'done',
      terminalId: 'remote:inst-1:term-9',
      remoteMeta: { instanceId: 'inst-1', instanceName: 'worker-1', sessionName: '派发会话' },
    }, 1_000_000)
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(addSpy).toHaveBeenCalledWith({
      type: 'success',
      category: 'task',
      title: '远端构建',
      body: '已完成\n来自实例 worker-1',
      action: 'switch-instance',
      actionPayload: 'inst-1',
    })
  })

  it('remote: 键 failed → error 级；meta 缺省回退实例 id', () => {
    stubNotificationCtor()
    handleAgentTaskProgressNotify({
      task: '远端任务',
      status: 'failed',
      terminalId: 'remote:inst-7:term-a',
    }, 2_000_000)
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        action: 'switch-instance',
        actionPayload: 'inst-7',
        body: expect.stringContaining('来自实例 inst-7'),
      })
    )
  })

  it('耗时起点：remote 键 running 先行上报后终态正文带耗时', () => {
    stubNotificationCtor()
    handleAgentTaskProgressNotify({
      status: 'running',
      terminalId: 'remote:inst-1:term-9',
      remoteMeta: { instanceId: 'inst-1', instanceName: 'w', sessionName: 's' },
    }, 1_000_000)
    handleAgentTaskProgressNotify({
      task: '远端任务',
      status: 'done',
      terminalId: 'remote:inst-1:term-9',
      remoteMeta: { instanceId: 'inst-1', instanceName: 'w', sessionName: 's' },
    }, 1_002_500)
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('2.5s') })
    )
  })
})

describe('handleAgentTaskProgressNotify 通知链', () => {
  let addSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetAgentTaskNotifyStateForTest()
    // useDesktopNotify 的锁定静默门控（P-20261003-5）：pinia 每 test 重建后
    // isLocked 回默认 true（应用启动时由 checkStatus 探测翻转），此处显式
    // 解锁对齐「已解锁应用」的用例前提；锁定分支本身由 useDesktopNotify
    // 单测与 e2e lock-notify-mute.spec 覆盖
    useLockStore().isLocked = false
    const store = useNotificationStore()
    addSpy = vi.spyOn(store, 'add')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (document as unknown as { hidden?: boolean }).hidden
  })

  it('done → 通知中心入账（task/success/标题=任务名），terminalId 带跳转 action', () => {
    stubNotificationCtor()
    handleAgentTaskProgressNotify({ task: '重构通知模块', status: 'done', terminalId: 'term-1' }, 1_000_000)
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(addSpy).toHaveBeenCalledWith({
      type: 'success',
      category: 'task',
      title: '重构通知模块',
      body: '已完成',
      action: 'terminal',
      actionPayload: 'term-1',
    })
  })

  it('幂等：同 terminalId+status 短窗口重复 done 只入账一次，窗口外再次放行', () => {
    stubNotificationCtor()
    handleAgentTaskProgressNotify({ task: '任务A', status: 'done', terminalId: 'term-1' }, 1_000_000)
    handleAgentTaskProgressNotify({ task: '任务A', status: 'done', terminalId: 'term-1' }, 1_000_100)
    expect(addSpy).toHaveBeenCalledTimes(1)
    handleAgentTaskProgressNotify({ task: '任务A', status: 'done', terminalId: 'term-1' }, 1_003_500)
    expect(addSpy).toHaveBeenCalledTimes(2)
  })

  it('failed → error 级；无 terminalId 则无跳转 action、身份回退任务名', () => {
    stubNotificationCtor()
    handleAgentTaskProgressNotify({ task: '任务B', status: 'failed' }, 2_000_000)
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', category: 'task', title: '任务B', action: undefined })
    )
    // 页面可见（jsdom 默认）时桌面通知由 useDesktopNotify 内部跳过——聚焦跳过用例单独锁定
  })

  it('耗时估算：先 running 后 done → 正文含（N.Ns）；无起点 → 不含耗时', () => {
    stubNotificationCtor()
    handleAgentTaskProgressNotify({ task: '任务C', status: 'running', terminalId: 'term-3' }, 3_000_000)
    handleAgentTaskProgressNotify({ task: '任务C', status: 'done', terminalId: 'term-3' }, 3_001_500)
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '任务C', body: '已完成（1.5s）' })
    )

    handleAgentTaskProgressNotify({ task: '任务D', status: 'done', terminalId: 'term-4' }, 3_002_000)
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '任务D', body: '已完成' })
    )
  })

  it('耗时起点为一次性消费：终态后同会话新任务从新 running 重新记起点', () => {
    expect(takeTaskElapsed('term-x', 10_000)).toBeNull()
    handleAgentTaskProgressNotify({ status: 'running', terminalId: 'term-x' }, 20_000)
    expect(takeTaskElapsed('term-x', 25_000)).toBe(5000)
    // 已清除：不重置起点则第二次取值返回旧耗时
    expect(takeTaskElapsed('term-x', 26_000)).toBeNull()
  })

  it('起点表封顶（200）逐出最早：被逐出会话的终态正文不含耗时（无起点不虚构）', () => {
    // 201 个不同会话先报 running → 最先记起点的 term-s0 被逐出
    for (let i = 0; i <= 200; i++) {
      handleAgentTaskProgressNotify({ status: 'running', terminalId: `term-s${i}` }, 100_000 + i)
    }
    handleAgentTaskProgressNotify({ task: '任务S0', status: 'done', terminalId: 'term-s0' }, 105_000)
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '任务S0', body: '已完成' })
    )
  })

  it('聚焦跳过：页面可见不弹桌面通知，通知中心仍入账', () => {
    const ctorCalls = stubNotificationCtor()
    setDocumentHidden(false)
    handleAgentTaskProgressNotify({ task: '任务E', status: 'done', terminalId: 'term-5' }, 5_000_000)
    expect(ctorCalls).toHaveLength(0)
    expect(addSpy).toHaveBeenCalledTimes(1)
  })

  it('页面 hidden + 权限 granted → 弹桌面通知（标题/正文与中心条目一致）', () => {
    const ctorCalls = stubNotificationCtor()
    setDocumentHidden(true)
    handleAgentTaskProgressNotify({ task: '任务F', status: 'failed', terminalId: 'term-6' }, 6_000_000)
    expect(ctorCalls).toHaveLength(1)
    expect(ctorCalls[0]?.[0]).toBe('任务F')
    expect(ctorCalls[0]?.[1]).toMatchObject({ body: '已失败', data: { terminalId: 'term-6' } })
    expect(addSpy).toHaveBeenCalledTimes(1)
  })

  it('桌面通知透传 terminalId（P-20261004-121）：data 落档供点击直达；无归属上报不带 data', () => {
    const ctorCalls = stubNotificationCtor()
    setDocumentHidden(true)
    handleAgentTaskProgressNotify({ task: '任务T1', status: 'done', terminalId: 'term-t1' }, 8_000_000)
    handleAgentTaskProgressNotify({ task: '任务T2', status: 'done' }, 8_000_100)
    expect(ctorCalls).toHaveLength(2)
    expect(ctorCalls[0]?.[1]).toMatchObject({ data: { terminalId: 'term-t1' } })
    expect((ctorCalls[1]?.[1] as { data?: unknown }).data).toBeUndefined()
  })

  it('总开关关闭（desktopNotify=false）→ 通知中心入账但不弹桌面通知', () => {
    const ctorCalls = stubNotificationCtor()
    setDocumentHidden(true)
    const store = useNotificationStore()
    store.prefs.desktopNotify = false
    handleAgentTaskProgressNotify({ task: '任务G', status: 'done', terminalId: 'term-7' }, 7_000_000)
    expect(ctorCalls).toHaveLength(0)
    expect(addSpy).toHaveBeenCalledTimes(1)
  })

  it('任务事件子开关关闭（enabled.task=false）→ 中心与桌面双静默', () => {
    const ctorCalls = stubNotificationCtor()
    setDocumentHidden(true)
    const store = useNotificationStore()
    store.prefs.enabled.task = false
    handleAgentTaskProgressNotify({ task: '任务H', status: 'done', terminalId: 'term-8' }, 8_000_000)
    expect(addSpy).not.toHaveBeenCalled()
    expect(ctorCalls).toHaveLength(0)
  })

  it('useDesktopNotify 既有语义未被破坏：无 Notification API 时静默', () => {
    // 不 stub Notification（jsdom 无原生实现）→ 'Notification' in window 为 false
    setDocumentHidden(true)
    expect(() => useDesktopNotify().notify('t', 'b')).not.toThrow()
  })
})

describe('终态结论摘要（P-20261005-221）', () => {
  let addSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetAgentTaskNotifyStateForTest()
    useLockStore().isLocked = false
    addSpy = vi.spyOn(useNotificationStore(), 'add')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('done 携 summary → 正文追加「结论：」行（通知中心与桌面通知同 body）', () => {
    stubNotificationCtor()
    handleAgentTaskProgressNotify(
      { task: '修登录', status: 'done', terminalId: 'term-sum1', summary: '修复了登录超时并补齐回归测试' },
      1_000_000
    )
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({ body: '已完成\n结论：修复了登录超时并补齐回归测试' })
    )
  })

  it('failed 携 summary → 「现场：」行（排障第一现场）', () => {
    stubNotificationCtor()
    handleAgentTaskProgressNotify(
      { task: '跑测试', status: 'failed', terminalId: 'term-sum2', summary: 'npm ERR! Test failed. See log for details.' },
      2_000_000
    )
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('\n现场：npm ERR! Test failed') })
    )
  })

  it('无 summary（旧上报/远程回流）保持纯状态体不硬凑；纯空白同纯状态', () => {
    stubNotificationCtor()
    handleAgentTaskProgressNotify({ task: '任务N1', status: 'done', terminalId: 'term-n1' }, 3_000_000)
    handleAgentTaskProgressNotify({ task: '任务N2', status: 'done', terminalId: 'term-n2', summary: '   \n ' }, 3_000_100)
    expect(addSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ body: '已完成' }))
    expect(addSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ body: '已完成' }))
  })

  it('clipNotifySummary：多行归一单行 + rune 截断（100 rune 封顶 + … 标注）', () => {
    expect(clipNotifySummary(undefined)).toBe('')
    expect(clipNotifySummary('第一行\n\n第二行\t制表')).toBe('第一行 第二行 制表')
    const long = '结'.repeat(120)
    const clipped = clipNotifySummary(long)
    expect(Array.from(clipped)).toHaveLength(101) // 100 rune + …
    expect(clipped.endsWith('…')).toBe(true)
  })

  it('clipNotifySummary 遮蔽兜底：token 赋值形态在展示装配内被遮蔽（外发面从严）', () => {
    // 夹具 token 刻意 14 位：够触发遮蔽（sc?_ 前缀 + 1 位起）即可，不凑发布敏感
    // 扫描「真实 token ≥16 位」的模式门槛（release-scan.sh），夹具非真凭证
    expect(clipNotifySummary('部署完成 token=sc_abcd1234efgh56 已上线')).toBe('部署完成 token=*** 已上线')
  })
})
