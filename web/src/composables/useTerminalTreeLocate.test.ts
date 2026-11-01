import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { OPS_LOCATE_IN_TREE, type LocateInTreeDetail } from '../utils/opsEvents'
import { useProjectStore, type Project } from '../stores/project'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useTerminalTreeLocate } from './useTerminalTreeLocate'

// 「在文件树中定位」解析层单测（P-20261001-32）：终端 tab → 会话 dir 项目相对
// 路径的映射规则 + 事件派发契约。落点侧（FileTreeView 逐层展开）走 E2E 覆盖。

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

function seedSessions(sessions: { id: string; kind?: string; projectId?: string; path?: string }[]): void {
  useTerminalSessionsStore().applySnapshot(sessions.map(s => ({
    id: s.id,
    name: s.id,
    kind: s.kind ?? 'shell',
    projectId: s.projectId ?? 'p1',
    path: s.path ?? '',
    createdAt: '',
  })))
}

describe('useTerminalTreeLocate', () => {
  it('dirByTabId：会话 dir 折算项目相对路径；项目外/他项目 tab/未知会话无条目', () => {
    seedProject()
    seedSessions([
      { id: 's-root', path: '/repo' },
      { id: 's-deep', path: '/repo/src/deep' },
      { id: 's-win', path: '\\repo\\src' }, // Windows 分隔符形态同折算
      { id: 's-out', path: '/elsewhere' }, // 项目外：排除
      { id: 's-other', projectId: 'p2', path: '/repo' }, // 他项目 tab：排除
      { id: 's-nopath', path: '' }, // 会话无 dir：排除
    ])
    const { dirByTabId } = useTerminalTreeLocate({
      tabs: ref([
        { id: 's-root', projectId: 'p1' },
        { id: 's-deep', projectId: 'p1' },
        { id: 's-win', projectId: 'p1' },
        { id: 's-out', projectId: 'p1' },
        { id: 's-other', projectId: 'p2' },
        { id: 's-nopath', projectId: 'p1' },
        { id: 's-ghost', projectId: 'p1' }, // store 中不存在的会话：排除
      ]),
      activeTabId: ref('s-deep'),
    })
    expect(dirByTabId.value).toEqual({
      's-root': '',
      's-deep': 'src/deep',
      's-win': 'src',
    })
  })

  it('项目无效（valid=false）时不解析任何 dir', () => {
    seedProject({ valid: false })
    seedSessions([{ id: 's1', path: '/repo' }])
    const { dirByTabId, activeDir } = useTerminalTreeLocate({
      tabs: ref([{ id: 's1', projectId: 'p1' }]),
      activeTabId: ref('s1'),
    })
    expect(dirByTabId.value).toEqual({})
    expect(activeDir.value).toBeUndefined()
  })

  it('locateActive：派发 OPS_LOCATE_IN_TREE，detail 携带相对路径与项目 id；根 dir 为空串', () => {
    seedProject()
    seedSessions([
      { id: 's-root', path: '/repo' },
      { id: 's-deep', path: '/repo/src/deep' },
    ])
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const api = useTerminalTreeLocate({
      tabs: ref([{ id: 's-root', projectId: 'p1' }, { id: 's-deep', projectId: 'p1' }]),
      activeTabId: ref('s-deep'),
    })
    api.locateActive()
    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0]![0] as CustomEvent<LocateInTreeDetail>
    expect(ev.type).toBe(OPS_LOCATE_IN_TREE)
    expect(ev.detail).toEqual({ path: 'src/deep', projectId: 'p1' })

    // 切到根 dir 会话：path 折算为空串（= 项目根本身），仍照常派发
    const apiRoot = useTerminalTreeLocate({
      tabs: ref([{ id: 's-root', projectId: 'p1' }]),
      activeTabId: ref('s-root'),
    })
    apiRoot.locateActive()
    const evRoot = dispatch.mock.calls[1]![0] as CustomEvent<LocateInTreeDetail>
    expect(evRoot.detail).toEqual({ path: '', projectId: 'p1' })
    dispatch.mockRestore()
  })

  it('活动 tab 的 dir 未知（项目外/会话未知）时 locateActive 不派发', () => {
    seedProject()
    seedSessions([{ id: 's-out', path: '/elsewhere' }])
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const api = useTerminalTreeLocate({
      tabs: ref([{ id: 's-out', projectId: 'p1' }]),
      activeTabId: ref('s-out'),
    })
    expect(api.activeDir.value).toBeUndefined()
    api.locateActive()
    expect(dispatch).not.toHaveBeenCalled()
    dispatch.mockRestore()
  })

  it('管理页复用（P-20261002-125）：projectId 空串的 agent 会话按容器检查解析；locateTab 逐行派发', () => {
    seedProject()
    seedSessions([
      { id: 'a-in', kind: 'agent', projectId: '', path: '/repo/src/deep' }, // agent 会话 cwd 在项目内
      { id: 'a-out', kind: 'agent', projectId: '', path: '/elsewhere' }, // agent 会话 cwd 在项目外
      { id: 'p2-shell', projectId: 'p2', path: '/repo' }, // 他项目会话：仍排除
    ])
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const api = useTerminalTreeLocate({
      tabs: ref([
        { id: 'a-in', projectId: '' },
        { id: 'a-out', projectId: '' },
        { id: 'p2-shell', projectId: 'p2' },
      ]),
      activeTabId: ref('a-out'),
    })
    // 只有 dir 落在当前项目内的 agent 会话有解析值；他项目 tab 依旧排除
    expect(api.dirByTabId.value).toEqual({ 'a-in': 'src/deep' })
    // locateTab 逐行派发（不限活动 tab）
    api.locateTab('a-in')
    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0]![0] as CustomEvent<LocateInTreeDetail>
    expect(ev.type).toBe(OPS_LOCATE_IN_TREE)
    expect(ev.detail).toEqual({ path: 'src/deep', projectId: 'p1' })
    // 未解析（项目外/未知会话）：no-op 不派发
    api.locateTab('a-out')
    api.locateTab('p2-shell')
    api.locateTab('ghost')
    expect(dispatch).toHaveBeenCalledTimes(1)
    dispatch.mockRestore()
  })
})
