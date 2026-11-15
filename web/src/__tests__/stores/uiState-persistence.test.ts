import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useUIStateStore, diffChangedKeys, uiJsonValueEqual, NESTED_UISTATE_SUBFIELDS } from '@/stores/uiState'
import { uiStateApi } from '@/api/client'

// uiState 持久化语义测试（P-20261002-8 键级补丁）：写入从「GET 全量→合并→PUT
// 整包」改为「内存基底脏键 diff→PATCH 只发变更键」——多标签页同开一项目时
// 各改各的键互不覆盖，无变更零请求。命名空间读取器（脏数据防御）测试保留
// 在本文件（读取器与写入语义解耦，改动面不涉及其断言）。基础读写见同目录
// uiState.test.ts。

vi.mock('@/api/client', () => ({
  uiStateApi: { get: vi.fn(), update: vi.fn(), patch: vi.fn() },
  setInstanceContext: vi.fn(),
}))

type AllState = Record<string, Record<string, unknown>>

/** 让服务端 GET 返回指定全量数据 */
function mockServerData(all: AllState) {
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: all } as Awaited<ReturnType<typeof uiStateApi.get>>)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.mocked(uiStateApi.update).mockResolvedValue({} as Awaited<ReturnType<typeof uiStateApi.update>>)
  vi.mocked(uiStateApi.patch).mockResolvedValue({} as Awaited<ReturnType<typeof uiStateApi.patch>>)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ============== 命名空间读取器（脏数据防御，与 P-20261002-8 改动面解耦） ==============

describe('uiStateStore 命名空间读取器（脏数据防御）', () => {
  it('getAgentTerminalState：服务端无数据时全部回落默认值', async () => {
    mockServerData({})
    const store = useUIStateStore()
    await expect(store.getAgentTerminalState()).resolves.toEqual({
      groups: [],
      sidebarCollapsed: false,
      collapsedProjects: [],
      collapsedGroups: [],
      projectOrder: [],
      projectSessionOrder: {},
      lastViewedSessionId: '',
    })
  })

  it('getAgentTerminalState：groups 等脏形状回落空表（防管理页 boot 数组操作崩溃）', async () => {
    mockServerData({
      local: {
        agentTerminal: {
          groups: 'corrupted',
          sidebarCollapsed: 1,
          collapsedProjects: 'nope',
          collapsedGroups: 3,
          projectOrder: null,
          projectSessionOrder: ['array-not-object'],
          lastViewedSessionId: 42,
        },
      },
    })
    const store = useUIStateStore()
    await expect(store.getAgentTerminalState()).resolves.toEqual({
      groups: [],
      sidebarCollapsed: true,
      collapsedProjects: [],
      collapsedGroups: [],
      projectOrder: [],
      projectSessionOrder: {},
      lastViewedSessionId: '',
    })
  })

  it('getAgentTerminalState：合法数据原样透出', async () => {
    const groups = [{ id: 'g1', name: '组1', sessionIds: ['t1'] }]
    mockServerData({
      local: {
        agentTerminal: {
          groups,
          sidebarCollapsed: true,
          collapsedProjects: ['p1'],
          collapsedGroups: ['g1'],
          projectOrder: ['p2', 'p1'],
          projectSessionOrder: { p1: ['t2', 't1'] },
          lastViewedSessionId: 't2',
        },
      },
    })
    const store = useUIStateStore()
    const state = await store.getAgentTerminalState()
    expect(state.groups).toEqual(groups)
    expect(state.collapsedGroups).toEqual(['g1'])
    expect(state.projectSessionOrder).toEqual({ p1: ['t2', 't1'] })
    expect(state.lastViewedSessionId).toBe('t2')
  })

  it('getRemoteConsoleState：缺省回落空 tabs/分组与关闭态', async () => {
    mockServerData({ local: {} })
    const store = useUIStateStore()
    await expect(store.getRemoteConsoleState()).resolves.toEqual({
      tabs: [],
      groups: [],
      open: false,
      sidebarCollapsed: false,
    })
  })

  it('getRemoteConsoleState：合法数据透出（open/sidebarCollapsed 归一为布尔）', async () => {
    mockServerData({
      local: {
        remoteConsole: {
          tabs: [{ hostId: 'h1', sessionId: 's1', title: 'web-1' }],
          groups: [{ id: 'g1', name: '前端', hostIds: ['h1'] }],
          open: 1,
          sidebarCollapsed: 'yes',
        },
      },
    })
    const store = useUIStateStore()
    const state = await store.getRemoteConsoleState()
    expect(state.tabs).toHaveLength(1)
    expect(state.open).toBe(true)
    expect(state.sidebarCollapsed).toBe(true)
  })

  it('getDshConsoleOpen：缺省 false，落盘 true 后读到 true', async () => {
    mockServerData({})
    const store = useUIStateStore()
    await expect(store.getDshConsoleOpen()).resolves.toBe(false)

    await store.saveDshConsoleOpen(true)
    mockServerData({ local: { dshConsole: { open: true } } })
    await expect(store.getDshConsoleOpen()).resolves.toBe(true)
  })

  it('getNotesViewOpen：缺省/旧存档无键 false，落盘 true 后读到 true（P-20261112-6-S1）', async () => {
    // 旧数据面（无 notesView 键）= 不恢复按关处理，零迁移
    mockServerData({})
    const store = useUIStateStore()
    await expect(store.getNotesViewOpen()).resolves.toBe(false)

    await store.saveNotesViewOpen(true)
    mockServerData({ local: { notesView: { open: true } } })
    await expect(store.getNotesViewOpen()).resolves.toBe(true)
  })

  it('notesView/dsh 分场景槽：home 读写 homeOpen、project 读写 open，两槽互不覆写（P-20261114-4-S2）', async () => {
    mockServerData({})
    const store = useUIStateStore()

    // home 场景：写 homeOpen 槽，open（project 槽）不出现
    await store.saveNotesViewOpen(true, 'home')
    await store.saveDshConsoleOpen(true, 'home')
    const homePatch = vi.mocked(uiStateApi.patch).mock.calls.at(-2)![0] as AllState
    const dshHomePatch = vi.mocked(uiStateApi.patch).mock.calls.at(-1)![0] as AllState
    expect(homePatch.local?.notesView).toEqual({ homeOpen: true })
    expect(dshHomePatch.local?.dshConsole).toEqual({ homeOpen: true })

    // project 场景：写 open 槽；前两笔 home 写已把 homeOpen 推进基底，本补丁缺
    // homeOpen 子键由注册表从基底回填（命名空间整键替换不丢对侧槽——回填即
    // 「不覆写」的实现机制）
    vi.mocked(uiStateApi.patch).mockClear()
    await store.saveNotesViewOpen(true, 'project')
    const projPatch = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(projPatch.local?.notesView).toEqual({ open: true, homeOpen: true })

    // 读取分槽：home 读 homeOpen、project 读 open，互不串槽
    mockServerData({ local: { notesView: { open: true }, dshConsole: { homeOpen: true } } })
    await expect(store.getNotesViewOpen('home')).resolves.toBe(false)
    await expect(store.getNotesViewOpen('project')).resolves.toBe(true)
    await expect(store.getDshConsoleOpen('home')).resolves.toBe(true)
    await expect(store.getDshConsoleOpen('project')).resolves.toBe(false)
    // null（无路由环境/单测）按 project 槽——既有单测语义零变化
    await expect(store.getNotesViewOpen()).resolves.toBe(true)
  })

  it('getNotesViewActiveId：缺省/脏值回落 \'\'，落盘后读到 id（P-20261112-6-S2）', async () => {
    mockServerData({})
    const store = useUIStateStore()
    // 旧数据面无 notesView.activeId = ''（loadList 两段式第二段天然兜底）
    await expect(store.getNotesViewActiveId()).resolves.toBe('')

    // 手改 JSON 的脏值（数字）回落 ''，防下游把非串当篇 id 比对
    mockServerData({ local: { notesView: { activeId: 42 } } })
    await expect(store.getNotesViewActiveId()).resolves.toBe('')

    await store.saveNotesViewActiveId('n-abc')
    mockServerData({ local: { notesView: { activeId: 'n-abc' } } })
    await expect(store.getNotesViewActiveId()).resolves.toBe('n-abc')
  })

  it('saveNotesViewActiveId 键级补丁：open 子键经注册表回填不被整键替换剥掉（P-20261112-6-S2）', async () => {
    // 基底已存开态（S1 三件套写入）：saveNotesViewActiveId 只带 activeId 补丁，
    // finalizeRecord 依 NESTED_UISTATE_SUBFIELDS 从内存基底回填 open——命名空间
    // 级浅合并（服务端整键替换）不丢开态（钉选丢失根因模式的防线兑现）。
    // 基底经读取器预热（loadState 进 lastKnownAll，真实链路是 boot 先读后写）
    mockServerData({ local: { notesView: { open: true } } })
    const store = useUIStateStore()
    await store.getNotesViewActiveId()
    await store.saveNotesViewActiveId('n-abc') // patchNamespaces 即时写，await 即已发出
    expect(vi.mocked(uiStateApi.patch)).toHaveBeenCalledWith(
      { local: { notesView: { open: true, activeId: 'n-abc' } } },
      { silent: true },
    )
  })

  it('getShareManagerOpen：缺省/旧存档无键 false，落盘 true 后读到 true（P-20261112-6-S3）', async () => {
    mockServerData({})
    const store = useUIStateStore()
    await expect(store.getShareManagerOpen()).resolves.toBe(false)

    await store.saveShareManagerOpen(true)
    mockServerData({ local: { shareManager: { open: true } } })
    await expect(store.getShareManagerOpen()).resolves.toBe(true)
  })

  it('getNotesViewPresentation：缺省/脏值回落 null/\'\'（出厂口径），落盘后读到呈现态（P-20261112-6-S3）', async () => {
    mockServerData({})
    const store = useUIStateStore()
    // 旧数据面无呈现态子键：null/'' = 消费端回落出厂（sidebarOpen 窄屏收起、mode edit）
    await expect(store.getNotesViewPresentation()).resolves.toEqual({ sidebarOpen: null, mode: '' })

    // 手改 JSON 的脏值（数字/未知枚举）一律回落，防下游把非布尔/非枚举当呈现态
    mockServerData({ local: { notesView: { sidebarOpen: 1, mode: 'dialog' } } })
    await expect(store.getNotesViewPresentation()).resolves.toEqual({ sidebarOpen: null, mode: '' })

    await store.saveNotesViewSidebarOpen(false)
    await store.saveNotesViewMode('preview')
    mockServerData({ local: { notesView: { sidebarOpen: false, mode: 'preview' } } })
    await expect(store.getNotesViewPresentation()).resolves.toEqual({ sidebarOpen: false, mode: 'preview' })
  })

  it('saveNotesViewSidebarOpen 键级补丁：open/activeId 子键经注册表回填不被整键替换剥掉（P-20261112-6-S3）', async () => {
    // 基底已存开态+活动篇（S1/S2 写入）：呈现态写端只带 sidebarOpen 补丁，注册表
    // 从基底回填同族子键——notesView 命名空间整键替换不丢既有写作现场
    mockServerData({ local: { notesView: { open: true, activeId: 'n-abc' } } })
    const store = useUIStateStore()
    await store.getNotesViewPresentation()
    await store.saveNotesViewSidebarOpen(false)
    expect(vi.mocked(uiStateApi.patch)).toHaveBeenCalledWith(
      { local: { notesView: { open: true, activeId: 'n-abc', sidebarOpen: false } } },
      { silent: true },
    )
  })

  it('getDashboardLanding：缺省 false，落盘 true 后读到 true（P-20261005-224）', async () => {
    mockServerData({})
    const store = useUIStateStore()
    await expect(store.getDashboardLanding()).resolves.toBe(false)

    await store.saveDashboardLanding(true)
    mockServerData({ local: { dashboard: { landing: true } } })
    await expect(store.getDashboardLanding()).resolves.toBe(true)
  })

  it('getNotificationLastSeenAt：缺省/脏值回落 0，落盘后读到时点（P-20261003-259）', async () => {
    mockServerData({})
    const store = useUIStateStore()
    await expect(store.getNotificationLastSeenAt()).resolves.toBe(0)

    // 旧数据面无字段 / 手改 JSON 的脏值（字符串、负数、NaN 形态）一律无基线
    mockServerData({ local: { notificationCenter: { lastSeenAt: '123' } } })
    await expect(store.getNotificationLastSeenAt()).resolves.toBe(0)
    mockServerData({ local: { notificationCenter: { lastSeenAt: -5 } } })
    await expect(store.getNotificationLastSeenAt()).resolves.toBe(0)

    await store.saveNotificationLastSeenAt(1_760_000_000_000)
    mockServerData({ local: { notificationCenter: { lastSeenAt: 1_760_000_000_000 } } })
    await expect(store.getNotificationLastSeenAt()).resolves.toBe(1_760_000_000_000)
  })

  it('getTaskRunnerRecent：过滤非条目形状（含旧版字符串键）并保序', async () => {
    mockServerData({
      local: {
        taskRunner: {
          recent: [
            { task: { source: 'npm', name: 'test', command: 'npm run test', cwd: '' }, at: 200 },
            'legacy::/x::key', // 旧版键：无法还原命令，丢弃
            3,
            null,
            { task: { source: 'go', name: 'build', command: 'go build ./...', cwd: 'cmd/x' }, at: 100 },
            { task: { source: 'npm', name: 'broken' }, at: 50 }, // 缺 command/cwd：丢弃
          ],
        },
      },
    })
    const store = useUIStateStore()
    await expect(store.getTaskRunnerRecent()).resolves.toEqual([
      { task: { source: 'npm', name: 'test', command: 'npm run test', cwd: '' }, at: 200 },
      { task: { source: 'go', name: 'build', command: 'go build ./...', cwd: 'cmd/x' }, at: 100 },
    ])
  })

  it('getTaskRunnerRecent：recent 非数组或 API 失败时空表', async () => {
    mockServerData({ local: { taskRunner: { recent: 'corrupted' } } })
    const store = useUIStateStore()
    await expect(store.getTaskRunnerRecent()).resolves.toEqual([])

    vi.mocked(uiStateApi.get).mockRejectedValue(new Error('down'))
    await expect(store.getTaskRunnerRecent()).resolves.toEqual([])
  })

  it('getEditorMdModePreference：合法值直读，缺记录/脏值回落 undefined（宿主保留 split 默认）', async () => {
    mockServerData({ local: { editorPrefs: { mdMode: 'preview' } } })
    const store = useUIStateStore()
    await expect(store.getEditorMdModePreference()).resolves.toBe('preview')

    mockServerData({ local: { editorPrefs: { mdMode: 'corrupted' } } })
    await expect(store.getEditorMdModePreference()).resolves.toBeUndefined()

    mockServerData({ local: {} })
    await expect(store.getEditorMdModePreference()).resolves.toBeUndefined()
  })
})

// ============== 纯函数：脏键 diff ==============

describe('diffChangedKeys / uiJsonValueEqual（脏键跟踪纯函数）', () => {
  it('值等价判定按值不按引用/键序：collect 序与服务端合并序不同不算变化', () => {
    expect(uiJsonValueEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true)
    expect(uiJsonValueEqual(['x', 'y'], ['x', 'y'])).toBe(true)
    expect(uiJsonValueEqual(null, null)).toBe(true)
    expect(uiJsonValueEqual(undefined, undefined)).toBe(true)
  })

  it('深层差异可检出：嵌套命名空间字段 / 数组长度 / 标量类型', () => {
    expect(uiJsonValueEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(uiJsonValueEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false)
    expect(uiJsonValueEqual(['a'], ['a', 'b'])).toBe(false)
    expect(uiJsonValueEqual({ a: 1 }, { a: '1' })).toBe(false)
    expect(uiJsonValueEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(uiJsonValueEqual(1, true)).toBe(false)
  })

  it('无变化返回 null（零写）；有变化只返回变更键', () => {
    const base = { layout: { w: 280 }, editor: { openFiles: ['a'] }, projectId: 'p1' }
    expect(diffChangedKeys({ ...base }, base)).toBeNull()
    expect(diffChangedKeys({ ...base, layout: { w: 460 } }, base)).toEqual({ layout: { w: 460 } })
    expect(diffChangedKeys({ ...base, projectId: 'p2', editor: { openFiles: [] } }, base)).toEqual({
      projectId: 'p2',
      editor: { openFiles: [] },
    })
  })

  it('基底缺失/未含键：state 自身键全部视为变更；base 多出的键不进补丁', () => {
    expect(diffChangedKeys({ layout: { w: 1 } }, undefined)).toEqual({ layout: { w: 1 } })
    // base 里有 agentTerminal 而 state 没有 → 不产出（服务端合并天然保留）
    const out = diffChangedKeys({ layout: { w: 1 } }, { layout: { w: 1 }, agentTerminal: { x: 1 } })
    expect(out).toBeNull()
  })
})

// ============== 保存语义（键级补丁） ==============

describe('uiStateStore 保存语义（脏键 diff / 防抖 / PATCH）', () => {
  it('saveCurrentState 只发相对基底的变更键：未动过的命名空间不外发', async () => {
    const base = {
      instanceId: 'local',
      projectId: 'p1',
      layout: { sidePanelWidth: 460, bottomPanelHeight: 260, showSidePanel: true, showBottomPanel: false, sideView: 'files', bottomTab: 'git' },
      editor: { openFiles: ['a.ts'], activeIndex: 0, splitOpen: false },
      remoteConsole: { tabs: [{ hostId: 'h1', sessionId: 's1', title: 't' }] },
      agentTerminal: { groups: [{ id: 'g1', name: '组', sessionIds: [] }] },
    }
    mockServerData({ local: base })
    const store = useUIStateStore()
    await store.loadState() // 建立内存基底

    await store.saveCurrentState({
      ...base,
      instanceId: 'local',
      layout: { ...base.layout, sidePanelWidth: 280 },
    } as Parameters<typeof store.saveCurrentState>[0])

    await vi.advanceTimersByTimeAsync(500)
    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    // 只带 layout：projectId/editor 原值与 collect 不到的 remoteConsole/agentTerminal 都不在补丁里
    expect(Object.keys(payload.local!)).toEqual(['layout'])
    expect((payload.local!.layout as Record<string, unknown>).sidePanelWidth).toBe(280)
  })

  it('saveCurrentState 相对基底无变更 → 零请求（零写）', async () => {
    const base = {
      instanceId: 'local',
      projectId: 'p1',
      layout: { sidePanelWidth: 460, bottomPanelHeight: 260, showSidePanel: true, showBottomPanel: false, sideView: 'files', bottomTab: 'git' },
      editor: { openFiles: ['a.ts'], activeIndex: 0, splitOpen: false },
      fileTree: { expandedDirs: ['src'], selectedFile: 'src/a.ts' },
      terminal: { activeTabId: '' },
      gitPanel: { collapsedSections: [], selectedBranch: '' },
    }
    mockServerData({ local: base })
    const store = useUIStateStore()
    await store.loadState()

    await store.saveCurrentState({ ...base, instanceId: 'local' } as Parameters<typeof store.saveCurrentState>[0])
    await vi.advanceTimersByTimeAsync(2000)
    expect(uiStateApi.patch).not.toHaveBeenCalled()
    expect(uiStateApi.update).not.toHaveBeenCalled()
  })

  it('saveCurrentState 防抖 500ms：窗口内重复保存只落盘最后一次（整体替换待发集）', async () => {
    mockServerData({})
    const store = useUIStateStore()
    await store.loadState()

    await store.saveCurrentState({ projectId: 'p1' })
    await vi.advanceTimersByTimeAsync(100)
    await store.saveCurrentState({ projectId: 'p2' })

    await vi.advanceTimersByTimeAsync(400)
    expect(uiStateApi.patch).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(payload.local?.projectId).toBe('p2')
  })

  it('saveCurrentState 改了又改回：变更集收缩为空 → 不发请求', async () => {
    mockServerData({ local: { projectId: 'p1' } })
    const store = useUIStateStore()
    await store.loadState()

    await store.saveCurrentState({ projectId: 'p2' })
    await store.saveCurrentState({ projectId: 'p1' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(uiStateApi.patch).not.toHaveBeenCalled()
  })

  it('PATCH 落定后推进内存基底：同一状态再存不发重复请求', async () => {
    mockServerData({})
    const store = useUIStateStore()
    await store.loadState()

    await store.saveCurrentState({ projectId: 'p1' })
    await vi.advanceTimersByTimeAsync(500)
    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)

    await store.saveCurrentState({ projectId: 'p1' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
  })

  it('saveRemoteConsoleState 键级补丁：只动 remoteConsole 字段（不再 GET 全量）', async () => {
    mockServerData({ local: { agentTerminal: { groups: [{ id: 'g1', name: '组', sessionIds: [] }] } } })
    const store = useUIStateStore()
    await store.saveRemoteConsoleState(
      [{ hostId: 'h1', sessionId: 's1', title: 'web' }],
      [{ id: 'g1', name: '前端', hostIds: ['h1'] }],
      true,
      false,
    )

    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    expect(uiStateApi.get).not.toHaveBeenCalled()
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(payload.local?.remoteConsole).toEqual({
      tabs: [{ hostId: 'h1', sessionId: 's1', title: 'web' }],
      groups: [{ id: 'g1', name: '前端', hostIds: ['h1'] }],
      open: true,
      sidebarCollapsed: false,
    })
    expect(payload.local?.agentTerminal).toBeUndefined() // 保留交服务端合并
  })

  it('saveRemoteConsoleState persistOpen=false：不落 open 子键（P-20261114-4-S2 首页 overlay 场景写面门禁），基底有 open 时注册表回填保值', async () => {
    const store = useUIStateStore()
    // 无基底：open 缺席（首次使用场景，读取端 !! 归一 false）
    await store.saveRemoteConsoleState(
      [{ hostId: 'h1', sessionId: 's1', title: 'web' }], [], true, false, false,
    )
    const bare = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(bare.local?.remoteConsole).toEqual({
      tabs: [{ hostId: 'h1', sessionId: 's1', title: 'web' }],
      groups: [],
      sidebarCollapsed: false,
    })

    // 基底有 open（项目页曾开）：缺 open 子键由 NESTED_UISTATE_SUBFIELDS 从基底
    // 回填——首页 overlay 开合回声不腐蚀 project 槽
    mockServerData({ local: { remoteConsole: { open: true, tabs: [], groups: [] } } })
    await store.loadState()
    vi.mocked(uiStateApi.patch).mockClear()
    await store.saveRemoteConsoleState(
      [{ hostId: 'h1', sessionId: 's1', title: 'web' }], [], false, false, false,
    )
    const backfilled = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(backfilled.local?.remoteConsole).toEqual({
      tabs: [{ hostId: 'h1', sessionId: 's1', title: 'web' }],
      groups: [],
      sidebarCollapsed: false,
      open: true, // 从基底回填，project 槽零影响
    })
  })

  it('saveEditorMdModePreference 键级补丁：只动 editorPrefs 字段', async () => {
    mockServerData({})
    const store = useUIStateStore()
    await store.saveEditorMdModePreference('source')

    // 命名空间 setter 即时落盘（不等 500ms 防抖——切换后立刻刷新也要能恢复）
    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(Object.keys(payload.local!)).toEqual(['editorPrefs'])
    expect(payload.local?.editorPrefs).toEqual({ mdMode: 'source' })
  })

  it('saveAgentTerminalState 键级补丁且推进基底', async () => {
    mockServerData({})
    const store = useUIStateStore()
    await store.loadState()

    await store.saveAgentTerminalState({
      groups: [{ id: 'g1', name: '组', sessionIds: ['t1'] }],
      sidebarCollapsed: false,
      collapsedProjects: [],
      collapsedGroups: ['g1'],
      projectOrder: [],
      projectSessionOrder: {},
      lastViewedSessionId: 't1',
    })

    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(payload.local?.agentTerminal?.lastViewedSessionId).toBe('t1')
  })

  it('即时写失败记入未达账：关页 forceSave 并入重试（低频写不因网络抖动丢失）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    mockServerData({})
    const store = useUIStateStore()
    await store.loadState()

    vi.mocked(uiStateApi.patch).mockRejectedValueOnce(new Error('down'))
    await store.saveEditorBookmarks({ p1: { 'a.ts': [1, 2] } }) // PATCH 失败
    // 同键后不再重试成功 → 关页时未达账把当前内存值并进补丁
    store.forceSaveCurrentState({ projectId: 'p9' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/ui-state')
    expect(init.method).toBe('PATCH')
    expect(init.keepalive).toBe(true)
    const body = JSON.parse(String(init.body)) as AllState
    expect(body.local?.projectId).toBe('p9')
    expect(body.local?.bookmarks).toEqual({ p1: { 'a.ts': [1, 2] } })
  })

  it('forceSaveCurrentState 零改动关页：什么都不发（boot 旧值不再整包覆盖）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const base = {
      instanceId: 'local',
      projectId: 'p1',
      layout: { sidePanelWidth: 460, bottomPanelHeight: 260, showSidePanel: true, showBottomPanel: false, sideView: 'files', bottomTab: 'git' },
      editor: { openFiles: ['a.ts'], activeIndex: 0, splitOpen: false },
      fileTree: { expandedDirs: [], selectedFile: '' },
      terminal: { activeTabId: '' },
      gitPanel: { collapsedSections: [], selectedBranch: '' },
    }
    mockServerData({ local: base })
    const store = useUIStateStore()
    await store.loadState()

    // 本页存活期间没动过任何收集键：关页绝不上报（多标签下他页的修改不被回滚）
    store.forceSaveCurrentState({ ...base, instanceId: 'local' } as Parameters<typeof store.forceSaveCurrentState>[0])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forceSaveCurrentState 只发本页变更键（PATCH + keepalive）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    mockServerData({ local: { projectId: 'p1', agentTerminal: { sidebarCollapsed: true } } })
    const store = useUIStateStore()
    await store.loadState()

    store.forceSaveCurrentState({
      projectId: 'p1',
      layout: { sidePanelWidth: 460, bottomPanelHeight: 260, showSidePanel: false, showBottomPanel: false, sideView: 'files', bottomTab: 'git' },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/ui-state')
    expect(init.method).toBe('PATCH')
    expect(init.keepalive).toBe(true)
    const body = JSON.parse(String(init.body)) as AllState
    // 只带本页动过的 layout；collect 不到的 agentTerminal 不在补丁（服务端合并保留）
    expect(Object.keys(body.local!)).toEqual(['layout'])
    expect((body.local!.layout as Record<string, unknown>).showSidePanel).toBe(false)
  })

  it('forceSaveCurrentState 无基底（boot GET 失败）时全量起步不抛错', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const store = useUIStateStore()
    expect(() => store.forceSaveCurrentState({ projectId: 'p1' })).not.toThrow()

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as AllState
    expect(body.local?.projectId).toBe('p1')
  })

  it('alignBaseline 后未变更页关页零请求（恢复出的初始值不计为本页变更）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    mockServerData({}) // 服务端无记录（全新实例/数据面清空）
    const store = useUIStateStore()
    await store.loadState()

    // boot 恢复落定后的本页初始现实（服务端还没有这些值）
    const initial = {
      instanceId: 'local',
      projectId: 'p1',
      layout: { sidePanelWidth: 280, bottomPanelHeight: 260, showSidePanel: true, showBottomPanel: false, sideView: 'files', bottomTab: 'git' },
      editor: { openFiles: [], activeIndex: -1, splitOpen: false },
    }
    store.alignBaseline(initial as Parameters<typeof store.alignBaseline>[0])

    // 本页零交互关页：初始值不外发（他页在本页存活期间的修改不被回滚）
    store.forceSaveCurrentState({ ...initial } as Parameters<typeof store.forceSaveCurrentState>[0])
    expect(fetchMock).not.toHaveBeenCalled()

    // 对齐后真实变更照常发（且只发变更键）
    store.forceSaveCurrentState({
      ...initial,
      layout: { ...initial.layout, showBottomPanel: true },
    } as Parameters<typeof store.forceSaveCurrentState>[0])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as AllState
    expect(Object.keys(body.local!)).toEqual(['layout'])
  })
})

// 文件树钉选（P-20261002-97）：fileTree.pinnedDirs 字段级保留——auto-save/
// beforeunload 整命名空间携带 fileTree 时钉选必须从基底补回，否则任一写方
// 都会把钉选抹掉
describe('uiStateStore fileTree.pinnedDirs（钉选持久化）', () => {
  it('getFileTreePinnedDirs：合法映射透出，非数组值/非字符串项剔除', async () => {
    mockServerData({
      local: { fileTree: { pinnedDirs: { p1: ['a/b', 42, 'c'], p2: 'corrupted', p3: [] } } },
    })
    const store = useUIStateStore()
    await expect(store.getFileTreePinnedDirs()).resolves.toEqual({ p1: ['a/b', 'c'], p3: [] })
  })

  it('getFileTreePinnedDirs：脏形状（数组/标量/缺失）回落空表，API 失败亦然', async () => {
    mockServerData({ local: { fileTree: { pinnedDirs: ['not-an-object'] } } })
    const store = useUIStateStore()
    await expect(store.getFileTreePinnedDirs()).resolves.toEqual({})

    vi.mocked(uiStateApi.get).mockRejectedValue(new Error('down'))
    await expect(store.getFileTreePinnedDirs()).resolves.toEqual({})
  })

  it('saveFileTreePinnedDirs 键级补丁：expandedDirs/selectedFile 从基底补齐', async () => {
    mockServerData({ local: { fileTree: { expandedDirs: ['src'], selectedFile: 'src/a.ts' } } })
    const store = useUIStateStore()
    await store.loadState()
    await store.saveFileTreePinnedDirs({ p1: ['src/components'] })

    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(Object.keys(payload.local!)).toEqual(['fileTree'])
    expect(payload.local?.fileTree).toEqual({
      expandedDirs: ['src'],
      selectedFile: 'src/a.ts',
      pinnedDirs: { p1: ['src/components'] },
    })
  })

  it('saveCurrentState（auto-save collect）携带 fileTree 时从基底补回钉选', async () => {
    mockServerData({ local: { fileTree: { pinnedDirs: { p1: ['docs'] } } } })
    const store = useUIStateStore()
    await store.loadState()
    // collectCurrentUIState 的快照只含 expandedDirs/selectedFile（FileTreeView 场景）
    await store.saveCurrentState({ fileTree: { expandedDirs: ['src'], selectedFile: '' } })

    await vi.advanceTimersByTimeAsync(500)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(payload.local?.fileTree).toEqual({ expandedDirs: ['src'], selectedFile: '', pinnedDirs: { p1: ['docs'] } })
  })

  it('alignBaseline 剥掉 collect 面外的钉选后，在途防抖补丁仍补回 pinnedDirs', async () => {
    // e2e file-tree-pinned「重启持久」踩坑序列：boot GET 建基底（含钉选）→
    // 恢复期 watcher 触发 saveCurrentState（collect 面不含钉选，fileTree 成
    // 变更进待发集）→ alignBaselineAfterRestore 浅合并把基底 fileTree 整体
    // 覆盖成 collect 输出（钉选被剥）→ 防抖到期 finalize 从基底找不到钉选源
    // → PATCH 裸发 fileTree → 服务端整键替换丢钉选
    mockServerData({
      local: { fileTree: { expandedDirs: ['src'], selectedFile: 'src/a.ts', pinnedDirs: { p1: ['src/components'] } } },
    })
    const store = useUIStateStore()
    await store.loadState()

    await store.saveCurrentState({ fileTree: { expandedDirs: [], selectedFile: '' } })
    store.alignBaseline({ fileTree: { expandedDirs: [], selectedFile: '' } } as Parameters<typeof store.alignBaseline>[0])

    await vi.advanceTimersByTimeAsync(500)
    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(payload.local?.fileTree).toEqual({ expandedDirs: [], selectedFile: '', pinnedDirs: { p1: ['src/components'] } })
  })

  it('forceSaveCurrentState 携带 fileTree 时从基底补回钉选（防关页抹钉选）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    mockServerData({ local: { fileTree: { pinnedDirs: { p1: ['src/x'] } } } })
    const store = useUIStateStore()
    await store.loadState()

    store.forceSaveCurrentState({ fileTree: { expandedDirs: [], selectedFile: '' } })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as AllState
    expect(body.local?.fileTree).toEqual({ expandedDirs: [], selectedFile: '', pinnedDirs: { p1: ['src/x'] } })
  })

  it('resetLayoutState 键级补丁写回布局默认但保留 pinnedDirs（P-74 语义：钉选非布局）', async () => {
    mockServerData({ local: { fileTree: { expandedDirs: ['src'], selectedFile: 'x', pinnedDirs: { p1: ['docs'] } } } })
    const store = useUIStateStore()
    await store.loadState()
    await store.resetLayoutState({
      layout: { sidePanelWidth: 280, bottomPanelHeight: 260, showSidePanel: true, showBottomPanel: false, sideView: 'files', bottomTab: 'git' },
      fileTree: { expandedDirs: [], selectedFile: '' },
    })

    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as AllState
    expect(Object.keys(payload.local!)).toEqual(['layout', 'fileTree'])
    expect(payload.local?.fileTree).toEqual({ expandedDirs: [], selectedFile: '', pinnedDirs: { p1: ['docs'] } })
  })
})

// ============== 主区视图家族持久化名单（P-20261112-6-S3 口径收尾） ==============

describe('主区视图持久化名单（应持久化键在位/临时态键不在位）', () => {
  // S3 审计补齐后的定案名单：主区/浮层视图开态族全部落盘（远程 remoteConsole.open /
  // dsh dshConsole.open / 笔记 notesView.open + 呈现态 sidebarOpen/mode / 分享管理
  // shareManager.open），加上落点偏好（dashboard.landing）与写作现场（notesView.
  // activeId）。回潮即红：新键漏登记注册表会在 satisfies 编译期先红，本名单钉
  // 「登记的面正确」这一运行时事实。
  it('应持久化键在位：视图开态族 + 笔记呈现态 + 活动篇 + 落点偏好', () => {
    expect(NESTED_UISTATE_SUBFIELDS.remoteConsole).toEqual({ tabs: true, groups: true, open: true, sidebarCollapsed: true })
    // P-20261114-4-S2 分场景槽：dshConsole/notesView 开态键族各加 homeOpen 子字段
    // （open=project 槽 / homeOpen=home 槽）；remoteConsole 不分槽（open 唯一读端
    // 在项目页 bootstrap，槽天然 project 槽——首页 overlay persistState 不落 open）
    expect(NESTED_UISTATE_SUBFIELDS.dshConsole).toEqual({ open: true, homeOpen: true })
    expect(NESTED_UISTATE_SUBFIELDS.shareManager).toEqual({ open: true })
    expect(NESTED_UISTATE_SUBFIELDS.notesView).toEqual({ open: true, homeOpen: true, activeId: true, sidebarOpen: true, mode: true })
    expect(NESTED_UISTATE_SUBFIELDS.dashboard).toEqual({ landing: true })
  })

  it('临时态键不在位：纯查看面显隐与最大化族不入注册表', () => {
    // 仪表盘显隐不落盘（纯查看面，刷新回上次工作形态；落点偏好 landing 已在位
    // 是替代面——注册表内 dashboard 只许有 landing，不许长出 open/visible 类子键）
    expect(Object.keys(NESTED_UISTATE_SUBFIELDS.dashboard)).toEqual(['landing'])
    // dsh 最大化（fixed 全屏覆盖）：临时聚焦态，刷新从常态开始——dshConsole 命名
    // 空间只有 open/homeOpen 两槽位子键（P-20261114-4-S2 分场景槽），不得登记
    // maximized
    expect(Object.keys(NESTED_UISTATE_SUBFIELDS.dshConsole)).toEqual(['open', 'homeOpen'])
    // 编辑器组/终端 pane 最大化（P-20261004-64）：uiState 无键——不存在任何
    // editorGroupMaximized/terminalPaneMaximized 命名空间
    expect(NESTED_UISTATE_SUBFIELDS).not.toHaveProperty('editorGroupMaximized')
    expect(NESTED_UISTATE_SUBFIELDS).not.toHaveProperty('terminalPaneMaximized')
    // 终端自身最大化同理不落盘（layout 内已登记的是底部面板两态，无 terminalMaximized）
    expect(NESTED_UISTATE_SUBFIELDS.layout).not.toHaveProperty('terminalMaximized')
    // 分享管理视图只有开态（无 sidebarCollapsed/maximized 类子键）
    expect(Object.keys(NESTED_UISTATE_SUBFIELDS.shareManager)).toEqual(['open'])
  })
})
