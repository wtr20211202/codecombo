import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { usePanelLayout, resetPanelLayout, restoreShareManagerOnce, restoreDshConsoleOnce, restoreNotesViewOnce } from '@/composables/usePanelLayout'
import { uiStateApi } from '@/api/client'

// 分享管理视图开态持久化三件套（P-20261112-6-S3）：watch 统一即时写（写入路径
// 不止 toggle——主区互斥隐式关闭/?view=shares 深链/通知直达都要落盘）+
// restoreShareManagerOnce 刷新恢复（仅仍为关态时置开）+「notes 先、dsh 次、
// share 后」恢复定序（异常双真存档 share 后到者胜）。dsh/notes 同族先例的互斥
// 行为面在 usePanelLayout.test.ts 既有用例覆盖，本文件只钉 shareManager 键族
// 与恢复定序契约（需要真 pinia：persist watch 直写 uiState store）。

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
  // persist watch 的 try/catch 静默吞掉，测试内不残留噪声写
  resetPanelLayout()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: {} } as Awaited<ReturnType<typeof uiStateApi.get>>)
  vi.mocked(uiStateApi.patch).mockResolvedValue({} as Awaited<ReturnType<typeof uiStateApi.patch>>)
  await nextTick()
})

function shareManagerPatches(): unknown[] {
  return vi.mocked(uiStateApi.patch).mock.calls.filter(([body]) => {
    const rec = (body as Record<string, Record<string, unknown>>)['local']
    return !!rec && 'shareManager' in rec
  })
}

describe('shareManager 开态 watch 统一即时写（P-20261112-6-S3）', () => {
  it('toggleShareManager 开/关都即时落盘 shareManager.open', async () => {
    const panel = usePanelLayout()
    panel.toggleShareManager()
    await nextTick()
    expect(panel.showShareManager.value).toBe(true)
    expect(shareManagerPatches()).toEqual([
      [{ local: { shareManager: { open: true } } }, { silent: true }],
    ])

    panel.toggleShareManager()
    await nextTick()
    expect(panel.showShareManager.value).toBe(false)
    expect(shareManagerPatches()).toEqual([
      [{ local: { shareManager: { open: true } } }, { silent: true }],
      [{ local: { shareManager: { open: false } } }, { silent: true }],
    ])
  })

  it('主区互斥隐式关闭（开笔记视图收分享管理）同样落盘——散写必漏的路径', async () => {
    const panel = usePanelLayout()
    panel.toggleShareManager()
    await nextTick()
    vi.mocked(uiStateApi.patch).mockClear()

    panel.openNotesView()
    await nextTick()
    expect(panel.showShareManager.value).toBe(false)
    expect(shareManagerPatches()).toEqual([
      [{ local: { shareManager: { open: false } } }, { silent: true }],
    ])
  })
})

describe('restoreShareManagerOnce 刷新恢复（P-20261112-6-S3）', () => {
  it('存档开态 → 恢复置开并按 toggleShareManager 开分支语义清互斥视图', async () => {
    mockServerData({ local: { shareManager: { open: true }, dshConsole: { open: false } } })
    const panel = usePanelLayout()
    panel.showRemoteConsole.value = true
    panel.showNotesView.value = true

    await restoreShareManagerOnce()
    await nextTick()
    expect(panel.showShareManager.value).toBe(true)
    expect(panel.showRemoteConsole.value).toBe(false)
    expect(panel.showNotesView.value).toBe(false)
    expect(panel.showDshConsole.value).toBe(false)
    expect(panel.showDashboard.value).toBe(false)
  })

  it('存档关态 → 不恢复（旧存档无键 = 不恢复，零迁移）', async () => {
    mockServerData({})
    const panel = usePanelLayout()
    await restoreShareManagerOnce()
    expect(panel.showShareManager.value).toBe(false)
  })

  it('once 防重复：二次调用不重发请求', async () => {
    mockServerData({ local: { shareManager: { open: true } } })
    const panel = usePanelLayout()
    await restoreShareManagerOnce()
    const calls = vi.mocked(uiStateApi.get).mock.calls.length

    await restoreShareManagerOnce()
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBe(calls)
    expect(panel.showShareManager.value).toBe(true)
  })

  it('恢复定序 notes 先 → dsh 次 → share 后：异常双真存档 share 后到者胜出', async () => {
    mockServerData({ local: { notesView: { open: true }, dshConsole: { open: true }, shareManager: { open: true } } })
    const panel = usePanelLayout()

    await restoreShareManagerOnce()
    expect(panel.showShareManager.value).toBe(true)
    expect(panel.showNotesView.value).toBe(false)
    expect(panel.showDshConsole.value).toBe(false)
  })

  it('定序链只拉取一次：notes/dsh 宿主已发起的恢复不被 share 链重复', async () => {
    mockServerData({ local: { shareManager: { open: true } } })
    const panel = usePanelLayout()
    // 真实挂载流：notes 宿主（NotesView onMounted）→ dsh 链（HomeView/shell）→
    // share 链（shell boot 尾部）各调一次，memoized promise 共享在途恢复
    const notesP = restoreNotesViewOnce()
    const dshP = restoreDshConsoleOnce()
    const shareP = restoreShareManagerOnce()
    await Promise.all([notesP, dshP, shareP])
    // GET 次数 = notes/dsh/share 三读取器各一次（互斥恢复不重复拉取）
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBe(3)
    expect(panel.showShareManager.value).toBe(true)
  })

  it('resetPanelLayout 复位 once 守卫：复位后再次恢复重新拉取', async () => {
    mockServerData({ local: { shareManager: { open: true } } })
    const panel = usePanelLayout()
    await restoreShareManagerOnce()
    expect(panel.showShareManager.value).toBe(true)
    const calls = vi.mocked(uiStateApi.get).mock.calls.length

    resetPanelLayout()
    // 排空复位触发的关态补丁：persist 写经 mergeKnownAll 会原地改写 loadState
    // 别名进 lastKnownAll 的 mock 数据对象（notesOpenPersist 套件同款规避），
    // 再换一份全新 mock 供二次恢复读取
    await nextTick()
    mockServerData({ local: { shareManager: { open: true } } })
    await restoreShareManagerOnce()
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBeGreaterThan(calls)
    expect(panel.showShareManager.value).toBe(true)
  })
})
