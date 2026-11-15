import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { usePanelLayout, resetPanelLayout, restoreNotesViewOnce, restoreDshConsoleOnce } from '@/composables/usePanelLayout'
import { uiStateApi } from '@/api/client'

// 笔记视图开态持久化三件套（P-20261112-6-S1）：watch 统一即时写（写入路径不止
// toggle/close——主区互斥隐式关闭也要落盘）+ restoreNotesViewOnce 刷新恢复
// （仅仍为关态时置开）+「notes 先、dsh 后」显式定序（异常双真存档 dsh 后到者
// 胜）。dsh 同族先例的互斥行为面在 usePanelLayout.test.ts 既有用例覆盖，本文件
// 只钉 notes 键族与定序契约（需要真 pinia：persist watch 直写 uiState store）。

vi.mock('@/api/client', () => ({
  uiStateApi: { get: vi.fn(), update: vi.fn(), patch: vi.fn() },
  setInstanceContext: vi.fn(),
}))

type AllState = Record<string, Record<string, unknown>>

function mockServerData(all: AllState) {
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: all } as Awaited<ReturnType<typeof uiStateApi.get>>)
}

beforeEach(async () => {
  // 先复位模块态再激活 pinia：resetPanelLayout 触发的关态补丁在无 pinia 下被
  // persistNotesViewOpen 的 try/catch 静默吞掉，测试内不残留噪声写
  resetPanelLayout()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: {} } as Awaited<ReturnType<typeof uiStateApi.get>>)
  vi.mocked(uiStateApi.patch).mockResolvedValue({} as Awaited<ReturnType<typeof uiStateApi.patch>>)
  await nextTick()
})

function notesViewPatches(): unknown[] {
  return vi.mocked(uiStateApi.patch).mock.calls.filter(([body]) => {
    const rec = (body as Record<string, Record<string, unknown>>)['local']
    return !!rec && 'notesView' in rec
  })
}

describe('notesView 开态 watch 统一即时写（P-20261112-6-S1）', () => {
  it('toggleNotesView 开/关都即时落盘 notesView.open', async () => {
    const panel = usePanelLayout()
    panel.toggleNotesView()
    await nextTick()
    expect(panel.showNotesView.value).toBe(true)
    expect(notesViewPatches()).toEqual([
      [{ local: { notesView: { open: true } } }, { silent: true }],
    ])

    panel.closeNotesView()
    await nextTick()
    expect(panel.showNotesView.value).toBe(false)
    expect(notesViewPatches()).toEqual([
      [{ local: { notesView: { open: true } } }, { silent: true }],
      [{ local: { notesView: { open: false } } }, { silent: true }],
    ])
  })

  it('主区互斥隐式关闭（开远程控制台收笔记）同样落盘——散写必漏的路径', async () => {
    const panel = usePanelLayout()
    panel.toggleNotesView()
    await nextTick()
    vi.mocked(uiStateApi.patch).mockClear()

    panel.openRemoteConsole()
    await nextTick()
    expect(panel.showNotesView.value).toBe(false)
    expect(notesViewPatches()).toEqual([
      [{ local: { notesView: { open: false } } }, { silent: true }],
    ])
  })
})

describe('restoreNotesViewOnce 刷新恢复（P-20261112-6-S1）', () => {
  it('存档开态 → 恢复置开并按 openNotesView 语义清互斥视图', async () => {
    mockServerData({ local: { notesView: { open: true }, dshConsole: { open: false } } })
    const panel = usePanelLayout()
    panel.showRemoteConsole.value = true
    panel.showShareManager.value = true

    await restoreNotesViewOnce()
    await nextTick()
    expect(panel.showNotesView.value).toBe(true)
    expect(panel.showRemoteConsole.value).toBe(false)
    expect(panel.showShareManager.value).toBe(false)
    expect(panel.showDshConsole.value).toBe(false)
    expect(panel.showDashboard.value).toBe(false)
  })

  it('存档关态 → 不恢复（旧存档无键 = 不恢复，零迁移）', async () => {
    mockServerData({})
    const panel = usePanelLayout()
    await restoreNotesViewOnce()
    expect(panel.showNotesView.value).toBe(false)
    expect(panel.showDshConsole.value).toBe(false)
  })

  it('once 防重复：二次调用不重发请求', async () => {
    mockServerData({ local: { notesView: { open: true } } })
    const panel = usePanelLayout()
    await restoreNotesViewOnce()
    const calls = vi.mocked(uiStateApi.get).mock.calls.length

    await restoreNotesViewOnce()
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBe(calls)
    expect(panel.showNotesView.value).toBe(true)
  })

  it('落地窗口内用户已手动开笔记：守卫跳过恢复，不重复写不乱清互斥', async () => {
    let resolveGet!: (v: { data: AllState }) => void
    vi.mocked(uiStateApi.get).mockImplementation(
      () => new Promise((r) => { resolveGet = r }) as Awaited<ReturnType<typeof uiStateApi.get>>,
    )
    const panel = usePanelLayout()
    const pending = restoreNotesViewOnce()
    panel.toggleNotesView() // 异步落地前用户手动开（真操作链，含互斥清理）
    await nextTick()
    vi.mocked(uiStateApi.patch).mockClear()

    resolveGet({ data: { local: { notesView: { open: true } } } })
    await pending
    await nextTick()

    expect(panel.showNotesView.value).toBe(true)
    // 守卫「仍为关态才置开」：恢复流程整体跳过，零 notesView 补丁
    expect(notesViewPatches()).toEqual([])
  })

  it('异常双真存档：dsh 恢复先等 notes 落地，dsh 后到者胜出', async () => {
    mockServerData({ local: { notesView: { open: true }, dshConsole: { open: true } } })
    const panel = usePanelLayout()

    await restoreDshConsoleOnce()
    expect(panel.showDshConsole.value).toBe(true)
    expect(panel.showNotesView.value).toBe(false) // dsh 后到者胜（互斥最后操作者优先）
  })

  it('真实挂载流（notes 宿主先发起 + dsh 宿主加入）：定序不变、请求各一次', async () => {
    mockServerData({ local: { notesView: { open: true }, dshConsole: { open: true } } })
    const panel = usePanelLayout()
    const notesP = restoreNotesViewOnce()
    const dshP = restoreDshConsoleOnce()

    await Promise.all([notesP, dshP])
    expect(panel.showNotesView.value).toBe(false)
    expect(panel.showDshConsole.value).toBe(true)
    // memoized promise：notes/dsh 各只拉取一次
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBe(2)
  })

  it('存档仅 dsh 开：dsh 恢复、笔记不受扰动', async () => {
    mockServerData({ local: { dshConsole: { open: true } } })
    const panel = usePanelLayout()
    await restoreDshConsoleOnce()
    expect(panel.showDshConsole.value).toBe(true)
    expect(panel.showNotesView.value).toBe(false)
  })

  it('resetPanelLayout 复位 once 守卫：复位后再次恢复重新拉取', async () => {
    mockServerData({ local: { notesView: { open: true } } })
    const panel = usePanelLayout()
    await restoreNotesViewOnce()
    expect(panel.showNotesView.value).toBe(true)
    const calls = vi.mocked(uiStateApi.get).mock.calls.length

    resetPanelLayout()
    // 排空复位触发的关态补丁：persist 写经 mergeKnownAll 会原地改写 loadState
    // 别名进 lastKnownAll 的 mock 数据对象（与本套件既有用例「写后重新 mock」
    // 同款规避），再换一份全新 mock 供二次恢复读取
    await nextTick()
    mockServerData({ local: { notesView: { open: true } } })
    await restoreNotesViewOnce()
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBeGreaterThan(calls)
    expect(panel.showNotesView.value).toBe(true)
  })
})
