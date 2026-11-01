import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useUIStateStore, sanitizeSnapshotGroups, WORKSPACE_SNAPSHOT_VERSION } from '@/stores/uiState'
import { uiStateApi } from '@/api/client'

vi.mock('@/api/client', () => ({
  uiStateApi: { get: vi.fn(), update: vi.fn(), patch: vi.fn() },
  setInstanceContext: vi.fn(),
}))

describe('uiStateStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('初始 loading 为 false', () => {
    const store = useUIStateStore()
    expect(store.loading).toBe(false)
  })

  it('loadState 成功时调用 API 并返回数据', async () => {
    vi.mocked(uiStateApi.get).mockResolvedValue({ data: { i1: { projectId: 'p1' } } })
    const store = useUIStateStore()
    const result = await store.loadState()
    expect(uiStateApi.get).toHaveBeenCalled()
    expect(result).toEqual({ i1: { projectId: 'p1' } })
  })

  it('loadState 失败时返回空对象', async () => {
    vi.mocked(uiStateApi.get).mockRejectedValue(new Error('fail'))
    const store = useUIStateStore()
    const result = await store.loadState()
    expect(result).toEqual({})
  })

  it('getInstanceState 返回当前实例状态', async () => {
    vi.mocked(uiStateApi.get).mockResolvedValue({
      data: { local: { projectId: 'p1', editor: { openFiles: ['a.ts'], activeIndex: 0, scrollPositions: {} } } },
    })
    const store = useUIStateStore()
    const state = await store.getInstanceState()
    expect(state?.projectId).toBe('p1')
    expect(state?.editor?.openFiles).toEqual(['a.ts'])
  })

  // P-20261002-8 键级补丁：保存不再 GET 全量，直接脏键 diff 后 PATCH
  it('saveCurrentState 走脏键 diff → PATCH（无基底时全部键视为变更）', async () => {
    vi.mocked(uiStateApi.get).mockResolvedValue({ data: {} })
    vi.mocked(uiStateApi.patch).mockResolvedValue({})
    vi.useFakeTimers()
    try {
      const store = useUIStateStore()
      await store.loadState()
      await store.saveCurrentState({
        projectId: 'p1',
        editor: { openFiles: ['a.ts'], activeIndex: 0, scrollPositions: {} },
      })
      // 防抖定时器不会立即触发 patch
      expect(uiStateApi.get).toHaveBeenCalledTimes(1) // 只来自 loadState
      await vi.advanceTimersByTimeAsync(500)
      expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
      const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as Record<string, Record<string, unknown>>
      expect(payload.local?.projectId).toBe('p1')
    } finally {
      vi.useRealTimers()
    }
  })

  // 一键重置布局（P-20261002-74）：layout/fileTree 键级补丁写默认并立即落盘，
  // 其余命名空间与其它实例由服务端合并原样保留（P-20261002-8 起不再客户端
  // GET 全量回写）
  it('resetLayoutState 立即 PATCH 且只动 layout/fileTree 键', async () => {
    vi.mocked(uiStateApi.get).mockResolvedValue({
      data: {
        local: {
          projectId: 'p1',
          layout: { sidePanelWidth: 460, bottomPanelHeight: 520, showSidePanel: false, showBottomPanel: true, sideView: 'changes', bottomTab: 'git' },
          fileTree: { expandedDirs: ['a', 'a/b'], selectedFile: 'x.ts' },
          editor: { openFiles: ['keep.ts'], activeIndex: 0, scrollPositions: {} },
          agentTerminal: { groups: [{ id: 'g1', name: 'n', sessionIds: ['s1'] }] },
        },
        remote1: { projectId: 'p2' },
      },
    })
    vi.mocked(uiStateApi.patch).mockResolvedValue({})
    const store = useUIStateStore()
    await store.loadState()
    await store.resetLayoutState({
      layout: { sidePanelWidth: 280, bottomPanelHeight: 260, showSidePanel: true, showBottomPanel: false, sideView: 'files', bottomTab: 'terminal' },
      fileTree: { expandedDirs: [], selectedFile: '' },
    })
    // 立即写不等防抖
    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as Record<string, Record<string, unknown>>
    // 只携带重置面：editor/agentTerminal/其它实例不在补丁里（服务端合并保留）
    expect(Object.keys(payload)).toEqual(['local'])
    expect(Object.keys(payload.local!)).toEqual(['layout', 'fileTree'])
    expect(payload.local!.layout).toMatchObject({ sidePanelWidth: 280, bottomPanelHeight: 260, showSidePanel: true, showBottomPanel: false, sideView: 'files', bottomTab: 'terminal' })
    expect(payload.local!.fileTree).toEqual({ expandedDirs: [], selectedFile: '' })
  })

  it('resetLayoutState 未加载基底时以空基底写入默认', async () => {
    vi.mocked(uiStateApi.patch).mockResolvedValue({})
    const store = useUIStateStore()
    await store.resetLayoutState({
      layout: { sidePanelWidth: 280, bottomPanelHeight: 260, showSidePanel: true, showBottomPanel: false, sideView: 'files', bottomTab: 'terminal' },
      fileTree: { expandedDirs: [], selectedFile: '' },
    })
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as Record<string, Record<string, unknown>>
    expect(payload.local!.layout).toMatchObject({ sidePanelWidth: 280 })
    expect(payload.local!.fileTree).toEqual({ expandedDirs: [], selectedFile: '' })
  })

  // 工作现场存档点（P-20261002-84）：snapshots 键级即时写
  it('saveWorkspaceSnapshots 立即 PATCH 且只动 snapshots 键', async () => {
    vi.mocked(uiStateApi.patch).mockResolvedValue({})
    const store = useUIStateStore()
    const snap = { id: 'wsnap-1', name: '现场A', savedAt: 2, branch: 'main', editor: { openFiles: ['a.ts'], activeFile: 'a.ts' }, layout: { sidePanelWidth: 280, bottomPanelHeight: 260, showSidePanel: true, showBottomPanel: false, sideView: 'files', bottomTab: 'git' } }
    await store.saveWorkspaceSnapshots({ p1: [snap] })
    expect(uiStateApi.patch).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(uiStateApi.patch).mock.calls[0]![0] as Record<string, Record<string, unknown>>
    expect(Object.keys(payload.local!)).toEqual(['snapshots'])
    expect(payload.local!.snapshots).toEqual({ p1: [snap] }) // 旧项目键整表替换（读写皆全量表）
  })

  it('getWorkspaceSnapshots 形状防御：脏数据整键/整条剔除', async () => {
    vi.mocked(uiStateApi.get).mockResolvedValue({
      data: {
        local: {
          snapshots: {
            pOk: [
              { id: 'a', name: '好', savedAt: 1, branch: 'main', editor: { openFiles: ['a.ts'], activeFile: 'a.ts' }, layout: {} },
              'junk-string', // 非对象条目
              { name: '缺 id' }, // 缺 id
              { id: 'b', name: '缺 editor' }, // 缺 editor.openFiles
            ],
            pBad: 'not-an-array', // 非数组整键剔除
          },
        },
      },
    })
    const store = useUIStateStore()
    const all = await store.getWorkspaceSnapshots()
    expect(Object.keys(all)).toEqual(['pOk'])
    expect(all.pOk).toHaveLength(1)
    expect(all.pOk![0]!.name).toBe('好')
  })

  it('getWorkspaceSnapshots 缺失/脏顶层形状返回空表', async () => {
    vi.mocked(uiStateApi.get).mockResolvedValue({ data: { local: { snapshots: [1, 2] } } })
    const store = useUIStateStore()
    expect(await store.getWorkspaceSnapshots()).toEqual({})
  })

  // 工作区预设（P-20261003-68）：新维度字段可选、getter 原样透传供恢复端消费
  it('getWorkspaceSnapshots 新维度字段（version/splitOpen/agentGroups）原样透传', async () => {
    vi.mocked(uiStateApi.get).mockResolvedValue({
      data: {
        local: {
          snapshots: {
            p1: [{
              id: 'a', version: 1, name: 'n', savedAt: 1, branch: '',
              editor: { openFiles: ['a.ts'], activeFile: 'a.ts', splitOpen: true },
              layout: {},
              agentGroups: [{ id: 'g', name: '组', sessionIds: ['x'] }],
            }],
          },
        },
      },
    })
    const store = useUIStateStore()
    const all = await store.getWorkspaceSnapshots()
    expect(all.p1![0]).toMatchObject({ version: 1, editor: { splitOpen: true }, agentGroups: [{ id: 'g', name: '组' }] })
  })
})

// 工作区预设（P-20261003-68）：会话组结构清洗纯函数——快照来自落盘 JSON，
// 恢复/采集端逐条剔除脏形状，未知字段忽略不崩
describe('sanitizeSnapshotGroups', () => {
  it('合法结构原样保留，成员串表归一', () => {
    expect(sanitizeSnapshotGroups([{ id: 'g1', name: '前端', sessionIds: ['s1', 's2'] }]))
      .toEqual([{ id: 'g1', name: '前端', sessionIds: ['s1', 's2'] }])
  })

  it('脏条目逐条剔除：非对象/缺 id/空 id/缺成员表，成员内非串剔除', () => {
    expect(sanitizeSnapshotGroups([
      'junk',
      null,
      { name: '缺 id', sessionIds: [] },
      { id: '', name: '空 id', sessionIds: [] },
      { id: 'g2', name: '缺成员表' },
      { id: 'g3', name: '好', sessionIds: ['s1', 3, null] },
    ])).toEqual([{ id: 'g3', name: '好', sessionIds: ['s1'] }])
  })

  it('非数组/缺失顶层返回空表', () => {
    expect(sanitizeSnapshotGroups('nope')).toEqual([])
    expect(sanitizeSnapshotGroups(undefined)).toEqual([])
  })

  it('快照 schema 版本号常量为 1（演进锚）', () => {
    expect(WORKSPACE_SNAPSHOT_VERSION).toBe(1)
  })
})
