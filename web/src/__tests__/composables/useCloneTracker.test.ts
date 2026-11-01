import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import i18n from '@/i18n'
import { LOCK_REJECTED_CLOSE_CODE } from '@/stores/lock'
import { useProjectStore } from '@/stores/project'
import {
  connectCloneWS,
  CLONE_WS_MAX_RETRIES,
  CLONE_WS_RETRY_DELAY,
} from '@/composables/useCloneWebSocket'
import { useCloneTracker } from '@/composables/useCloneTracker'
import type { CloneStartPayload } from '@/composables/useCloneProgress'

// 孤儿兜底 toast 走 createDiscreteApi：jsdom 无消息容器，替换为记录调用的桩
const toastCalls = vi.hoisted(() => ({
  success: [] as string[],
  info: [] as string[],
  error: [] as string[],
}))
vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...(actual as object),
    createDiscreteApi: () => ({
      message: {
        success: (s: string) => { toastCalls.success.push(s) },
        info: (s: string) => { toastCalls.info.push(s) },
        error: (s: string) => { toastCalls.error.push(s) },
      },
    }),
  }
})

// Mock WebSocket：构造时记录 url/protocols，回调由测试代码触发
class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  protocols: string | string[] | undefined
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn(() => {
    this.readyState = 3
  })

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    MockWebSocket.instances.push(this)
  }
}

const PAYLOAD: CloneStartPayload = { url: 'https://example.com/user/myrepo.git', dir: 'D:/ws/myrepo' }

// 模块级单例注册表：用例间经公开 API 清场（settleLocal 静默摘除）
function drainTracker() {
  const { items, settleLocal } = useCloneTracker()
  for (const t of [...items.value]) settleLocal(t.taskId)
}

describe('useCloneTracker', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    MockWebSocket.instances = []
    toastCalls.success.length = 0
    toastCalls.info.length = 0
    toastCalls.error.length = 0
    // @ts-expect-error: 替换全局 WebSocket 供测试
    globalThis.WebSocket = MockWebSocket
    localStorage.clear()
    drainTracker()
  })

  afterEach(() => {
    vi.useRealTimers()
    drainTracker()
  })

  it('track 登记条目并连接任务进度 WS，同 taskId 幂等', () => {
    const { items, track } = useCloneTracker()
    track('task-1', PAYLOAD)
    track('task-1', PAYLOAD)
    expect(items.value).toHaveLength(1)
    expect(items.value[0]!.taskId).toBe('task-1')
    // 显示名：目标目录尾段优先于 URL 尾段
    expect(items.value[0]!.name).toBe('myrepo')
    expect(items.value[0]!.progress).toBe(0)
    const inst = MockWebSocket.instances[0]
    expect(inst.url).toContain('/ws/clone/task-1')
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('onProgress 更新 stage 与 progress（百分比解析）', () => {
    const { items, track } = useCloneTracker()
    track('task-2', PAYLOAD)
    const inst = MockWebSocket.instances[0]
    inst.onmessage!({ data: JSON.stringify({ type: 'progress', line: 'Counting objects' }) } as MessageEvent)
    inst.onmessage!({ data: JSON.stringify({ type: 'progress', line: 'Receiving objects:  45%' }) } as MessageEvent)
    expect(items.value[0]!.stage).toBe('Receiving objects:  45%')
    expect(items.value[0]!.progress).toBe(45)
  })

  it('完成且非孤儿：条目移除且不弹提示（提示归启动弹窗回调）', () => {
    const { items, track } = useCloneTracker()
    track('task-3', PAYLOAD)
    const inst = MockWebSocket.instances[0]
    inst.onmessage!({ data: JSON.stringify({ type: 'done', status: 'success', result: null }) } as MessageEvent)
    expect(items.value).toHaveLength(0)
    expect(inst.close).toHaveBeenCalled()
    expect(toastCalls.success).toHaveLength(0)
  })

  it('完成且孤儿：条目移除 + 成功兜底提示 + 项目列表刷新', async () => {
    const projectStore = useProjectStore()
    const fetchSpy = vi.spyOn(projectStore, 'fetchProjects').mockImplementation(async () => {})
    const { items, track, orphan } = useCloneTracker()
    track('task-4', PAYLOAD)
    orphan('task-4')
    MockWebSocket.instances[0].onmessage!({ data: JSON.stringify({ type: 'done', status: 'success', result: null }) } as MessageEvent)
    expect(items.value).toHaveLength(0)
    expect(toastCalls.success).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('孤儿失败：错误兜底提示带 result.error', () => {
    const { items, track, orphan } = useCloneTracker()
    track('task-5', PAYLOAD)
    orphan('task-5')
    MockWebSocket.instances[0].onmessage!({
      data: JSON.stringify({ type: 'done', status: 'failed', result: { error: 'exit status 128' } }),
    } as MessageEvent)
    expect(items.value).toHaveLength(0)
    expect(toastCalls.error).toEqual([`${i18n.global.t('layout.cloneFail')}: exit status 128`])
  })

  it('settleLocal（启动回调在场）：条目移除且 WS 解绑（onmessage 已清，迟到 done 不再触发兜底）', () => {
    const { items, track, orphan, settleLocal } = useCloneTracker()
    track('task-6', PAYLOAD)
    orphan('task-6') // 先转孤儿再 settle：回调在场优先，兜底让位
    settleLocal('task-6')
    expect(items.value).toHaveLength(0)
    const inst = MockWebSocket.instances[0]
    expect(inst.close).toHaveBeenCalled()
    // done 迟到（两条 WS 竞速）：解绑后 onmessage 已清空，无兜底路径可达
    expect(inst.onmessage).toBeNull()
    expect(toastCalls.success).toHaveLength(0)
  })

  it('普通断线自动重连（重连后快照补发继续跟踪）', async () => {
    vi.useFakeTimers()
    const { items, track } = useCloneTracker()
    track('task-7', PAYLOAD)
    MockWebSocket.instances[0].onclose!({ code: 1006 } as CloseEvent)
    // 条目保留、等待重试窗口
    expect(items.value).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(CLONE_WS_RETRY_DELAY)
    expect(MockWebSocket.instances).toHaveLength(2)
    // 重连实例收进度即恢复更新
    MockWebSocket.instances[1].onmessage!({ data: JSON.stringify({ type: 'progress', line: 'Resolving deltas:  90%' }) } as MessageEvent)
    expect(items.value[0]!.progress).toBe(90)
  })

  it('连续断线超过重试上限：静默摘条目（服务端重启丢任务，无完成可报）', async () => {
    vi.useFakeTimers()
    const { items, track } = useCloneTracker()
    track('task-8', PAYLOAD)
    for (let i = 0; i <= CLONE_WS_MAX_RETRIES; i++) {
      MockWebSocket.instances[i]!.onclose!({ code: 1006 } as CloseEvent)
      await vi.advanceTimersByTimeAsync(CLONE_WS_RETRY_DELAY)
    }
    expect(items.value).toHaveLength(0)
  })

  it('close 4001（锁定拒绝）：静默摘条目不再重试（锁定屏接管 UX）', () => {
    const { items, track } = useCloneTracker()
    track('task-9', PAYLOAD)
    MockWebSocket.instances[0].onclose!({ code: LOCK_REJECTED_CLOSE_CODE } as CloseEvent)
    expect(items.value).toHaveLength(0)
    expect(MockWebSocket.instances[0]!.close).toHaveBeenCalled()
  })

  it('connectCloneWS 直连（附加观察路径）不经过 track 不产生条目', () => {
    connectCloneWS('task-attach', {})
    const { items } = useCloneTracker()
    expect(items.value).toHaveLength(0)
  })
})
