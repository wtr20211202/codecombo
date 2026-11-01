import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// safeStorage mock：Map 兜底语义同 utils/storage 的内存路径
const backing = vi.hoisted(() => {
  const m = new Map<string, string>()
  return {
    getItem: vi.fn((k: string) => (m.has(k) ? (m.get(k) as string) : null)),
    setItem: vi.fn((k: string, v: string) => { m.set(k, v) }),
    removeItem: vi.fn((k: string) => { m.delete(k) }),
  }
})

vi.mock('../utils/storage', () => ({
  safeStorage: backing,
}))

import { NOTIFY_SCROLL_READ_STORAGE_KEY, useNotifyScrollReadStore } from './notifyScrollRead'

beforeEach(() => {
  backing.getItem.mockClear()
  backing.setItem.mockClear()
  backing.removeItem.mockClear()
  setActivePinia(createPinia())
})

describe('notifyScrollRead 滚动自动已读开关（P-20261003-260）', () => {
  it('默认关：缺 key 时 enabled=false 且不写存储', () => {
    const store = useNotifyScrollReadStore()
    expect(store.enabled).toBe(false)
    expect(backing.setItem).not.toHaveBeenCalled()
    expect(backing.removeItem).not.toHaveBeenCalled()
  })

  it('set(true) 即时生效并落存储哨兵值 1', () => {
    const store = useNotifyScrollReadStore()
    store.set(true)
    expect(store.enabled).toBe(true)
    expect(backing.setItem).toHaveBeenCalledWith(NOTIFY_SCROLL_READ_STORAGE_KEY, '1')
  })

  it('set(false) 回归默认并清 key（翻转默认值自动跟随）', () => {
    const store = useNotifyScrollReadStore()
    store.set(true)
    store.set(false)
    expect(store.enabled).toBe(false)
    expect(backing.removeItem).toHaveBeenCalledWith(NOTIFY_SCROLL_READ_STORAGE_KEY)
  })

  it('已开启的浏览器重启后恢复开（store 初始化读标记）', () => {
    backing.getItem.mockReturnValue('1')
    const store = useNotifyScrollReadStore()
    expect(store.enabled).toBe(true)
  })

  it('损坏值按关兜底（fail-open 方向与「默认手动」一致）', () => {
    backing.getItem.mockReturnValue('true')
    expect(useNotifyScrollReadStore().enabled).toBe(false)
    setActivePinia(createPinia())
    backing.getItem.mockReturnValue('')
    expect(useNotifyScrollReadStore().enabled).toBe(false)
  })
})
