import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { useNotesPanelPresentation } from '@/composables/useNotesPanelPresentation'
import { useNarrowLayout, resetNarrowLayoutForTests } from '@/composables/useNarrowLayout'
import { uiStateApi } from '@/api/client'

// 笔记面板呈现态持久化（P-20261112-6-S3）：sidebarOpen/mode 变更即时写
// （notesView 子字段）+ restorePresentation 读回应用（窄屏 sidebarOpen 让位出厂
// 收起——恢复仅桌宽生效）+ 读回窗口竞态守卫（用户已切换则恢复整体让位，
// loadList 保底选篇「人的输入优先」同哲学）。useNarrowLayout 是模块单例：
// 窄屏形态用 resetNarrowLayoutForTests + mock matchMedia 驱动（既有窄屏测试同款）。

vi.mock('@/api/client', () => ({
  uiStateApi: { get: vi.fn(), update: vi.fn(), patch: vi.fn() },
  setInstanceContext: vi.fn(),
}))

type AllState = Record<string, Record<string, unknown>>

function mockServerData(all: AllState) {
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: all } as Awaited<ReturnType<typeof uiStateApi.get>>)
}

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: {} } as Awaited<ReturnType<typeof uiStateApi.get>>)
  vi.mocked(uiStateApi.patch).mockResolvedValue({} as Awaited<ReturnType<typeof uiStateApi.patch>>)
  resetNarrowLayoutForTests()
  await nextTick()
})

afterEach(() => {
  // 窄屏用例的 matchMedia stub 全局还原：useNarrowLayout 模块单例读 window.matchMedia，
  // 泄漏会把后续用例拖进窄屏出厂（sidebarOpen 收起）
  vi.unstubAllGlobals()
  resetNarrowLayoutForTests()
})

function notesViewPatches(): Record<string, unknown>[] {
  return vi.mocked(uiStateApi.patch).mock.calls
    .map(([body]) => (body as Record<string, Record<string, unknown>>)['local']?.['notesView'])
    .filter((ns): ns is Record<string, unknown> => !!ns)
}

describe('呈现态即时写（P-20261112-6-S3）', () => {
  it('sidebarOpen/mode 变更各落盘对应子字段（键级补丁；后续补丁经注册表回填基底同族子键）', async () => {
    const p = useNotesPanelPresentation()
    p.sidebarOpen.value = false
    p.mode.value = 'preview'
    await nextTick()
    expect(notesViewPatches()).toEqual([
      { sidebarOpen: false },
      // mode 补丁只带 mode：sidebarOpen 子键由 backfillNestedSubfields 从内存基底
      // 回填（乐观推进自上一补丁）——命名空间整键替换不丢同族子字段的防线兑现
      { mode: 'preview', sidebarOpen: false },
    ])
  })

  it('出厂态不变更不写（desktop 初始 open / edit 不触发补丁）', async () => {
    useNotesPanelPresentation()
    await nextTick()
    expect(notesViewPatches()).toEqual([])
  })
})

describe('restorePresentation 读回（P-20261112-6-S3）', () => {
  it('桌宽：存档侧栏收起 + preview 模式均恢复', async () => {
    mockServerData({ local: { notesView: { sidebarOpen: false, mode: 'preview' } } })
    const p = useNotesPanelPresentation()
    await p.restorePresentation()
    expect(p.sidebarOpen.value).toBe(false)
    expect(p.mode.value).toBe('preview')
  })

  it('窄屏：sidebarOpen 恢复让位出厂收起，mode 照常恢复', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((q: string) => ({
      matches: q.includes('max-width'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })))
    useNarrowLayout() // 单例以窄屏 matchMedia 初始化
    expect(useNarrowLayout().narrow.value).toBe(true)

    mockServerData({ local: { notesView: { sidebarOpen: true, mode: 'preview' } } })
    const p = useNotesPanelPresentation()
    expect(p.sidebarOpen.value).toBe(false) // 窄屏出厂收起
    await p.restorePresentation()
    expect(p.sidebarOpen.value).toBe(false) // 恢复仅桌宽生效
    expect(p.mode.value).toBe('preview') // mode 无宽条件
  })

  it('旧存档无键/脏值：null/\'\' 回落出厂（零迁移）', async () => {
    mockServerData({ local: { notesView: { activeId: 'n-1' } } })
    const p = useNotesPanelPresentation()
    await p.restorePresentation()
    expect(p.sidebarOpen.value).toBe(true) // 桌面出厂常显
    expect(p.mode.value).toBe('edit')

    mockServerData({ local: { notesView: { sidebarOpen: 'yes', mode: 3 } } })
    const p2 = useNotesPanelPresentation()
    await p2.restorePresentation()
    expect(p2.sidebarOpen.value).toBe(true)
    expect(p2.mode.value).toBe('edit')
  })

  it('读回窗口内用户已切换：恢复整体让位，不翻回旧档值', async () => {
    let resolveGet!: (v: { data: AllState }) => void
    vi.mocked(uiStateApi.get).mockImplementation(
      () => new Promise((r) => { resolveGet = r }) as Awaited<ReturnType<typeof uiStateApi.get>>,
    )
    const p = useNotesPanelPresentation()
    const pending = p.restorePresentation()
    p.mode.value = 'preview' // 读回落地前用户切到 preview（写链同时落盘新值）
    await nextTick()
    vi.mocked(uiStateApi.patch).mockClear()

    resolveGet({ data: { local: { notesView: { mode: 'edit', sidebarOpen: false } } } })
    await pending
    await nextTick()

    expect(p.mode.value).toBe('preview') // 人的输入优先，不被旧档翻回
    expect(p.sidebarOpen.value).toBe(true)
    // 恢复让位后零补丁（旧档值不回写）
    expect(notesViewPatches()).toEqual([])
  })

  it('读取失败静默回落出厂（呈现态是增益不是关键路径）', async () => {
    vi.mocked(uiStateApi.get).mockRejectedValue(new Error('down'))
    const p = useNotesPanelPresentation()
    await expect(p.restorePresentation()).resolves.toBeUndefined()
    expect(p.sidebarOpen.value).toBe(true)
    expect(p.mode.value).toBe('edit')
  })
})
