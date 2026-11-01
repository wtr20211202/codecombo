import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// 通知 WS 选项捕获器：测试里手动触发 onOpen 模拟断线重连
const wsCaptured = vi.hoisted(() => ({ options: null as any }))
vi.mock('../composables/useWebSocketBase', () => ({
  useWebSocketBase: vi.fn((options: any) => {
    wsCaptured.options = options
    return { connected: { value: true }, connect: vi.fn(), disconnect: vi.fn() }
  }),
  // P-20261005-185 导出面：长退避提示注册槽（本文件不触发 1009/1011，仅保 mock 面完整）
  WS_CLOSE_MESSAGE_TOO_BIG: 1009,
  registerWsLongBackoffNotifier: vi.fn(),
}))

// 通知域 API 全量 mock：store 只依赖 notificationApi + WS URL + 实例上下文
vi.mock('../api/client', () => ({
  notificationApi: {
    list: vi.fn(),
    add: vi.fn(),
    getPrefs: vi.fn(),
    updatePrefs: vi.fn(),
    readAll: vi.fn(),
    readOne: vi.fn(),
    dismiss: vi.fn(),
    dismissMany: vi.fn(),
    snooze: vi.fn(),
    clear: vi.fn(),
  },
  getNotificationWsUrl: () => 'ws://notifications',
  getCurrentInstanceContext: () => ({ instanceId: 'inst-1' }),
}))

vi.mock('./lock', () => ({
  useLockStore: () => ({ isLocked: { value: false } }),
  UNLOCK_TOKEN_KEY: 'sc-unlock-token',
}))

vi.mock('../utils/storage', () => ({
  safeStorage: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() },
}))

vi.mock('../i18n', () => ({
  default: { global: { t: (k: string) => k } },
}))

// 第二动作派发链（P-20261005-150）触发 handleClick 的路由桥接尾部（动态
// import('../router')）——jsdom 下真 router 无法构造（previewPortNotify.test
// 同款 mock），桩掉路由面让桥接尾部静默收口；首页跳转分支由 e2e 兜底
vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'project' } },
    push: vi.fn(async () => {}),
  },
}))

import { notificationApi } from '../api/client'
import { useNotificationStore } from './notification'

const mockedApi = vi.mocked(notificationApi, true)

/** 统一包一层响应形态：axios 拦截器返回 gin body，业务负载在 res.data（真实形态） */
function apiRes<T>(data: T) {
  return Promise.resolve({ data }) as any
}

function notif(id: string, title = id) {
  return { id, type: 'info', category: 'system', title, time: '2026-01-01T00:00:00Z', read: false }
}

beforeEach(() => {
  vi.resetAllMocks()
  // getPrefs 统一走拒绝分支（init 的 catch → null → 默认偏好），测试不关心偏好形态
  mockedApi.getPrefs.mockRejectedValue(new Error('skip prefs') as any)
  setActivePinia(createPinia())
  wsCaptured.options = null
})

describe('notification store', () => {
  it('loadHistory 按 id 合并：快照外的实时送达/本地条目不被整体替换丢掉', async () => {
    mockedApi.list.mockReturnValue(apiRes([notif('srv-1'), notif('srv-2')]) as any)
    const store = useNotificationStore()
    // 模拟历史拉取发起前已存在的条目：WS 实时送达的 + 纯本地插入的
    store.items.push(notif('ws-live') as any, notif('local-1') as any)
    await store.init()

    const ids = store.items.map(n => n.id)
    expect(ids).toContain('srv-1')
    expect(ids).toContain('srv-2')
    expect(ids).toContain('ws-live')
    expect(ids).toContain('local-1')
  })

  it('WS 重连成功（attempts>0）补拉历史：断线窗口期落库的通知回到列表', async () => {
    mockedApi.list.mockReturnValue(apiRes([notif('srv-1')]) as any)
    const store = useNotificationStore()
    await store.init()
    expect(store.items.map(n => n.id)).toEqual(['srv-1'])

    // 模拟系统更新重启窗口期：WS 断开期间"系统更新完成"落库，重连后才可见
    mockedApi.list.mockReturnValue(apiRes([notif('srv-done'), notif('srv-1')]) as any)
    wsCaptured.options.onOpen(3)
    await new Promise(r => setTimeout(r, 0))

    expect(mockedApi.list).toHaveBeenCalledTimes(2)
    expect(store.items.map(n => n.id)).toEqual(['srv-done', 'srv-1'])
  })

  it('WS 首次连接（attempts=0）也补拉：handleRecovery 会归零 attempts 重连，升级重启窗口期恰逢切标签页时不得漏拉（按 id 合并幂等）', async () => {
    mockedApi.list.mockReturnValue(apiRes([]) as any)
    const store = useNotificationStore()
    await store.init()
    wsCaptured.options.onOpen(0)
    await new Promise(r => setTimeout(r, 0))
    expect(mockedApi.list).toHaveBeenCalledTimes(2)
  })

  it('snooze 打标/取消：本地先行改 snoozeUntil，API 收到相同载荷', async () => {
    mockedApi.snooze.mockResolvedValue({} as any)
    const store = useNotificationStore()
    store.items.push(notif('n-1') as any)

    await store.snooze('n-1', '2026-10-04T12:00:00Z')
    expect(store.items[0]?.snoozeUntil).toBe('2026-10-04T12:00:00Z')
    expect(mockedApi.snooze).toHaveBeenCalledWith('n-1', '2026-10-04T12:00:00Z', { silent: true })

    // 取消 = 空串：本地清字段（undefined），API 收空串
    await store.snooze('n-1', '')
    expect(store.items[0]?.snoozeUntil).toBeUndefined()
    expect(mockedApi.snooze).toHaveBeenLastCalledWith('n-1', '', { silent: true })
  })

  it('延后中的条目不计未读徽标，服务端重挂（清标记）恢复计数', async () => {
    const store = useNotificationStore()
    store.items.push({ ...notif('n-1'), snoozeUntil: '9999-01-01T00:00:00Z' } as any)
    expect(store.unreadCount).toBe(0) // 延后中沉默

    // 已过期的标记仍在位 = 仍在延后（到期到服务端巡检重挂之间的空窗不按墙钟
    // 提前弹回——重挂的未读/置顶语义由服务端统一给，标记不清就不回来）
    store.items[0]!.snoozeUntil = '2000-01-01T00:00:00Z'
    expect(store.unreadCount).toBe(0)

    // 服务端重挂 = 清标记（snoozeDue 推送的条目不带 snoozeUntil）：回到未读计数
    delete (store.items[0] as Record<string, unknown>).snoozeUntil
    expect(store.unreadCount).toBe(1)
  })

  it('WS snoozeDue 到点重挂：同 id 替换置顶且不重复入账，标记供桌面通知 watch 消费', () => {
    const store = useNotificationStore()
    store.items.push(notif('top-a') as any, notif('snoozed') as any)

    const remounted = { ...notif('snoozed'), read: false, time: '2026-10-04T12:00:00Z', snoozeUntil: undefined }
    wsCaptured.options.onMessage({ data: JSON.stringify({ type: 'notification.snoozeDue', notification: remounted }) })

    // 同 id 只保留一条且置顶；notification.new 路径的重复入账不复现
    expect(store.items.map(n => n.id)).toEqual(['snoozed', 'top-a'])
    expect(store.items.filter(n => n.id === 'snoozed')).toHaveLength(1)

    // 重挂标记一次性消费：桌面通知 watch 首次命中跳过、再次查询不命中
    expect(store.consumeRemount('snoozed')).toBe(true)
    expect(store.consumeRemount('snoozed')).toBe(false)
  })

  it('notification.new 路径不产生重挂标记：新通知照常触发桌面通知 watch', () => {
    const store = useNotificationStore()
    wsCaptured.options.onMessage({ data: JSON.stringify({ type: 'notification.new', notification: notif('fresh') }) })
    expect(store.consumeRemount('fresh')).toBe(false)
  })

  // 项目×类别二维静音（P-20261003-168）：add/addLocal 前端预判跳过静音组合
  //（服务端 Add 判定点为权威，此处免掉注定被丢弃的 POST），其余组合照常
  it('项目静音：静音组合的 add 不再 POST，同项目异类别照常', async () => {
    mockedApi.updatePrefs.mockResolvedValue({} as any)
    const store = useNotificationStore()
    store.prefs.projectMutes = [{ projectId: 'p1', category: 'task' }]

    await store.add({ type: 'info', category: 'task', title: 'muted', projectId: 'p1' } as any)
    expect(mockedApi.add).not.toHaveBeenCalled()

    await store.add({ type: 'info', category: 'git', title: 'other-cat', projectId: 'p1' } as any)
    await store.add({ type: 'info', category: 'task', title: 'other-proj', projectId: 'p2' } as any)
    expect(mockedApi.add).toHaveBeenCalledTimes(2)
  })

  it('muteProjectCategory 追加静音并整体保存；重复静音幂等跳过', async () => {
    mockedApi.updatePrefs.mockResolvedValue({} as any)
    const store = useNotificationStore()

    await store.muteProjectCategory('p1', 'task')
    expect(store.prefs.projectMutes).toEqual([{ projectId: 'p1', category: 'task' }])
    expect(mockedApi.updatePrefs).toHaveBeenCalledTimes(1)

    // 幂等：同组合再静音不重复追加、不再发请求
    await store.muteProjectCategory('p1', 'task')
    expect(store.prefs.projectMutes).toEqual([{ projectId: 'p1', category: 'task' }])
    expect(mockedApi.updatePrefs).toHaveBeenCalledTimes(1)
  })

  it('isProjectMuted：空 projectId 恒 false，存量偏好缺 projectMutes 字段按空清单兜底', () => {
    const store = useNotificationStore()
    delete (store.prefs as Partial<typeof store.prefs>).projectMutes

    expect(store.isProjectMuted(undefined, 'task')).toBe(false)
    expect(store.isProjectMuted('p1', 'task')).toBe(false)
  })

  it('init 拉取偏好归一 projectMutes：服务端 omitempty 省字段时补空数组（防设置页 isDirty 假阳性）', async () => {
    // getPrefs 的 gin 响应体即偏好对象本身（无 {data} 包装），mock 直接 resolve 对象
    mockedApi.getPrefs.mockResolvedValue({
      enabled: { git: true },
      longTaskThresholdMs: 5000,
      desktopNotify: true,
      webhook: { enabled: false, mode: 'post', url: '', scope: 'important' },
      longSessionNotifySec: 300,
      // 服务端对空清单省字段（omitempty）：响应体无 projectMutes 键
    } as any)
    const store = useNotificationStore()
    await store.init()

    // 补空数组且键序稳定：设置页 localPrefs 深比较两侧 JSON 一致，开页不即脏
    expect(store.prefs.projectMutes).toEqual([])
    expect(Object.keys(store.prefs)).toContain('projectMutes')

    // 服务端带清单时原样保留
    mockedApi.getPrefs.mockResolvedValue({
      enabled: { git: true },
      longTaskThresholdMs: 5000,
      desktopNotify: true,
      webhook: { enabled: false, mode: 'post', url: '', scope: 'important' },
      longSessionNotifySec: 300,
      projectMutes: [{ projectId: 'p1', category: 'task' }],
    } as any)
    await store.init()
    expect(store.prefs.projectMutes).toEqual([{ projectId: 'p1', category: 'task' }])
  })
})

// 第二动作派发（P-20261005-150）：换槽复用 handleClick 同链——已读打标 +
// 关面板 + pendingAction 携第二动作载荷；无第二动作的条目入口不可达（防御早退）
describe('notification store handleSecondAction', () => {
  it('携 secondAction 的条目：动作槽位换成第二动作进 pendingAction，标已读并关面板', async () => {
    mockedApi.readOne.mockResolvedValue(apiRes({ ok: true }) as any)
    const store = useNotificationStore()
    store.items = [{
      ...notif('n-1', '哨兵命中：OOM'),
      projectId: 'p1',
      action: 'terminal',
      actionPayload: 'term-1',
      secondAction: 'agent-fix',
      secondActionPayload: 'sentinel:term-1',
    }] as any
    await store.handleSecondAction(store.items[0]!)
    expect(mockedApi.readOne).toHaveBeenCalledWith('n-1', { silent: true })
    expect(store.showPanel).toBe(false)
    expect(store.pendingAction).toMatchObject({
      id: 'n-1',
      action: 'agent-fix',
      actionPayload: 'sentinel:term-1',
    })
    store.consumeAction()
  })

  it('无 secondAction 的条目：零副作用早退', async () => {
    const store = useNotificationStore()
    store.items = [notif('n-2')] as any
    await store.handleSecondAction(store.items[0]!)
    expect(mockedApi.readOne).not.toHaveBeenCalled()
    expect(store.pendingAction).toBeNull()
    expect(store.showPanel).toBe(false)
  })
})
