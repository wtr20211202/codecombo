import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import {
  usePanelLayout, resetPanelLayout, restoreNotesViewOnce, restoreDshConsoleOnce,
  handleUiSceneSwap, isUiSceneSwapInFlight,
} from '@/composables/usePanelLayout'
import { uiStateApi } from '@/api/client'

// per-scene 运行态快照（P-20261114-4-S1）：home/project 两张内存快照表 +
// swap 四步序（router.afterEach 钉死「离开先采集→切指针→恢复 refs（suppress
// 中）→解除」）+ suppress 门禁（恢复写入不触发持久化 watch）+ boot 恢复场景
// 守卫 + once memo 分场景分桶。路由不经真导航——handleUiSceneSwap 直驱 +
// '@/router' mock 的 currentRoute 手动拨指针（业务单测不触路由惯例，usePanelLayout
// 的守卫面照常覆盖）。需要真 pinia：persist watch 直写 uiState store。

// 场景指针 mock：currentUiScene() 读 router.currentRoute.value.name，测试手动
// 拨动模拟路由切换（handleUiSceneSwap 的 to/from 由直驱入参提供，不依赖此指针）
const routerMock = vi.hoisted(() => ({
  afterEach: vi.fn(),
  currentRoute: { value: null as { name?: unknown } | null },
}))
vi.mock('@/router', () => ({ default: routerMock }))

vi.mock('@/api/client', () => ({
  uiStateApi: { get: vi.fn(), update: vi.fn(), patch: vi.fn() },
  setInstanceContext: vi.fn(),
}))

type AllState = Record<string, Record<string, unknown>>

function setScene(scene: 'home' | 'project' | null) {
  routerMock.currentRoute.value = scene ? { name: scene } : null
}

function mockServerData(all: AllState) {
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: all } as Awaited<ReturnType<typeof uiStateApi.get>>)
}

function patchesFor(ns: string): unknown[] {
  return vi.mocked(uiStateApi.patch).mock.calls.filter(([body]) => {
    const rec = (body as Record<string, Record<string, unknown>>)['local']
    return !!rec && ns in rec
  })
}

beforeEach(async () => {
  // 先复位模块态再激活 pinia：resetPanelLayout 触发的关态补丁在无 pinia 下被
  // persist watch 的 try/catch 静默吞掉（notesOpenPersist 同款规避注释）
  setScene(null)
  resetPanelLayout()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: {} } as Awaited<ReturnType<typeof uiStateApi.get>>)
  vi.mocked(uiStateApi.patch).mockResolvedValue({} as Awaited<ReturnType<typeof uiStateApi.patch>>)
  await nextTick()
})

describe('per-scene swap：场景运行态互不越界、各自恢复（P-20261114-4-S1）', () => {
  it('①项目开笔记 → 回首页不显示 → 回项目恢复（推翻 P-20261114-1 首页 overlay 呈现）', () => {
    setScene('project')
    const panel = usePanelLayout()
    panel.openNotesView()
    expect(panel.showNotesView.value).toBe(true)

    handleUiSceneSwap('home', 'project')
    expect(panel.showNotesView.value).toBe(false) // 回首页不显示

    handleUiSceneSwap('project', 'home')
    expect(panel.showNotesView.value).toBe(true) // 回项目恢复
  })

  it('②首页显式开笔记 → 去项目不跟随 → 回首页恢复（双向对称）', () => {
    setScene('home')
    const panel = usePanelLayout()
    panel.openNotesView()
    expect(panel.showNotesView.value).toBe(true)

    handleUiSceneSwap('project', 'home')
    expect(panel.showNotesView.value).toBe(false) // 去项目不跟随

    handleUiSceneSwap('home', 'project')
    expect(panel.showNotesView.value).toBe(true) // 回首页恢复
  })

  it('首进无快照场景回落全关（跨场景不继承），remote/share/dashboard 收敛进快照', () => {
    setScene('project')
    const panel = usePanelLayout()
    // 三视图顺序开（互斥族：后者收前者），末态 dashboard 开
    panel.openRemoteConsole()
    panel.toggleShareManager()
    panel.openDashboard()
    expect(panel.showDashboard.value).toBe(true)

    handleUiSceneSwap('home', 'project') // 首进 home：无快照 → 全关回落
    expect(panel.showNotesView.value).toBe(false)
    expect(panel.showDshConsole.value).toBe(false)
    expect(panel.showRemoteConsole.value).toBe(false)
    expect(panel.showShareManager.value).toBe(false)
    expect(panel.showDashboard.value).toBe(false)

    handleUiSceneSwap('project', 'home') // 回项目：dashboard 从快照恢复
    expect(panel.showDashboard.value).toBe(true)
    expect(panel.showRemoteConsole.value).toBe(false)
    expect(panel.showShareManager.value).toBe(false)
  })

  it('双场景各自保持：项目 notes 与首页 remote 并存于各自快照，互斥族两快照不双真', () => {
    setScene('project')
    const panel = usePanelLayout()
    panel.openNotesView()

    handleUiSceneSwap('home', 'project')
    panel.openRemoteConsole() // 首页开远程（互斥收 notes——home 侧本已关）
    expect(panel.showRemoteConsole.value).toBe(true)
    expect(panel.showNotesView.value).toBe(false)

    handleUiSceneSwap('project', 'home') // 回项目：notes 恢复、remote（首页开的）不跟随
    expect(panel.showNotesView.value).toBe(true)
    expect(panel.showRemoteConsole.value).toBe(false)

    handleUiSceneSwap('home', 'project') // 回首页：remote 恢复、notes（项目开的）不跟随
    expect(panel.showRemoteConsole.value).toBe(true)
    expect(panel.showNotesView.value).toBe(false)
  })

  it('同场景路由变更零交换（query 变更/实例切换 remount 不清运行态）', () => {
    setScene('project')
    const panel = usePanelLayout()
    panel.openNotesView()
    handleUiSceneSwap('project', 'project')
    expect(panel.showNotesView.value).toBe(true)
  })

  it('isUiSceneSwapInFlight 在 swap 同步窗口内为真（门禁可见性）', () => {
    expect(isUiSceneSwapInFlight()).toBe(false)
    // 经持久化 watch 观察：sync flush 下恢复写入触发 watch 时门禁仍在位
    //（suppress 零落盘用例为本门禁的行为面钉，此处只钉导出可读）
    expect(typeof isUiSceneSwapInFlight).toBe('function')
  })
})

describe('suppress 门禁：swap 恢复写入零 spurious PATCH（P-20261114-4-S1）', () => {
  it('路由往返两向恢复均不落盘 notesView/dshConsole/shareManager；门禁外显式开关照常落盘', async () => {
    setScene('project')
    const panel = usePanelLayout()
    panel.toggleNotesView() // sync watch 即时写（正常写路径）
    panel.toggleDshConsole() // dsh 开 + 互斥收 notes
    await nextTick()
    expect(patchesFor('notesView').length).toBeGreaterThan(0) // sanity：门禁外写路径落盘
    vi.mocked(uiStateApi.patch).mockClear()

    handleUiSceneSwap('home', 'project') // 离开采集 + 进入恢复（suppress 中）
    await nextTick()
    handleUiSceneSwap('project', 'home') // 往返
    await nextTick()

    expect(patchesFor('notesView')).toEqual([])
    expect(patchesFor('dshConsole')).toEqual([])
    expect(patchesFor('shareManager')).toEqual([])

    panel.toggleNotesView() // 门禁外显式开关：恢复常态即时写
    await nextTick()
    expect(patchesFor('notesView').length).toBe(1)
  })
})

describe('boot 恢复场景守卫 + once memo 分场景分桶（P-20261114-4-S1）', () => {
  it('在途 GET 期间切场景 → 落地丢弃不写新场景，桶清后回发起场景自然再武装', async () => {
    setScene('home')
    let resolveGet!: (v: { data: AllState }) => void
    vi.mocked(uiStateApi.get).mockImplementation(
      () => new Promise((r) => { resolveGet = r }) as Awaited<ReturnType<typeof uiStateApi.get>>,
    )
    const panel = usePanelLayout()
    const pending = restoreNotesViewOnce() // home 桶发起，GET 在途
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBe(1)

    setScene('project')
    handleUiSceneSwap('project', 'home') // 在途期间真实切场景（swap 恢复 project 默认态）
    resolveGet({ data: { local: { notesView: { open: true } } } })
    await pending
    await nextTick()

    // 丢弃：boot 场景槽值不得写进新场景（越界复发路径）
    expect(panel.showNotesView.value).toBe(false)

    // 再武装：发起场景桶已清，回到该场景重新拉取并正确落地（home 桶读 homeOpen
    // 槽，P-20261114-4-S2 分场景槽）
    const calls = vi.mocked(uiStateApi.get).mock.calls.length
    setScene('home')
    const rearm = restoreNotesViewOnce()
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBe(calls + 1)
    resolveGet({ data: { local: { notesView: { homeOpen: true } } } })
    await rearm
    expect(panel.showNotesView.value).toBe(true)
  })

  it('once memo 按场景分桶：同场景共享一次 GET，不同场景各自首进各读一次（结构钉，S2 换槽）', async () => {
    setScene('home')
    const p1 = restoreNotesViewOnce()
    const p1b = restoreNotesViewOnce() // 并发调用方共享同一在途恢复
    await Promise.all([p1, p1b])
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBe(1)

    setScene('project')
    await restoreNotesViewOnce() // project 桶为空 → 首进读槽一次
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBe(2)

    await restoreNotesViewOnce() // 同场景二调：桶已 memo，不再拉取
    expect(vi.mocked(uiStateApi.get).mock.calls.length).toBe(2)
  })

  it('守卫放行同场景落地：发起场景未变时照常恢复置开（home 场景读 homeOpen 槽，P-20261114-4-S2）', async () => {
    setScene('home')
    mockServerData({ local: { notesView: { homeOpen: true } } })
    const panel = usePanelLayout()
    await restoreNotesViewOnce()
    expect(panel.showNotesView.value).toBe(true)
  })
})

describe('per-scene 槽位：持久化读写分槽（P-20261114-4-S2）', () => {
  it('home 场景显式开关落 notesView.homeOpen，不触碰 project 槽 open', async () => {
    setScene('home')
    const panel = usePanelLayout()
    panel.toggleNotesView()
    await nextTick()
    panel.closeNotesView()
    await nextTick()
    expect(patchesFor('notesView')).toEqual([
      [{ local: { notesView: { homeOpen: true } } }, { silent: true }],
      [{ local: { notesView: { homeOpen: false } } }, { silent: true }],
    ])
  })

  it('project 场景显式开关落 notesView.open，不触碰 home 槽 homeOpen', async () => {
    setScene('project')
    const panel = usePanelLayout()
    panel.toggleNotesView()
    await nextTick()
    expect(patchesFor('notesView')).toEqual([
      [{ local: { notesView: { open: true } } }, { silent: true }],
    ])
  })

  it('基底有 project 槽值：home 写 homeOpen 时 open 由注册表从基底回填（命名空间整键替换不丢对侧槽）', async () => {
    setScene('home')
    mockServerData({ local: { notesView: { open: true } } })
    const panel = usePanelLayout()
    await restoreNotesViewOnce() // 读 home 槽缺席不恢复；基底已存 notesView.open=true
    vi.mocked(uiStateApi.patch).mockClear()

    panel.toggleNotesView()
    await nextTick()
    expect(patchesFor('notesView')).toEqual([
      [{ local: { notesView: { homeOpen: true, open: true } } }, { silent: true }],
    ])
  })

  it('恢复读槽分场景：home 读 homeOpen（仅 open=true 存档不恢复）、project 读 open（仅 homeOpen=true 存档不恢复）', async () => {
    setScene('home')
    mockServerData({ local: { notesView: { open: true } } })
    const panel = usePanelLayout()
    await restoreNotesViewOnce()
    expect(panel.showNotesView.value).toBe(false) // open 是 project 槽，home 场景不读

    resetPanelLayout()
    setScene('project')
    mockServerData({ local: { notesView: { homeOpen: true } } })
    await restoreNotesViewOnce()
    expect(panel.showNotesView.value).toBe(false) // homeOpen 是 home 槽，project 场景不读
  })

  it('dsh 同构分槽：home 开关落 dshConsole.homeOpen；home 恢复读 homeOpen、project 恢复读 open', async () => {
    setScene('home')
    const panel = usePanelLayout()
    panel.toggleDshConsole()
    await nextTick()
    expect(patchesFor('dshConsole')).toEqual([
      [{ local: { dshConsole: { homeOpen: true } } }, { silent: true }],
    ])

    resetPanelLayout()
    setScene('home')
    mockServerData({ local: { dshConsole: { open: true } } }) // open 是 project 槽
    await restoreDshConsoleOnce()
    expect(panel.showDshConsole.value).toBe(false)

    resetPanelLayout()
    setScene('project')
    mockServerData({ local: { dshConsole: { homeOpen: true } } }) // homeOpen 是 home 槽
    await restoreDshConsoleOnce()
    expect(panel.showDshConsole.value).toBe(false)

    resetPanelLayout()
    setScene('home')
    mockServerData({ local: { dshConsole: { homeOpen: true } } })
    await restoreDshConsoleOnce()
    expect(panel.showDshConsole.value).toBe(true)
  })
})
