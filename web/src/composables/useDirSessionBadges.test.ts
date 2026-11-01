import { describe, expect, it } from 'vitest'
import { useProjectStore, type Project } from '../stores/project'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useDirSessionBadges } from './useDirSessionBadges'

// 目录会话驻留徽标（P-20261004-41）归属层单测：会话实时 cwd（P-20261004-59
// currentDir，无帧回落创建 dir）→ 项目相对目录的映射规则与运行态。渲染/点击/
// 跳转面（FileTreeView）走 E2E 覆盖。t 走 src/__tests__/setup.ts 的真实
// zh-CN 语言包直译（键即契约，文案改动即测出）。

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

function seedSessions(sessions: { id: string; kind?: string; path?: string; currentDir?: string }[]): void {
  useTerminalSessionsStore().applySnapshot(sessions.map(s => ({
    id: s.id,
    name: `名-${s.id}`,
    kind: s.kind ?? 'agent',
    projectId: '',
    path: s.path ?? '',
    createdAt: '',
    ...(s.currentDir !== undefined ? { currentDir: s.currentDir } : {}),
  })))
}

function namesAt(dir: string): string[] {
  return useDirSessionBadges().sessionsAt(dir).map(e => e.name)
}

describe('useDirSessionBadges', () => {
  it('会话 cwd 折算项目相对目录精确归属；项目外/项目根不产出条目', () => {
    seedProject()
    seedSessions([
      { id: 'a-sub', path: '/repo/packages' },
      { id: 'a-deep', path: '/repo/src/lib' },
      { id: 'a-win', path: '\\repo\\scripts' }, // Windows 分隔符形态同折算
      { id: 'a-root', path: '/repo' }, // 项目根：文件树无根节点行，不徽标
      { id: 'a-out', path: '/elsewhere' }, // 项目外：排除
    ])
    expect(namesAt('packages')).toHaveLength(1)
    expect(namesAt('src/lib')).toHaveLength(1)
    expect(namesAt('scripts')).toHaveLength(1)
    // 精确等于语义（非前缀）：父目录不因子目录驻留而点亮
    expect(namesAt('src')).toHaveLength(0)
    expect(namesAt('')).toHaveLength(0)
  })

  it('实时 cwd 优先：currentDir 迁移后徽标跟随（迁 dir 实时更新语义）', () => {
    seedProject()
    seedSessions([{ id: 'a1', path: '/repo/old', currentDir: '/repo/new' }])
    expect(namesAt('old')).toHaveLength(0)
    expect(namesAt('new')).toHaveLength(1)
  })

  it('仅 agent 会话参与；shell 项目会话不点亮目录徽标', () => {
    seedProject()
    seedSessions([
      { id: 'sh', kind: 'shell', path: '/repo/packages' },
      { id: 'ag', kind: 'agent', path: '/repo/packages' },
    ])
    expect(namesAt('packages')).toEqual(['名-ag'])
  })

  it('同目录多会话全数入列；运行态取 runningMap（缺 key = 空闲）', () => {
    seedProject()
    const store = useTerminalSessionsStore()
    seedSessions([
      { id: 'a1', path: '/repo/pkg' },
      { id: 'a2', path: '/repo/pkg' },
    ])
    store.reportOsc('a2', 'C') // a2 运行中（OSC 133 C）
    const { sessionsAt, tipFor } = useDirSessionBadges()
    const list = sessionsAt('pkg')
    expect(list.map(e => e.id)).toEqual(['a1', 'a2'])
    expect(list.map(e => e.running)).toEqual([false, true])
    // tooltip 行式清单：每会话一行「名称 · 状态」，运行中 ● 前缀点亮
    const tip = tipFor('pkg')
    expect(tip.split('\n')).toEqual([
      '名-a1 · 空闲',
      '● 名-a2 · 运行中',
    ])
    // 状态行复用（多会话选择菜单的行文案）：同 key 面
    expect(tip).toContain(sessionsAt('pkg')[0]!.name)
  })

  it('项目无效（valid=false）或无当前项目时不产出任何徽标条目', () => {
    seedProject({ valid: false })
    seedSessions([{ id: 'a1', path: '/repo/pkg' }])
    expect(namesAt('pkg')).toHaveLength(0)
  })
})
