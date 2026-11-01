import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphLanesStore, GRAPH_LANE_LIMITS, GRAPH_LANE_LIMIT_DEFAULT, GRAPH_LANE_STORAGE_KEY } from './graph-lanes'

// 提交拓扑泳道上限 store（P-20261006-29）：safeStorage 自有键持久化（ui-zoom
// 同款链路），档位白名单外脏值回落默认 16（= 历史硬编码行为零变化）。

describe('graph-lanes store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('初始默认 16（历史硬编码行为零变化）', () => {
    const store = useGraphLanesStore()
    expect(store.limit).toBe(GRAPH_LANE_LIMIT_DEFAULT)
    expect(GRAPH_LANE_LIMITS).toEqual([8, 16, 24, 32])
  })

  it('setLimit 落 safeStorage 自有键并即时生效', () => {
    const store = useGraphLanesStore()
    store.setLimit(32)
    expect(store.limit).toBe(32)
    expect(JSON.parse(localStorage.getItem(GRAPH_LANE_STORAGE_KEY) || '{}')?.limit).toBe(32)
  })

  it('重读恢复已存档位（新 pinia 实例 = 模拟重开应用）', () => {
    useGraphLanesStore().setLimit(8)
    setActivePinia(createPinia())
    expect(useGraphLanesStore().limit).toBe(8)
  })

  it('脏值回落默认档（手改 localStorage 不崩不越权）', () => {
    localStorage.setItem(GRAPH_LANE_STORAGE_KEY, JSON.stringify({ limit: 999 }))
    setActivePinia(createPinia())
    expect(useGraphLanesStore().limit).toBe(GRAPH_LANE_LIMIT_DEFAULT)
    localStorage.setItem(GRAPH_LANE_STORAGE_KEY, 'not-json')
    setActivePinia(createPinia())
    expect(useGraphLanesStore().limit).toBe(GRAPH_LANE_LIMIT_DEFAULT)
  })

  it('load() 静默重读（settingsSync 跨标签回读入口）', () => {
    const store = useGraphLanesStore()
    expect(store.limit).toBe(GRAPH_LANE_LIMIT_DEFAULT)
    localStorage.setItem(GRAPH_LANE_STORAGE_KEY, JSON.stringify({ limit: 24 }))
    store.load()
    expect(store.limit).toBe(24)
  })
})
