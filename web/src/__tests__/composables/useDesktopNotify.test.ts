import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useDesktopNotify } from '@/composables/useDesktopNotify'
import { OPS_ACTIVATE_TERMINAL } from '@/utils/opsEvents'
import { useLockStore } from '@/stores/lock'
import { useDndStore } from '@/stores/dnd'
import { useNotifySimpleStore } from '@/stores/notifySimple'

// 桌面通知 composable 发送前置门控矩阵：锁定静默（P-20261003-5，隐私硬门——
// 锁屏上弹出桌面通知即内容泄露）+ 免打扰时段（P-20261002-40）+ 精简模式
// （P-20261003-90，内容泛化不吞通知）+ error 级穿透（P-20261004-117，type 豁免
// 勿扰、不越锁定/精简）+ 权限/可见性既有语义。锁定/免打扰均为
// 「只吞打扰不吞账目」：入账链在 store.add / addLocal，不经本函数——中心可见性
// 由 e2e lock-notify-mute.spec 走真实应用覆盖

// 桌面通知构造器替身：记录调用入参 + 实例（instances 供点击直达用例触发
// onclick，P-20261004-121），permission 预置 granted，agentTaskNotify.test 同款
function stubNotificationCtor(): { calls: Array<[string, unknown]>; instances: Array<{ onclick?: (e?: Event) => void }> } {
  const calls: Array<[string, unknown]> = []
  const instances: Array<{ onclick?: (e?: Event) => void }> = []
  class FakeNotification {
    static permission = 'granted'
    onclick?: (e?: Event) => void
    constructor(title: string, opts?: unknown) {
      calls.push([title, opts])
      instances.push(this)
    }
    close() { /* noop */ }
  }
  vi.stubGlobal('Notification', FakeNotification)
  return { calls, instances }
}

// jsdom 的 document.hidden 默认 false（可见）；用例内按需切换
function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

describe('useDesktopNotify 发送前置门控', () => {
  // 免打扰用例的「窗口内」锚定：本组大量用例窗口 end:'23:59'，而 isWithinDnd
  // 是分钟精度半开区间 [start, end)（utils/dndSchedule.ts）——墙钟走到 23:59
  // 这一分钟时窗口恰好不活跃，「应静默」用例全数假红（2026-10-14 0 点前编排
  // 门禁实测 7 例）。钉在窗口正午，跑点无关；notify 生产路径不发计时器（5s
  // 自动 close 是构造后挂账，断言面只看同步构造调用），假钟无副作用
  // （utils/alertSound.test.ts pinClockInsideWindow 同款先例）
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 15, 10, 30))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (document as unknown as { hidden?: boolean }).hidden
  })

  it('锁定态：hidden+granted 也不弹（隐私硬门）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = true
    useDesktopNotify().notify('测试通知', '不应弹出')
    expect(calls).toHaveLength(0)
  })

  it('解锁态同条件放行（负对照：抑制确由锁定门吞掉）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useDesktopNotify().notify('测试通知', '桌面通知链路正常')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('测试通知')
    expect(calls[0]?.[1]).toMatchObject({ body: '桌面通知链路正常' })
  })

  it('解锁 + 免打扰时段内：静默（P-20261002-40 语义不回归）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('t', 'b')
    expect(calls).toHaveLength(0)
  })

  it('解锁 + 页面可见：不弹（既有聚焦跳过语义）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(false)
    useLockStore().isLocked = false
    useDesktopNotify().notify('t', 'b')
    expect(calls).toHaveLength(0)
  })

  it('精简模式开启：title 泛化为「新通知」，body 不外带（P-20261003-90）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useNotifySimpleStore().set(true)
    // 模拟部署错误通知：标题含文件路径、正文含错误摘要——精简后均不可见
    useDesktopNotify().notify('部署失败: /srv/app/main.go:42', 'connect refused 10.0.0.5:5432')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('新通知')
    expect((calls[0]?.[1] as { body?: string }).body).toBeUndefined()
  })

  it('精简模式不绕过免打扰（门控顺序：精简→免打扰→锁态）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useNotifySimpleStore().set(true)
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('t', 'b')
    expect(calls).toHaveLength(0)
  })

  it('免打扰时段内例外类别（approval）：穿透弹出（P-20261003-115）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    // set 不带 except → 归一化补默认 ['approval']
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('审批等待', 'agent 干等裁决', 'approval')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('审批等待')
  })

  it('免打扰时段内 error 级：穿透弹出（P-20261004-117，警报可达性）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    // 夜间任务失败：task 类别不在默认例外表，靠 type 豁免穿透
    useDesktopNotify().notify('任务失败: build', 'exit 1（32.5s）', 'task', 'error')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('任务失败: build')
  })

  it('免打扰时段内 warning 级：照旧静默（类型豁免只认 error）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('编队完成: 2 成功 1 失败', 'batch-a', 'task', 'warning')
    expect(calls).toHaveLength(0)
  })

  it('免打扰 + exceptError 关：error 级也静默（绝对静默是合法偏好）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59', exceptError: false })
    useDesktopNotify().notify('任务失败: build', 'exit 1', 'task', 'error')
    expect(calls).toHaveLength(0)
  })

  it('error 穿透不免除锁定（锁态硬门在豁免之后，锁屏内容泄露面不让步）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = true
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('部署失败: /srv/app/main.go:42', 'connect refused', 'system', 'error')
    expect(calls).toHaveLength(0)
  })

  it('error 穿透不免除精简（例外只在免打扰门内放行，内容泛化照常）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useNotifySimpleStore().set(true)
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('部署失败: /srv/app/main.go:42', 'connect refused 10.0.0.5:5432', 'system', 'error')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('新通知')
    expect((calls[0]?.[1] as { body?: string }).body).toBeUndefined()
  })

  it('category=error 但不携带 type：不参与类型豁免（分级语义在 type 不在 category 名）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('历史错误回执', 'b', 'error')
    expect(calls).toHaveLength(0)
  })

  it('免打扰时段内非例外类别（task）：照旧静默', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('任务完成', '3.2s', 'task')
    expect(calls).toHaveLength(0)
  })

  it('免打扰时段内无类别：不参与例外，维持整体静默（ops-notify 等无归属消息）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('t', 'b')
    expect(calls).toHaveLength(0)
  })

  it('例外穿透不免除精简（例外只在免打扰门内放行，内容隐私与注意力正交）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useNotifySimpleStore().set(true)
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('审批等待', 'push --force 到 production', 'approval')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('新通知')
    expect((calls[0]?.[1] as { body?: string }).body).toBeUndefined()
  })

  it('免打扰未启用：例外类别照常弹出（例外只在时段内有意义）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useDndStore().set({ enabled: false, start: '00:00', end: '23:59' })
    useDesktopNotify().notify('t', 'b', 'approval')
    expect(calls).toHaveLength(1)
  })

  it('精简模式关闭恢复完整内容（默认关=完整内容，开/关可逆）', () => {
    const { calls } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    useNotifySimpleStore().set(true)
    useNotifySimpleStore().set(false)
    useDesktopNotify().notify('完整标题', '完整正文')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('完整标题')
    expect(calls[0]?.[1]).toMatchObject({ body: '完整正文' })
  })
})

// 点击会话直达（P-20261004-121）：通知携带 terminalId 时 onclick 在聚焦窗口后
// 派发与在册卡「查看会话」同款 OPS_ACTIVATE_TERMINAL 激活广播——回拉信号最后
// 一米；无归属不传维持现状语义（仅聚焦）。门控矩阵（锁定/免打扰/精简）由上方
// 既有用例覆盖，本组只锁点击行为
describe('useDesktopNotify 点击会话直达（P-20261004-121）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (document as unknown as { hidden?: boolean }).hidden
  })

  it('携带 terminalId：data 落档；onclick → 窗口聚焦 + OPS_ACTIVATE_TERMINAL（detail.id=terminalId）', () => {
    const { calls, instances } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {})
    const activated: Array<string | undefined> = []
    const onActivate = (e: Event) => activated.push((e as CustomEvent<{ id?: string }>).detail?.id)
    window.addEventListener(OPS_ACTIVATE_TERMINAL, onActivate)
    try {
      useDesktopNotify().notify('任务完成', '2.0s', 'task', 'success', 'term-9')
      expect(calls).toHaveLength(1)
      expect((calls[0]?.[1] as { data?: unknown }).data).toEqual({ terminalId: 'term-9' })
      const n = instances[0]
      expect(n).toBeDefined()
      n.onclick?.(new Event('click'))
      expect(focusSpy).toHaveBeenCalledTimes(1)
      expect(activated).toEqual(['term-9'])
    } finally {
      window.removeEventListener(OPS_ACTIVATE_TERMINAL, onActivate)
      focusSpy.mockRestore()
    }
  })

  it('无归属不传 terminalId：data 不落档；onclick 仅聚焦窗口，不派发激活事件（现状语义保持）', () => {
    const { calls, instances } = stubNotificationCtor()
    setDocumentHidden(true)
    useLockStore().isLocked = false
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {})
    const activated: Array<string | undefined> = []
    const onActivate = (e: Event) => activated.push((e as CustomEvent<{ id?: string }>).detail?.id)
    window.addEventListener(OPS_ACTIVATE_TERMINAL, onActivate)
    try {
      useDesktopNotify().notify('t', 'b')
      expect(calls).toHaveLength(1)
      expect((calls[0]?.[1] as { data?: unknown }).data).toBeUndefined()
      const n = instances[0]
      expect(n).toBeDefined()
      n.onclick?.(new Event('click'))
      expect(focusSpy).toHaveBeenCalledTimes(1)
      expect(activated).toEqual([])
    } finally {
      window.removeEventListener(OPS_ACTIVATE_TERMINAL, onActivate)
      focusSpy.mockRestore()
    }
  })
})
