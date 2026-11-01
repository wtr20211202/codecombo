import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useLayoutLockStore } from '@/stores/layoutLock'

// 布局锁定 store 单测（P-20261003-180）：toggle 即时落盘 / interceptDrag 统一
// 短路语义 / body 类随动（CSS 反馈面唯一挂点）/ bootstrap 快照恢复形状防御。
// 拖拽 handler 侧的接线（各 splitter/tab/树入口）由 e2e layout-lock.spec 覆盖
const saveLayoutLocked = vi.hoisted(() => vi.fn())
vi.mock('@/stores/uiState', () => ({
  useUIStateStore: () => ({ saveLayoutLocked }),
}))

describe('layoutLock store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    saveLayoutLocked.mockReset()
    saveLayoutLocked.mockResolvedValue(undefined)
    document.body.classList.remove('sc-layout-locked')
  })

  it('toggle 即时落盘：开→locked+saveLayoutLocked(true)，关→归位+save(false)', () => {
    const store = useLayoutLockStore()
    expect(store.locked).toBe(false)
    store.toggle()
    expect(store.locked).toBe(true)
    expect(saveLayoutLocked).toHaveBeenCalledWith(true)
    store.toggle()
    expect(store.locked).toBe(false)
    expect(saveLayoutLocked).toHaveBeenCalledWith(false)
  })

  it('persist 失败静默：状态仍翻转（会话内生效，下次 toggle 重试）', async () => {
    saveLayoutLocked.mockRejectedValue(new Error('network down'))
    const store = useLayoutLockStore()
    store.toggle()
    await Promise.resolve()
    expect(store.locked).toBe(true)
  })

  it('interceptDrag：未锁定放行（不碰事件），锁定时短路 + preventDefault', () => {
    const store = useLayoutLockStore()
    const ev = { preventDefault: vi.fn() }
    expect(store.interceptDrag(ev)).toBe(false)
    expect(ev.preventDefault).not.toHaveBeenCalled()
    store.setLocked(true)
    expect(store.interceptDrag(ev)).toBe(true)
    expect(ev.preventDefault).toHaveBeenCalledTimes(1)
    // 无事件形态（纯布尔查询的调用方）不炸
    expect(store.interceptDrag()).toBe(true)
  })

  it('body 类随动：锁定加 sc-layout-locked，解锁移除', async () => {
    // watch 默认 pre-flush（下一 tick 落 DOM）——类只做观感反馈，守卫读 locked 本值
    const { nextTick } = await import('vue')
    const store = useLayoutLockStore()
    store.setLocked(true)
    await nextTick()
    expect(document.body.classList.contains('sc-layout-locked')).toBe(true)
    store.setLocked(false)
    await nextTick()
    expect(document.body.classList.contains('sc-layout-locked')).toBe(false)
  })

  it('restoreFromState 形状防御：true 恢复锁定，非 true/缺键/ null 一律未锁定，且不回写', () => {
    const store = useLayoutLockStore()
    store.restoreFromState({ layoutLock: { locked: true } })
    expect(store.locked).toBe(true)
    store.restoreFromState({ layoutLock: { locked: 'yes' as unknown as boolean } })
    expect(store.locked).toBe(false)
    store.restoreFromState({ layoutLock: {} })
    expect(store.locked).toBe(false)
    store.restoreFromState(null)
    expect(store.locked).toBe(false)
    store.restoreFromState({ layoutLock: { locked: true } })
    expect(saveLayoutLocked).not.toHaveBeenCalled() // 恢复出的状态不是本页变更
  })
})
