import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useNotificationStore } from '@/stores/notification'
import { notificationApi } from '@/api/client'

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual('@/api/client')
  return {
    ...(actual as object),
    notificationApi: {
      list: vi.fn(),
      add: vi.fn(),
      readAll: vi.fn(),
      readOne: vi.fn(),
      dismiss: vi.fn(),
      dismissMany: vi.fn(),
      clear: vi.fn(),
      getPrefs: vi.fn(),
      updatePrefs: vi.fn(),
    },
    getNotificationWsUrl: vi.fn(() => 'ws://localhost/ws/notifications'),
  }
})

describe('notificationStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('初始状态', () => {
    const store = useNotificationStore()
    expect(store.items).toEqual([])
    expect(store.showPanel).toBe(false)
    expect(store.unreadCount).toBe(0)
  })

  it('addLocal 插入本地通知', () => {
    const store = useNotificationStore()
    store.addLocal({ type: 'info', category: 'git', title: 'test' })
    expect(store.items).toHaveLength(1)
    expect(store.items[0]?.title).toBe('test')
    expect(store.items[0]?.read).toBe(false)
  })

  it('addLocal 在分类禁用时不插入', () => {
    const store = useNotificationStore()
    store.prefs.enabled.git = false
    store.addLocal({ type: 'info', category: 'git', title: 'test' })
    expect(store.items).toHaveLength(0)
  })

  it('markAllRead 标记所有为已读', async () => {
    const store = useNotificationStore()
    store.addLocal({ type: 'info', category: 'git', title: 't1' })
    store.addLocal({ type: 'info', category: 'git', title: 't2' })
    await store.markAllRead()
    expect(store.items.every(n => n.read)).toBe(true)
  })

  it('dismiss 移除通知', async () => {
    const store = useNotificationStore()
    store.addLocal({ type: 'info', category: 'git', title: 't1' })
    const id = store.items[0]!.id
    await store.dismiss(id)
    expect(store.items).toHaveLength(0)
  })

  it('dismissMany 批量移除并调批量接口', async () => {
    const store = useNotificationStore()
    store.addLocal({ type: 'info', category: 'git', title: 't1' })
    store.addLocal({ type: 'info', category: 'git', title: 't2' })
    store.addLocal({ type: 'info', category: 'git', title: 'keep' })
    const ids = store.items.filter(n => n.title !== 'keep').map(n => n.id)
    await store.dismissMany(ids)
    expect(store.items.map(n => n.title)).toEqual(['keep'])
    expect(notificationApi.dismissMany).toHaveBeenCalledWith(ids, { silent: true })
  })

  it('dismissMany 单条降级为 dismiss', async () => {
    const store = useNotificationStore()
    store.addLocal({ type: 'info', category: 'git', title: 't1' })
    const id = store.items[0]!.id
    await store.dismissMany([id])
    expect(store.items).toHaveLength(0)
    expect(notificationApi.dismiss).toHaveBeenCalledWith(id, { silent: true })
    expect(notificationApi.dismissMany).not.toHaveBeenCalled()
  })

  it('dismissMany 空列表直接返回', async () => {
    const store = useNotificationStore()
    await store.dismissMany([])
    expect(notificationApi.dismissMany).not.toHaveBeenCalled()
  })

  it('clear 清空所有通知', async () => {
    const store = useNotificationStore()
    store.addLocal({ type: 'info', category: 'git', title: 't1' })
    store.addLocal({ type: 'info', category: 'git', title: 't2' })
    await store.clear()
    expect(store.items).toHaveLength(0)
  })

  it('open/close/toggle 控制面板显示', () => {
    const store = useNotificationStore()
    store.open()
    expect(store.showPanel).toBe(true)
    store.toggle()
    expect(store.showPanel).toBe(false)
    store.toggle()
    expect(store.showPanel).toBe(true)
    store.close()
    expect(store.showPanel).toBe(false)
  })

  it('addLocal 限制列表最多 200 条', () => {
    const store = useNotificationStore()
    for (let i = 0; i < 250; i++) {
      store.addLocal({ type: 'info', category: 'git', title: `n${i}` })
    }
    expect(store.items.length).toBeLessThanOrEqual(200)
  })
})
