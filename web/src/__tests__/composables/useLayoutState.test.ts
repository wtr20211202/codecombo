import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/api/client', () => ({ uiStateApi: { get: vi.fn(), update: vi.fn() }, setInstanceContext: vi.fn() }))
vi.mock('@/stores/instance', () => ({ useInstanceStore: () => ({ currentInstanceId: 'local' }) }))

import { useLayoutState, SPLIT_FILES_MAX } from '@/composables/useLayoutState'
import { uiStateApi } from '@/api/client'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('useLayoutState', () => {
  it('模块可导入', () => {
    expect(typeof useLayoutState).toBe('function')
  })

  it('restoreState 返回持久化的状态', async () => {
    vi.mocked(uiStateApi.get).mockResolvedValue({
      data: { local: { projectId: 'p1', editor: { openFiles: [], activeIndex: -1, scrollPositions: {} } } },
    })
    const { restoreState } = useLayoutState(
      { openFiles: { value: [] } as any, activeFileIndex: { value: -1 } as any },
      { sidePanelWidth: { value: 280 } as any, bottomPanelHeight: { value: 260 } as any, showSidePanel: { value: true } as any, showBottomPanel: { value: false } as any, sideView: { value: 'files' } as any, bottomTab: { value: 'terminal' } as any, commitLocation: { value: 'sidebar' } as any },
    )
    const s = await restoreState()
    expect(s?.projectId).toBe('p1')
  })

  it('restoreState 失败时返回 null', async () => {
    vi.mocked(uiStateApi.get).mockRejectedValue(new Error('fail'))
    const { restoreState } = useLayoutState(
      { openFiles: { value: [] } as any, activeFileIndex: { value: -1 } as any },
      { sidePanelWidth: { value: 0 } as any, bottomPanelHeight: { value: 0 } as any, showSidePanel: { value: true } as any, showBottomPanel: { value: false } as any, sideView: { value: 'files' } as any, bottomTab: { value: 'terminal' } as any, commitLocation: { value: 'sidebar' } as any },
    )
    const s = await restoreState()
    expect(s).toBeNull()
  })

  it('collectCurrentUIState 剔除 untitled 草稿且 activeIndex 映射到剔除后的列表（P-20261002-24）', () => {
    const panel = { sidePanelWidth: { value: 280 }, bottomPanelHeight: { value: 260 }, showSidePanel: { value: true }, showBottomPanel: { value: false }, sideView: { value: 'files' }, bottomTab: { value: 'terminal' }, commitLocation: { value: 'sidebar' }, bottomPanelMaximized: { value: false }, bottomPanelEditorMaximized: { value: false } } as any
    const { collectCurrentUIState } = useLayoutState(
      panel,
      // 草稿在前：真实文件活跃（索引 2）持久化后应左移到 1
      { openFiles: { value: [{ path: 'untitled://1' }, { path: 'a.ts' }, { path: 'b.ts' }] } as any, activeFileIndex: { value: 2 } as any },
    )
    const s = collectCurrentUIState()
    expect(s.editor.openFiles).toEqual(['a.ts', 'b.ts'])
    expect(s.editor.activeIndex).toBe(1)
  })

  it('活跃标签是 untitled 草稿时持久化 activeIndex 为 -1（草稿不跨刷新）', () => {
    const panel = { sidePanelWidth: { value: 280 }, bottomPanelHeight: { value: 260 }, showSidePanel: { value: true }, showBottomPanel: { value: false }, sideView: { value: 'files' }, bottomTab: { value: 'terminal' }, commitLocation: { value: 'sidebar' }, bottomPanelMaximized: { value: false }, bottomPanelEditorMaximized: { value: false } } as any
    const { collectCurrentUIState } = useLayoutState(
      panel,
      { openFiles: { value: [{ path: 'a.ts' }, { path: 'untitled://1' }] } as any, activeFileIndex: { value: 1 } as any },
    )
    const s = collectCurrentUIState()
    expect(s.editor.openFiles).toEqual(['a.ts'])
    expect(s.editor.activeIndex).toBe(-1)
  })

  it('collect 采集分屏组清单与活跃路径（P-20261002-94），缺 groups 时为空', () => {
    const panel = { sidePanelWidth: { value: 280 }, bottomPanelHeight: { value: 260 }, showSidePanel: { value: true }, showBottomPanel: { value: false }, sideView: { value: 'files' }, bottomTab: { value: 'terminal' }, commitLocation: { value: 'sidebar' }, bottomPanelMaximized: { value: false }, bottomPanelEditorMaximized: { value: false } } as any
    const noGroups = useLayoutState(panel, { openFiles: { value: [] } as any, activeFileIndex: { value: -1 } as any })
    expect(noGroups.collectCurrentUIState().editor.splitFiles).toEqual([])
    expect(noGroups.collectCurrentUIState().editor.splitActiveFile).toBe('')

    const g1Files = [
      { path: 'b.ts', isDiff: false, isPreview: false },
      { path: 'diff:x:y:z', isDiff: true, isPreview: false },
      { path: 'untitled://1', isDiff: false, isPreview: false },
      { path: 'c.ts', isDiff: false, isPreview: true },
      { path: 'd.ts', isDiff: false, isPreview: false },
    ]
    const withGroups = useLayoutState(
      panel,
      {
        openFiles: { value: [] } as any,
        activeFileIndex: { value: -1 } as any,
        groups: { value: [{ files: [], activeIndex: -1 }, { files: g1Files, activeIndex: 4 }] } as any,
        splitOpen: { value: true } as any,
      },
    )
    const s = withGroups.collectCurrentUIState()
    // diff 伪键 / untitled 草稿 / P-50 预览签剔除，真实文件按序保留
    expect(s.editor.splitFiles).toEqual(['b.ts', 'd.ts'])
    // 活跃签 d.ts 在剔除后的清单内 → 按路径恢复
    expect(s.editor.splitActiveFile).toBe('d.ts')
  })

  it('分屏清单上限 SPLIT_FILES_MAX 超出截旧（保尾部），被截掉的活跃位落空', () => {
    const panel = { sidePanelWidth: { value: 280 }, bottomPanelHeight: { value: 260 }, showSidePanel: { value: true }, showBottomPanel: { value: false }, sideView: { value: 'files' }, bottomTab: { value: 'terminal' }, commitLocation: { value: 'sidebar' }, bottomPanelMaximized: { value: false }, bottomPanelEditorMaximized: { value: false } } as any
    const files = Array.from({ length: SPLIT_FILES_MAX + 5 }, (_, i) => ({ path: `f${i}.ts`, isDiff: false, isPreview: false }))
    const { collectCurrentUIState } = useLayoutState(
      panel,
      {
        openFiles: { value: [] } as any,
        activeFileIndex: { value: -1 } as any,
        groups: { value: [{ files: [], activeIndex: -1 }, { files, activeIndex: 0 }] } as any,
      },
    )
    const s = collectCurrentUIState()
    expect(s.editor.splitFiles).toHaveLength(SPLIT_FILES_MAX)
    expect(s.editor.splitFiles![0]).toBe('f5.ts') // 旧的 f0~f4 被截
    expect(s.editor.splitFiles!.at(-1)).toBe('f24.ts')
    expect(s.editor.splitActiveFile).toBe('') // 活跃签 f0.ts 已被截掉
  })

  it('collect 恒写分屏方向（P-20261005-230）：缺省/无采集源落横向零值，纵向照实采集', () => {
    const panel = { sidePanelWidth: { value: 280 }, bottomPanelHeight: { value: 260 }, showSidePanel: { value: true }, showBottomPanel: { value: false }, sideView: { value: 'files' }, bottomTab: { value: 'terminal' }, commitLocation: { value: 'sidebar' }, bottomPanelMaximized: { value: false }, bottomPanelEditorMaximized: { value: false } } as any
    // 旧调用方（无 splitDirection 采集源）：横向零值 = 旧布局行为不变
    const noDir = useLayoutState(panel, { openFiles: { value: [] } as any, activeFileIndex: { value: -1 } as any })
    expect(noDir.collectCurrentUIState().editor.splitDirection).toBe('horizontal')

    // 有采集源：恒写当前方向（省略会让 P-20261006-24 子字段回填从基底复活旧值）
    const withDir = useLayoutState(
      panel,
      { openFiles: { value: [] } as any, activeFileIndex: { value: -1 } as any, splitDirection: { value: 'vertical' } as any },
    )
    expect(withDir.collectCurrentUIState().editor.splitDirection).toBe('vertical')
  })
})
