import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'

// 触发重扫后等待确定性落点：watcher(pre) 随首个 tick 的 flush 执行，rescan 又挂
// 在其后一拍的 nextTick——两个 tick 后断言才不与微任务序竞速
async function flushRescan() {
  await nextTick()
  await nextTick()
}
import { AUTO_READ_FLUSH_MS, useNotifyAutoRead } from './useNotifyAutoRead'

// ── IntersectionObserver 假身：记录登记目标、由测试手动驱动交集回调
// （jsdom 无 IntersectionObserver，经 observerImpl 注入绕开全局污染）──
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  callback: IntersectionObserverCallback
  root: Element | null = null
  observed = new Set<Element>()
  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    this.callback = cb
    this.root = (opts?.root as Element | null) ?? null
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: Element) { this.observed.add(el) }
  unobserve(el: Element) { this.observed.delete(el) }
  disconnect() { this.observed.clear() }
  /** 模拟一批交集事件进入回调（isIntersecting 可按元素粒度指定） */
  fire(targets: Array<{ el: Element; isIntersecting?: boolean }>): void {
    const entries = targets.map(({ el, isIntersecting = true }) =>
      ({ target: el, isIntersecting }) as IntersectionObserverEntry)
    this.callback(entries, this as unknown as IntersectionObserver)
  }
}

/** 构造带 data-nav-idx 行的滚动容器；idsFor 的数据源由测试侧持有 */
interface TestRow { id: string; read: boolean }
function buildList(rows: TestRow[]) {
  const list = document.createElement('div')
  const rowState = new Map<string, TestRow>()
  rows.forEach((r, i) => {
    rowState.set(r.id, r)
    const el = document.createElement('div')
    el.dataset.navIdx = String(i)
    el.dataset.rowId = r.id
    list.appendChild(el)
  })
  return { list, rowState }
}

function mountHost(opts: {
  listRef: Ref<HTMLElement | undefined>
  active: Ref<boolean>
  idsForElement: (el: Element) => string[]
  markRead: (id: string) => void
  source: Ref<number>
}) {
  const Host = defineComponent({
    setup() {
      useNotifyAutoRead({
        listRef: opts.listRef,
        isActive: () => opts.active.value,
        idsForElement: opts.idsForElement,
        markRead: opts.markRead,
        rescanOn: [() => opts.source.value],
        // jsdom 无 IntersectionObserver：注入假身（同时避免真身全局污染）
        observerImpl: FakeIntersectionObserver as unknown as typeof IntersectionObserver,
      })
      return () => null
    },
  })
  return mount(Host)
}

let markReadCalls: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  FakeIntersectionObserver.instances = []
  markReadCalls = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useNotifyAutoRead 滚动自动已读（P-20261003-260）', () => {
  it('开关关：不建 observer 不登记（默认关零行为）', async () => {
    const { list, rowState } = buildList([{ id: 'a', read: false }])
    const listRef = ref<HTMLElement | undefined>(list)
    const active = ref(false)
    const source = ref(0)
    mountHost({
      listRef, active, source,
      idsForElement: (el) => {
        const row = rowState.get(el.getAttribute('data-row-id')!)
        return row && !row.read ? [row.id] : []
      },
      markRead: (id) => { markReadCalls.push(id) },
    })
    source.value++
    
    await flushRescan()
    expect(FakeIntersectionObserver.instances).toHaveLength(0)
  })

  it('开关开：未读行登记、已读行不登记；root 绑定滚动容器', async () => {
    const { list, rowState } = buildList([
      { id: 'unread-1', read: false },
      { id: 'read-1', read: true },
      { id: 'unread-2', read: false },
    ])
    const listRef = ref<HTMLElement | undefined>(list)
    const active = ref(true)
    const source = ref(0)
    mountHost({
      listRef, active, source,
      idsForElement: (el) => {
        const row = rowState.get(el.getAttribute('data-row-id')!)
        return row && !row.read ? [row.id] : []
      },
      markRead: (id) => { markReadCalls.push(id) },
    })
    source.value++
    
    await flushRescan()
    expect(FakeIntersectionObserver.instances).toHaveLength(1)
    const obs = FakeIntersectionObserver.instances[0]!
    expect(obs.root).toBe(list)
    expect(obs.observed.size).toBe(2)
    const rowIds = [...obs.observed].map(el => el.getAttribute('data-row-id')).sort()
    expect(rowIds).toEqual(['unread-1', 'unread-2'])
  })

  it('滚入视口：300ms 合流后批量 markRead；离开视口不标', async () => {
    const { list, rowState } = buildList([{ id: 'a', read: false }, { id: 'b', read: false }])
    const listRef = ref<HTMLElement | undefined>(list)
    const active = ref(true)
    const source = ref(0)
    mountHost({
      listRef, active, source,
      idsForElement: (el) => {
        const row = rowState.get(el.getAttribute('data-row-id')!)
        return row && !row.read ? [row.id] : []
      },
      markRead: (id) => { markReadCalls.push(id) },
    })
    source.value++
    
    await flushRescan()
    const obs = FakeIntersectionObserver.instances[0]!
    const els = [...obs.observed]

    obs.fire([{ el: els[0]!, isIntersecting: true }, { el: els[1]!, isIntersecting: false }])
    expect(markReadCalls).toHaveLength(0) // 合流窗内不逐条散发
    vi.advanceTimersByTime(AUTO_READ_FLUSH_MS)
    expect(markReadCalls).toEqual(['a']) // 只有进入视口的行被标
  })

  it('同 id 重复触发只标一次；回调时点已读的行不重复标', async () => {
    const { list, rowState } = buildList([{ id: 'a', read: false }])
    const listRef = ref<HTMLElement | undefined>(list)
    const active = ref(true)
    const source = ref(0)
    mountHost({
      listRef, active, source,
      idsForElement: (el) => {
        const row = rowState.get(el.getAttribute('data-row-id')!)
        return row && !row.read ? [row.id] : []
      },
      markRead: (id) => { markReadCalls.push(id) },
    })
    source.value++
    
    await flushRescan()
    const obs = FakeIntersectionObserver.instances[0]!
    const el = [...obs.observed][0]!

    // 同一合流窗内重复触发交集：去重只标一次
    obs.fire([{ el }]); obs.fire([{ el }])
    vi.advanceTimersByTime(AUTO_READ_FLUSH_MS)
    expect(markReadCalls).toEqual(['a'])

    // 行已读后再次触发交集（重复回调/重登记残留）：现场评估产出空集不再标
    rowState.get('a')!.read = true
    obs.fire([{ el }])
    vi.advanceTimersByTime(AUTO_READ_FLUSH_MS)
    expect(markReadCalls).toEqual(['a'])
  })

  it('面板重开滚动容器换元素：observer 重建绑定新 root', async () => {
    const states: Array<Map<string, { id: string; read: boolean }>> = []
    const first = buildList([{ id: 'a', read: false }])
    states.push(first.rowState)
    const listRef = ref<HTMLElement | undefined>(first.list)
    const active = ref(true)
    const source = ref(0)
    mountHost({
      listRef, active, source,
      idsForElement: (el) => {
        const id = el.getAttribute('data-row-id')!
        const row = states.map(s => s.get(id)).find(Boolean)
        return row && !row.read ? [row.id] : []
      },
      markRead: (id) => { markReadCalls.push(id) },
    })
    source.value++
    await flushRescan()
    expect(FakeIntersectionObserver.instances).toHaveLength(1)

    // 面板 v-if 关再开：新容器元素 → 旧 observer 注销、新 observer 绑新 root
    const second = buildList([{ id: 'b', read: false }])
    states.push(second.rowState)
    listRef.value = second.list
    source.value++
    await flushRescan()
    expect(FakeIntersectionObserver.instances).toHaveLength(2)
    expect(FakeIntersectionObserver.instances[0]!.observed.size).toBe(0)
    expect(FakeIntersectionObserver.instances[1]!.root).toBe(second.list)
    expect(FakeIntersectionObserver.instances[1]!.observed.size).toBe(1)
  })

  it('开关中途关闭：注销观察并停止登记；已在途的合流批照常落地（滚过即读过）', async () => {
    const { list, rowState } = buildList([{ id: 'a', read: false }])
    const listRef = ref<HTMLElement | undefined>(list)
    const active = ref(true)
    const source = ref(0)
    mountHost({
      listRef, active, source,
      idsForElement: (el) => {
        const row = rowState.get(el.getAttribute('data-row-id')!)
        return row && !row.read ? [row.id] : []
      },
      markRead: (id) => { markReadCalls.push(id) },
    })
    source.value++
    
    await flushRescan()
    const obs = FakeIntersectionObserver.instances[0]!
    obs.fire([{ el: [...obs.observed][0]! }])

    active.value = false // 面板关闭/开关关闭
    source.value++
    
    await flushRescan()
    expect(obs.observed.size).toBe(0)
    vi.advanceTimersByTime(AUTO_READ_FLUSH_MS)
    expect(markReadCalls).toEqual(['a']) // 已滚入视口的条目不受关闭影响
  })

  it('卸载清理：未落地的合流批被丢弃，不再产生 markRead', async () => {
    const { list, rowState } = buildList([{ id: 'a', read: false }])
    const listRef = ref<HTMLElement | undefined>(list)
    const active = ref(true)
    const source = ref(0)
    const wrapper = mountHost({
      listRef, active, source,
      idsForElement: (el) => {
        const row = rowState.get(el.getAttribute('data-row-id')!)
        return row && !row.read ? [row.id] : []
      },
      markRead: (id) => { markReadCalls.push(id) },
    })
    source.value++
    
    await flushRescan()
    FakeIntersectionObserver.instances[0]!.fire([{ el: [...FakeIntersectionObserver.instances[0]!.observed][0]! }])
    wrapper.unmount()
    vi.advanceTimersByTime(AUTO_READ_FLUSH_MS)
    expect(markReadCalls).toHaveLength(0)
  })
})
