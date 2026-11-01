import { describe, expect, it, vi } from 'vitest'
import { OPS_LOCATE_IN_TREE, type LocateInTreeDetail } from '../utils/opsEvents'
import { useProjectStore, type Project } from '../stores/project'
import { usePanelLayout } from './usePanelLayout'
import { useEditorTreeLocate } from './useEditorTreeLocate'

// 编辑器「在文件树中定位」派发层单测（P-20261003-294）：事件契约（事件名/
// detail 形态）+ 侧栏视图预处理。落点侧（FileTreeView 逐层展开）走 E2E 覆盖。

function seedProject(overrides: Partial<Project> = {}): void {
  const project = useProjectStore()
  project.projects = [{
    id: 'p1',
    name: 'P1',
    path: '/repo',
    currentBranch: '',
    remoteURL: '',
    valid: true,
    ...overrides,
  }]
  project.currentProjectId = 'p1'
}

describe('useEditorTreeLocate', () => {
  it('locateInTree：派发 OPS_LOCATE_IN_TREE，detail 携带项目相对路径与项目 id', async () => {
    seedProject()
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const { locateInTree } = useEditorTreeLocate()
    await locateInTree('src/feat/deep/probe.ts')
    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0]![0] as CustomEvent<LocateInTreeDetail>
    expect(ev.type).toBe(OPS_LOCATE_IN_TREE)
    expect(ev.detail).toEqual({ path: 'src/feat/deep/probe.ts', projectId: 'p1' })
    dispatch.mockRestore()
  })

  it('反斜杠路径防御性归一为正斜杠（detail 契约口径）', async () => {
    seedProject()
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const { locateInTree } = useEditorTreeLocate()
    await locateInTree('src\\deep\\probe.ts')
    const ev = dispatch.mock.calls[0]![0] as CustomEvent<LocateInTreeDetail>
    expect(ev.detail).toEqual({ path: 'src/deep/probe.ts', projectId: 'p1' })
    dispatch.mockRestore()
  })

  it('无当前项目 / 空路径时不派发', async () => {
    seedProject()
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const { locateInTree } = useEditorTreeLocate()
    await locateInTree('src/probe.ts')
    expect(dispatch).toHaveBeenCalledTimes(1) // 有项目：正常派发（对照组）
    useProjectStore().currentProjectId = ''
    await locateInTree('src/probe.ts')
    expect(dispatch).toHaveBeenCalledTimes(1) // 无项目：no-op
    useProjectStore().currentProjectId = 'p1'
    await locateInTree('')
    expect(dispatch).toHaveBeenCalledTimes(1) // 空路径：no-op
    dispatch.mockRestore()
  })

  it('侧栏不在 files 视图时先切回再派发（FileTreeView 重挂后监听才在）', async () => {
    seedProject()
    const layout = usePanelLayout()
    layout.sideView.value = 'changes'
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const { locateInTree } = useEditorTreeLocate()
    await locateInTree('src/probe.ts')
    expect(layout.sideView.value).toBe('files') // 派发前已切回 files 视图
    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0]![0] as CustomEvent<LocateInTreeDetail>
    expect(ev.detail).toEqual({ path: 'src/probe.ts', projectId: 'p1' })
    dispatch.mockRestore()
  })

  it('revealProjectRoot：空路径 = 项目根 + focus 扩展（P-20261020-8 CTA）', async () => {
    seedProject()
    const layout = usePanelLayout()
    layout.sideView.value = 'todos'
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const { revealProjectRoot } = useEditorTreeLocate()
    await revealProjectRoot()
    expect(layout.sideView.value).toBe('files')
    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0]![0] as CustomEvent<LocateInTreeDetail>
    expect(ev.type).toBe(OPS_LOCATE_IN_TREE)
    expect(ev.detail).toEqual({ path: '', projectId: 'p1', focus: true })
    dispatch.mockRestore()
  })

  it('revealProjectRoot：无当前项目时不派发', async () => {
    seedProject()
    useProjectStore().currentProjectId = ''
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const { revealProjectRoot } = useEditorTreeLocate()
    await revealProjectRoot()
    expect(dispatch).not.toHaveBeenCalled()
    dispatch.mockRestore()
  })
})
