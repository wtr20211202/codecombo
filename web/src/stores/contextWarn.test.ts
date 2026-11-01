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

import { CONTEXT_WARN_MAX, CONTEXT_WARN_MIN, CONTEXT_WARN_STORAGE_KEY, useContextWarnStore } from './contextWarn'
import { LOW_REMAINING_PCT } from '../utils/sessionRelay'

beforeEach(() => {
  backing.getItem.mockClear()
  backing.setItem.mockClear()
  backing.removeItem.mockClear()
  setActivePinia(createPinia())
})

describe('contextWarn 上下文警示阈值（P-20261006-33 设备本地偏好）', () => {
  it('缺 key 回落出厂档 10（=P-141 现行为），初始化不写存储', () => {
    const store = useContextWarnStore()
    expect(store.pct).toBe(LOW_REMAINING_PCT)
    expect(LOW_REMAINING_PCT).toBe(10)
    expect(backing.setItem).not.toHaveBeenCalled()
  })

  it('set(20) 即时生效并落存储；档位边界常量 5-30 与滑条 min/max 同源', () => {
    const store = useContextWarnStore()
    expect(CONTEXT_WARN_MIN).toBe(5)
    expect(CONTEXT_WARN_MAX).toBe(30)
    store.set(20)
    expect(store.pct).toBe(20)
    expect(backing.setItem).toHaveBeenCalledWith(CONTEXT_WARN_STORAGE_KEY, '20')
  })

  it('set(出厂档) 清 key 回归缺省跟随（同 sound.ts 惯例）', () => {
    const store = useContextWarnStore()
    store.set(20)
    store.set(10)
    expect(store.pct).toBe(10)
    expect(backing.removeItem).toHaveBeenCalledWith(CONTEXT_WARN_STORAGE_KEY)
  })

  it('set 越界钳制在档位内（滑条外的手改输入不把警示打歪）', () => {
    const store = useContextWarnStore()
    store.set(99)
    expect(store.pct).toBe(CONTEXT_WARN_MAX)
    store.set(1)
    expect(store.pct).toBe(CONTEXT_WARN_MIN)
    store.set(Number.NaN)
    expect(store.pct).toBe(LOW_REMAINING_PCT)
  })

  it('重启后恢复上次档位（store 初始化读标记）', () => {
    backing.getItem.mockReturnValue('25')
    expect(useContextWarnStore().pct).toBe(25)
  })

  it('损坏/越界残留值回落出厂档（fail-closed 到现行为）', () => {
    backing.getItem.mockReturnValue('abc')
    expect(useContextWarnStore().pct).toBe(LOW_REMAINING_PCT)
    setActivePinia(createPinia())
    backing.getItem.mockReturnValue('40')
    expect(useContextWarnStore().pct).toBe(LOW_REMAINING_PCT)
    setActivePinia(createPinia())
    backing.getItem.mockReturnValue(null)
    expect(useContextWarnStore().pct).toBe(LOW_REMAINING_PCT)
  })
})
