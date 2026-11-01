import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import { useWebSocket } from '@/composables/useWebSocket'
import { useProjectStore } from '@/stores/project'
import { useLockStore } from '@/stores/lock'
import { useChangesStore } from '@/stores/changes'
import { useBranchStore } from '@/stores/branch'
import { useLogStore } from '@/stores/log'
import { GIT_PANEL_AUTO_REFRESH } from '@/composables/useGitPanelAutoRefresh'

// Mock WebSocket：构造时不抛错，记录 url/protocols，readyState 默认 0
// （同 useWebSocketBase.test.ts 的既有范式——jsdom 无 WebSocket）
class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  protocols: string | string[] | undefined
  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn(() => {
    this.readyState = 3 // CLOSED
  })

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    MockWebSocket.instances.push(this)
  }
}

/**
 * WS 断线重连后状态补拉（P-20261001-19）单测：
 * - 本实例首个成功 onopen（含离线进入项目后首开迟到到恢复重连）→ 补拉
 * - 同项目重连（onclose → 退避重连 → onopen）补拉 changes/branch/log/projects 四 store
 * - 项目切换（pid 变化）的首连不补拉——切换链自会全量拉取
 * - 补拉判别不用 base 的 attempts>0：handleRecovery（online/visibilitychange，
 *   休眠唤醒主路径）会先把 attempts 归零再重连，attempts>0 判别在该场景必然漏补；
 *   也不能「跳过首个成功 onopen」——离线态进入项目时 WS 首开被截胡，首个成功
 *   onopen 就是恢复重连本身（e2e 实测抓出该漏补）
 */
describe('useWebSocket 重连补拉', () => {
  let scope: ReturnType<typeof effectScope>
  let fetchStatus: ReturnType<typeof vi.fn>
  let fetchBranches: ReturnType<typeof vi.fn>
  let fetchLog: ReturnType<typeof vi.fn>
  let fetchProjects: ReturnType<typeof vi.fn>
  // 每个用例独立的 pinia；老用例闭包在用例结束后仍活着（见 afterEach）
  const createdPinias: Pinia[] = []

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error: 替换全局 WebSocket 供测试
    globalThis.WebSocket = MockWebSocket
    const pinia = createPinia()
    createdPinias.push(pinia)
    setActivePinia(pinia)
    const projectStore = useProjectStore()
    projectStore.currentProjectId = 'p1'
    // isLocked 默认 true（checkStatus 探测前），门控会拦下首连——测试先置未锁
    useLockStore().isLocked = false
    // 拦截四 store 的 fetch（真实实现会发 axios 请求）：装在实例方法上，
    // useWebSocket 内部的 useXxxStore() 取到同一 pinia 实例的同批实例
    fetchStatus = vi.spyOn(useChangesStore(), 'fetchStatus').mockResolvedValue(undefined)
    fetchBranches = vi.spyOn(useBranchStore(), 'fetchBranches').mockResolvedValue(undefined)
    fetchLog = vi.spyOn(useLogStore(), 'fetchLog').mockResolvedValue(undefined)
    fetchProjects = vi.spyOn(useProjectStore(), 'fetchProjects').mockResolvedValue(undefined)
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
    // useWebSocketBase 的 window 'online' 监听只在组件卸载时移除（本测试无
    // 组件宿主）——老用例闭包会在后续用例派发 online 时复活并创建连接。
    // 置空老 pinia 的项目 id：老闭包 getUrl 返回空串，connect 直接跳过
    for (const p of createdPinias) useProjectStore(p).currentProjectId = ''
  })

  function openLast(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1]
  }

  it('首个成功 onopen 补拉（离线进入项目后首开迟到到恢复重连的同款形态）', () => {
    scope.run(() => useWebSocket())!
    // immediate watch 已按 currentProjectId 发起首连
    expect(MockWebSocket.instances).toHaveLength(1)
    openLast().onopen?.()
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(fetchStatus).toHaveBeenCalledWith('p1')
    expect(fetchBranches).toHaveBeenCalledTimes(1)
    expect(fetchBranches).toHaveBeenCalledWith('p1')
    expect(fetchLog).toHaveBeenCalledTimes(1)
    expect(fetchLog).toHaveBeenCalledWith('p1')
    expect(fetchProjects).toHaveBeenCalledTimes(1)
  })

  it('同项目重连（断线 → 退避重连）再次补拉', async () => {
    scope.run(() => useWebSocket())!
    openLast().onopen?.()

    vi.useFakeTimers()
    try {
      openLast().onclose?.({ code: 1006 } as CloseEvent)
      // 默认 3s 起步退避到期 → 自动重连
      await vi.advanceTimersByTimeAsync(3100)
      expect(MockWebSocket.instances).toHaveLength(2)
      openLast().onopen?.()
    } finally {
      vi.useRealTimers()
    }

    expect(fetchStatus).toHaveBeenCalledTimes(2)
    expect(fetchStatus).toHaveBeenCalledWith('p1')
    expect(fetchBranches).toHaveBeenCalledTimes(2)
    expect(fetchLog).toHaveBeenCalledTimes(2)
    expect(fetchProjects).toHaveBeenCalledTimes(2)
  })

  it('项目切换的首连不补拉（切换链自会拉取）', async () => {
    scope.run(() => useWebSocket())!
    openLast().onopen?.()
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    // 切项目 → watch 断开旧连、连新项目：pid 变化 = 切换链拉取，不再补拉
    useProjectStore().currentProjectId = 'p2'
    await nextTick()
    expect(MockWebSocket.instances).toHaveLength(2)
    openLast().onopen?.()

    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(fetchBranches).toHaveBeenCalledTimes(1)
    expect(fetchLog).toHaveBeenCalledTimes(1)
    expect(fetchProjects).toHaveBeenCalledTimes(1)
    // 新连接指向新项目
    expect(openLast().url).toContain('/projects/p2')
  })

  it('恢复触发器（online 事件，attempts 已归零）重连后仍补拉', async () => {
    scope.run(() => useWebSocket())!
    openLast().onopen?.()
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    openLast().onclose?.({ code: 1006 } as CloseEvent)
    // handleRecovery：清掉退避 timer、attempts 归零、立即重连
    // （休眠唤醒/网络切换的真实主路径——attempts>0 判别在此必然漏补）
    await page_online()

    expect(fetchStatus).toHaveBeenCalledTimes(2)
    expect(fetchStatus).toHaveBeenCalledWith('p1')
    expect(fetchBranches).toHaveBeenCalledTimes(2)
    expect(fetchLog).toHaveBeenCalledTimes(2)
    expect(fetchProjects).toHaveBeenCalledTimes(2)
  })

  it('git.activity 服务端定向广播并轨面板刷新链（P-20261004-81）', () => {
    scope.run(() => useWebSocket())!
    openLast().onopen?.()
    const fired = vi.fn()
    window.addEventListener(GIT_PANEL_AUTO_REFRESH, fired)
    try {
      // readLoop 嗅探命中经 busbridge 落项目 WS 的线上形态：并轨转发为
      // sc:git-panel-autorefresh 窗口事件，去抖/in-flight 去重在面板侧
      openLast().onmessage?.({
        data: JSON.stringify({ type: 'git.activity', data: { kind: 'commit', ref: 'main', sessionId: 'term-1' } }),
      } as MessageEvent)
      expect(fired).toHaveBeenCalledTimes(1)
      openLast().onmessage?.({
        data: JSON.stringify({ type: 'git.activity', data: { kind: 'push' } }),
      } as MessageEvent)
      expect(fired).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener(GIT_PANEL_AUTO_REFRESH, fired)
    }
  })

  it('真重连与离线进入的首开都顺带派发 git 面板刷新事件；项目切换不派发（P-20261005-7）', async () => {
    scope.run(() => useWebSocket())!
    const fired = vi.fn()
    window.addEventListener(GIT_PANEL_AUTO_REFRESH, fired)
    try {
      // 首个成功 onopen（含离线进入形态）：与补拉同谓词派发——离线进入时面板
      // 可能已在断线窗口前挂载拉取，「首开迟到到恢复重连」的窗口正是滞旧源；
      // 在线首开的冗余派发由面板侧去抖合并（幂等 GET），同 P-19 对四 store 的裁决
      openLast().onopen?.()
      expect(fired).toHaveBeenCalledTimes(1)

      // 同项目断线重连：再次派发（分支树/变更面板不读 store，这是它们感知断线
      // 窗口期外部 git 改动的唯一链）。
      // onclose 须在 fake timers 就位后调（同上「同项目重连」用例）——退避重连
      // timer 挂在调度时刻的时钟上，先调就归真实时钟、假时钟推进不到
      vi.useFakeTimers()
      try {
        openLast().onclose?.({ code: 1006 } as CloseEvent)
        await vi.advanceTimersByTimeAsync(3100)
        expect(MockWebSocket.instances).toHaveLength(2)
        openLast().onopen?.()
      } finally {
        vi.useRealTimers()
      }
      expect(fired).toHaveBeenCalledTimes(2)

      // 项目切换的首连：切换链自会全量拉取，不派发
      useProjectStore().currentProjectId = 'p2'
      await nextTick()
      openLast().onopen?.()
      expect(fired).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener(GIT_PANEL_AUTO_REFRESH, fired)
    }
  })

  /** 派发 window online 事件（useWebSocketBase.handleRecovery 的恢复触发器） */
  async function page_online() {
    window.dispatchEvent(new Event('online'))
    // 重连是同步的（handleRecovery 直接 connect），onopen 手动触发
    await nextTick()
    expect(MockWebSocket.instances).toHaveLength(2)
    openLast().onopen?.()
  }
})
