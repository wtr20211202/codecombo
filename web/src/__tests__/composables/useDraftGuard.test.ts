import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { withSetup } from '@/__tests__/mocks/withSetup'
import { useDraftGuard, DRAFT_SAVE_DEBOUNCE_MS } from '@/composables/useDraftGuard'
import { safeStorage } from '@/utils/storage'

/**
 * 输入框级防丢草稿原语（P-20261005-229）单测：
 * 防抖落键（sessionStorage 通道）/ 空文本清键 / 回填校验 / 成功清除撤在途 /
 * 键漂移守卫 / 卸载同步 flush。接线方（AgentSessionQueuePanel）的 UI 行为由
 * e2e agent-queue.spec 覆盖（刷新回填 / 入队成功清键）。
 */

const KEY = 'sc.test.draft'

beforeEach(() => {
  vi.useFakeTimers()
  safeStorage.sessionRemove(KEY)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDraftGuard', () => {
  it('防抖落键：窗口内不写，推进 1s 后写 sessionStorage', () => {
    const text = ref('')
    const { result } = withSetup(() => useDraftGuard({ key: () => KEY, read: () => text.value }))
    text.value = '半成品指令'
    result.scheduleSave()
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS - 1)
    expect(safeStorage.sessionGet(KEY)).toBeNull()
    vi.advanceTimersByTime(1)
    expect(safeStorage.sessionGet(KEY)).toBe('半成品指令')
  })

  it('连续输入只落终值：防抖重置后写最后一次文本', () => {
    const text = ref('')
    const { result } = withSetup(() => useDraftGuard({ key: () => KEY, read: () => text.value }))
    text.value = '第一版'
    result.scheduleSave()
    vi.advanceTimersByTime(600)
    text.value = '第二版终稿'
    result.scheduleSave()
    vi.advanceTimersByTime(600)
    expect(safeStorage.sessionGet(KEY)).toBeNull() // 重置后首个窗口未满
    vi.advanceTimersByTime(400)
    expect(safeStorage.sessionGet(KEY)).toBe('第二版终稿')
  })

  it('空文本落键 = 清键（用户清空重写即放弃草稿）', () => {
    const text = ref('有内容')
    const { result } = withSetup(() => useDraftGuard({ key: () => KEY, read: () => text.value }))
    result.scheduleSave()
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS)
    expect(safeStorage.sessionGet(KEY)).toBe('有内容')
    text.value = ''
    result.scheduleSave()
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS)
    expect(safeStorage.sessionGet(KEY)).toBeNull()
  })

  it('restore 回填：预置键返回文本，缺键/空白键返回空', () => {
    const { result } = withSetup(() => useDraftGuard({ key: () => KEY, read: () => '' }))
    expect(result.restore()).toBe('')
    safeStorage.sessionSet(KEY, '刷新前写的指令')
    expect(result.restore()).toBe('刷新前写的指令')
    safeStorage.sessionSet(KEY, '   ')
    expect(result.restore()).toBe('') // 空白草稿等价无草稿
  })

  it('clearDraft 清键并撤销在途防抖（清除后不被定时器复活）', () => {
    const text = ref('即将提交的指令')
    const { result } = withSetup(() => useDraftGuard({ key: () => KEY, read: () => text.value }))
    result.scheduleSave()
    result.clearDraft()
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS * 2)
    expect(safeStorage.sessionGet(KEY)).toBeNull()
  })

  it('键漂移守卫：schedule 后键已变（面板复用换绑）则放弃写入', () => {
    const sessionId = ref('session-a')
    const text = ref('')
    const { result } = withSetup(() => useDraftGuard({
      key: () => `sc.test.draft.${sessionId.value}`,
      read: () => text.value,
    }))
    text.value = 'A 会话的半成品'
    result.scheduleSave()
    sessionId.value = 'session-b' // 等待期内换绑
    text.value = '' // 换绑回填重置（模拟 watch 清空）
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS)
    // 旧文本不得写进新会话键，旧会话键也不被误清
    expect(safeStorage.sessionGet('sc.test.draft.session-b')).toBeNull()
    expect(safeStorage.sessionGet('sc.test.draft.session-a')).toBeNull()
  })

  it('卸载同步 flush：防抖窗内卸载即落键（收起面板不丢半成品）', () => {
    const text = ref('')
    const { result, app } = withSetup(() => useDraftGuard({ key: () => KEY, read: () => text.value }))
    text.value = '收起前写的半句'
    result.scheduleSave()
    app.unmount() // 未到防抖期限，卸载钩子应立即落键
    expect(safeStorage.sessionGet(KEY)).toBe('收起前写的半句')
  })

  it('成功提交链：clearDraft 后卸载 flush 读到空文本走删键分支（不复活）', () => {
    const text = ref('已提交的指令')
    const { result, app } = withSetup(() => useDraftGuard({ key: () => KEY, read: () => text.value }))
    result.scheduleSave()
    result.clearDraft()
    text.value = '' // 提交成功清文本（接线方 submitDraft 的顺序）
    app.unmount()
    expect(safeStorage.sessionGet(KEY)).toBeNull()
  })
})
