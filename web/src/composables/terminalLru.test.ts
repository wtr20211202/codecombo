import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_LRU_KEEP, createTerminalLru } from './terminalLru'

// 终端 xterm LRU 记账（P-20261007-21）：预算执行只逐「不可见 + 最久未用」，
// 可见 pane 永不驱逐；释放动作委托会话自持的 evict 回调（本测以 spy 断言
// 驱逐目标与次数），注册/可见性翻转即执行预算（无定时器）。同毫秒注册的
// lastUsed 相等时按登记序稳定排序（mount 序 = 使用序，断言据此确定）
function evictSpyOf(log: string[], id: string) {
  return () => log.push(id)
}

describe('createTerminalLru', () => {
  it('预算常量起步值为 4', () => {
    expect(TERMINAL_LRU_KEEP).toBe(4)
  })

  it('预算内注册不驱逐；超额只逐最久未用的隐藏实例', () => {
    const lru = createTerminalLru()
    const log: string[] = []
    for (const id of ['a', 'b', 'c', 'd']) lru.register(id, evictSpyOf(log, id))
    expect(log).toEqual([])
    // 逐个转隐藏（注册 fail-open 可见，IO 回调修正）：预算未超仍不驱逐
    for (const id of ['a', 'b', 'c', 'd']) lru.setVisible(id, false)
    expect(log).toEqual([])
    // 第 5 个注册即超预算：最久未用的隐藏者 a 被逐（注册时刻序 = 使用序）
    lru.register('e', evictSpyOf(log, 'e'))
    expect(log).toEqual(['a'])
    expect(lru.stats()).toEqual({ live: 4, keep: 4, evicted: 1 })
  })

  it('可见 pane 永不驱逐：超额大于隐藏数时只逐隐藏者，允许暂时超额', () => {
    const lru = createTerminalLru()
    const log: string[] = []
    for (const id of ['a', 'b', 'c', 'd']) lru.register(id, evictSpyOf(log, id))
    // 全部保持可见（fail-open 注册态）：第 5、6 个注册无隐藏候选，零驱逐
    lru.register('e', evictSpyOf(log, 'e'))
    lru.register('f', evictSpyOf(log, 'f'))
    expect(log).toEqual([])
    expect(lru.stats().live).toBe(6)
    // b/c 转隐藏：预算执行收敛到逐这两个，可见的 a/d/e/f 保留
    lru.setVisible('b', false)
    lru.setVisible('c', false)
    expect(log).toEqual(['b', 'c'])
    expect(lru.stats().live).toBe(4)
  })

  it('touch（可见翻转）刷新最近使用序：激活过的最旧者不再是最早候选', () => {
    // fake timers 拉开时间轴：真实人类操作 register→touch 相隔远大于 1ms，
    // 同毫秒注册的相等 lastUsed 会走稳定序 tiebreak，测不出「刷新生效」
    vi.useFakeTimers()
    const lru = createTerminalLru()
    const log: string[] = []
    for (const id of ['a', 'b', 'c', 'd']) lru.register(id, evictSpyOf(log, id))
    for (const id of ['a', 'b', 'c', 'd']) lru.setVisible(id, false)
    expect(log).toEqual([])
    vi.advanceTimersByTime(1000)
    lru.setVisible('a', true) // 激活 a：使用序刷新为最新
    vi.advanceTimersByTime(1000)
    lru.register('e', evictSpyOf(log, 'e')) // 第 5 个注册：逐最久未用的 b（a 已刷新）
    expect(log).toEqual(['b'])
    // a 再转隐藏：其使用序仍是最新，预算内不触发、后续执行不选它
    lru.setVisible('a', false)
    expect(log).toEqual(['b'])
    vi.advanceTimersByTime(1000)
    lru.register('f', evictSpyOf(log, 'f')) // 再超预算：隐藏者 {a,c,d,e} 中最久未用 = c
    expect(log).toEqual(['b', 'c'])
    expect(lru.stats().evicted).toBe(2)
    vi.useRealTimers()
  })

  it('驱逐后重挂（重注册）幂等覆盖并即时执行预算，release 摘账', () => {
    const lru = createTerminalLru()
    const log: string[] = []
    const evicts = new Map<string, () => void>()
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const fn = evictSpyOf(log, id)
      evicts.set(id, fn)
      lru.register(id, fn)
    }
    for (const id of ['a', 'b', 'c', 'd', 'e']) lru.setVisible(id, false)
    expect(log).toEqual(['a']) // 预算收敛：最老的 a 被逐（隐藏翻转时补执行）
    // a 重挂：重注册（换最新闭包）即时执行预算——超 1 逐最久未用的 b
    const evictA2 = evictSpyOf(log, 'a-new')
    lru.register('a', evictA2)
    expect(log).toEqual(['a', 'b'])
    expect(lru.stats()).toEqual({ live: 4, keep: 4, evicted: 2 })
    // 重挂者 fail-open 可见：c 重复转隐藏不触发驱逐（预算内）
    lru.setVisible('c', false)
    expect(log).toEqual(['a', 'b'])
    lru.release('c', evicts.get('c')!)
    expect(lru.stats().live).toBe(3) // a-new / d / e
  })

  it('release 带所有权比对：非当前登记者的闭包摘不走条目（双挂接窗口守卫）', () => {
    const lru = createTerminalLru()
    const log: string[] = []
    const evictOld = evictSpyOf(log, 'old')
    lru.register('x', evictOld)
    // 接管者覆盖注册（新 pane 接管同会话的现役实例）
    const evictNew = evictSpyOf(log, 'new')
    lru.register('x', evictNew)
    // 旧 pane 后卸载：其 release 不得摘走接管者的条目
    lru.release('x', evictOld)
    expect(lru.stats().live).toBe(1)
    // 接管者本人卸载：正常摘账
    lru.release('x', evictNew)
    expect(lru.stats().live).toBe(0)
  })

  it('未注册会话的记账调用安全 no-op（驱逐态重见前的 touch 不建账）', () => {
    const lru = createTerminalLru()
    expect(() => {
      lru.setVisible('ghost', true)
      lru.setVisible('ghost', false)
      lru.release('ghost', () => {})
    }).not.toThrow()
    expect(lru.stats()).toEqual({ live: 0, keep: 4, evicted: 0 })
  })
})
