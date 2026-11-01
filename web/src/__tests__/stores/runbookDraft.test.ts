import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useRunbookDraftStore, type RunbookDraft } from '../../stores/runbookDraft'
import { usePanelLayout } from '../../composables/usePanelLayout'

// 运行书草稿直达 store（P-20261005-3）：录制回放器「存为运行书」交付草稿——
// 暂存载荷 + 直达开底部终端分区（运行书 tab）+ RunbookPanel 消费清位。
// router 用桩（真 router 在 jsdom 单测里无路由语境；routeState 供各用例改写
// 当前路由名走「就地开面板 / 先路由进项目页」两分支）；usePanelLayout 走真
// 模块级共享 ref（previewPort.openInPanel 同款语义断言）。

const pushMock = vi.hoisted(() => vi.fn())
const routeState = vi.hoisted(() => ({ value: { name: 'home' as string | undefined } }))

vi.mock('../../router', () => ({
  default: {
    currentRoute: routeState,
    push: pushMock,
  },
}))

const draft = (over: Partial<RunbookDraft> = {}): RunbookDraft => ({
  title: '2026-10-10 会话操作',
  onFailure: 'continue',
  steps: [{ command: 'echo one' }, { command: 'echo two', description: '录制时失败（exit 1）' }],
  fromRecording: true,
  ...over,
})

beforeEach(() => {
  pushMock.mockReset()
  routeState.value.name = 'home'
  const layout = usePanelLayout()
  layout.showBottomPanel.value = false
  layout.bottomTab.value = 'git'
  layout.pendingBottomTab.value = null
})

describe('runbookDraft store（P-20261005-3）', () => {
  it('openInPanel 暂存草稿并直达：开底部面板 + 切终端 tab；他页路由进项目页并打标防翻走', () => {
    const store = useRunbookDraftStore()
    const layout = usePanelLayout()

    store.openInPanel(draft())

    expect(store.pending).not.toBeNull()
    expect(store.pending?.title).toBe('2026-10-10 会话操作')
    expect(layout.showBottomPanel.value).toBe(true)
    expect(layout.bottomTab.value).toBe('terminal')
    // 非项目页（大屏/首页宿主）：先路由进项目页 + pendingBottomTab 打标
    //（挂载期 ui-state 恢复晚于直接赋值，无打标会被上次保存 tab 翻走）
    expect(pushMock).toHaveBeenCalledWith({ name: 'project' })
    expect(layout.pendingBottomTab.value).toBe('terminal')
  })

  it('已在项目页时就地开面板：不路由、不打标', () => {
    routeState.value.name = 'project'
    const store = useRunbookDraftStore()
    const layout = usePanelLayout()

    store.openInPanel(draft())

    expect(layout.showBottomPanel.value).toBe(true)
    expect(layout.bottomTab.value).toBe('terminal')
    expect(pushMock).not.toHaveBeenCalled()
    expect(layout.pendingBottomTab.value).toBeNull()
  })

  it('consume 返回草稿并清位：消费后 pending 复位、再取为 null', () => {
    const store = useRunbookDraftStore()
    store.openInPanel(draft({ title: '草稿A' }))

    const d = store.consume()
    expect(d?.title).toBe('草稿A')
    expect(store.pending).toBeNull()
    expect(store.consume()).toBeNull()
  })
})
