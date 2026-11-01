import { describe, expect, it } from 'vitest'
import {
  buildSessionGroups,
  sessionStatus,
  summarizeSessions,
  type SessionTabInfo,
} from './sessionOverview'

const tab = (over: Partial<SessionTabInfo> & { id: string; projectId: string }): SessionTabInfo => ({
  name: 'T-' + over.id,
  ...over,
})

describe('sessionStatus', () => {
  it('running 优先于退出码', () => {
    expect(sessionStatus({ running: true, lastExitCode: 3 })).toBe('running')
  })
  it('非零退出为 failed，零为 ok，未执行为 new', () => {
    expect(sessionStatus({ running: false, lastExitCode: 3 })).toBe('failed')
    expect(sessionStatus({ running: false, lastExitCode: 0 })).toBe('ok')
    expect(sessionStatus({ running: false })).toBe('new')
  })
})

describe('buildSessionGroups', () => {
  const projects = [
    { id: 'p1', name: 'alpha' },
    { id: 'p2', name: 'beta' },
  ]
  const tabs: SessionTabInfo[] = [
    tab({ id: 't2', projectId: 'p2', running: true }),
    tab({ id: 't1', projectId: 'p1', lastExitCode: 1 }),
    tab({ id: 't3', projectId: 'p1', lastExitCode: 0 }),
  ]

  it('按项目分组且当前项目置顶，字段映射正确', () => {
    const groups = buildSessionGroups({
      tabs,
      projects,
      currentProjectId: 'p1',
      activeTabId: 't3',
      lastCommands: { t1: 'cmd /c exit 1', t3: 'echo ok' },
    })
    expect(groups.map(g => g.projectId)).toEqual(['p1', 'p2'])
    expect(groups[0]!.projectName).toBe('alpha')
    expect(groups[0]!.isCurrent).toBe(true)
    expect(groups[1]!.isCurrent).toBe(false)
    const [failed, ok] = groups[0]!.sessions
    expect(failed).toMatchObject({ tabId: 't1', status: 'failed', exitCode: 1, lastCmd: 'cmd /c exit 1', active: false })
    expect(ok).toMatchObject({ tabId: 't3', status: 'ok', active: true, lastCmd: 'echo ok' })
    expect(groups[1]!.sessions[0]).toMatchObject({ tabId: 't2', status: 'running' })
  })

  it('未知项目回退 projectId 为名称；无命令时 lastCmd 为空串', () => {
    const groups = buildSessionGroups({
      tabs: [tab({ id: 't9', projectId: 'ghost' })],
      projects,
      currentProjectId: 'p1',
      activeTabId: '',
      lastCommands: {},
    })
    expect(groups[0]!.projectName).toBe('ghost')
    expect(groups[0]!.sessions[0]!.lastCmd).toBe('')
    expect(groups[0]!.sessions[0]!.status).toBe('new')
  })

  it('lastCmd 首尾空白被裁剪', () => {
    const groups = buildSessionGroups({
      tabs: [tab({ id: 't1', projectId: 'p1' })],
      projects,
      currentProjectId: 'p1',
      activeTabId: 't1',
      lastCommands: { t1: '  npm test  ' },
    })
    expect(groups[0]!.sessions[0]!.lastCmd).toBe('npm test')
  })
})

describe('summarizeSessions', () => {
  it('汇总总数与运行/失败计数', () => {
    const tabs: SessionTabInfo[] = [
      tab({ id: 'a', projectId: 'p', running: true }),
      tab({ id: 'b', projectId: 'p', running: true }),
      tab({ id: 'c', projectId: 'p', lastExitCode: 2 }),
      tab({ id: 'd', projectId: 'p', lastExitCode: 0 }),
    ]
    expect(summarizeSessions(tabs)).toEqual({ total: 4, running: 2, failed: 1 })
  })
})
