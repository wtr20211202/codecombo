import { describe, it, expect } from 'vitest'
import { matchEquivalentProject } from './projectMatch'
import type { Project } from '../stores/project'

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: 'p1',
    name: 'demo',
    path: '/tmp/demo',
    currentBranch: 'main',
    remoteURL: 'https://github.com/foo/demo.git',
    valid: true,
    ...overrides,
  }
}

describe('matchEquivalentProject', () => {
  it('id 完全相同时直接命中', () => {
    const old = makeProject({ id: 'a1' })
    const candidates = [
      makeProject({ id: 'b2', name: 'other' }),
      makeProject({ id: 'a1', name: 'changed-name' }),
    ]
    expect(matchEquivalentProject(old, candidates)?.id).toBe('a1')
  })

  it('remoteURL + 分支相同命中（跨机同仓库同分支）', () => {
    const old = makeProject({ id: 'local-1', path: 'D:\\work\\demo' })
    const candidates = [
      makeProject({ id: 'remote-2', name: 'demo', path: '/home/cld/demo' }),
      makeProject({ id: 'remote-3', name: 'another' }),
    ]
    // remote-2 与 old 同 URL 同分支；remote-3 不同仓库
    expect(matchEquivalentProject(old, candidates)?.id).toBe('remote-2')
  })

  it('多 worktree 场景：同 URL 不同分支，优先匹配分支相同的', () => {
    const old = makeProject({ id: 'local-1', currentBranch: 'feature/x' })
    const candidates = [
      makeProject({ id: 'wt-main', currentBranch: 'main' }),
      makeProject({ id: 'wt-feat', currentBranch: 'feature/x' }),
    ]
    expect(matchEquivalentProject(old, candidates)?.id).toBe('wt-feat')
  })

  it('同 URL 但分支都不同时回退命中第一个（同仓库兜底）', () => {
    const old = makeProject({ id: 'local-1', currentBranch: 'feature/x' })
    const candidates = [
      makeProject({ id: 'wt-main', currentBranch: 'main' }),
      makeProject({ id: 'wt-dev', currentBranch: 'dev' }),
    ]
    expect(matchEquivalentProject(old, candidates)?.id).toBe('wt-main')
  })

  it('remoteURL 规范化：.git 后缀、尾斜杠、大小写不敏感', () => {
    const old = makeProject({ id: 'local-1', remoteURL: 'https://GitHub.com/Foo/Demo.git/' })
    const candidates = [
      makeProject({ id: 'remote-1', remoteURL: 'git@github.com:bar/zzz.git' }),
      makeProject({ id: 'remote-2', remoteURL: 'https://github.com/foo/demo' }),
    ]
    expect(matchEquivalentProject(old, candidates)?.id).toBe('remote-2')
  })

  it('无 remote 信息时按名称兜底命中', () => {
    const old = makeProject({ id: 'local-1', remoteURL: '' })
    const candidates = [
      makeProject({ id: 'remote-1', name: 'other', remoteURL: '' }),
      makeProject({ id: 'remote-2', name: 'Demo', remoteURL: '' }),
    ]
    expect(matchEquivalentProject(old, candidates)?.id).toBe('remote-2')
  })

  it('名称兜底时同名多个优先分支相同的', () => {
    const old = makeProject({ id: 'local-1', remoteURL: '', currentBranch: 'dev' })
    const candidates = [
      makeProject({ id: 'r1', name: 'demo', remoteURL: '', currentBranch: 'main' }),
      makeProject({ id: 'r2', name: 'demo', remoteURL: '', currentBranch: 'dev' }),
    ]
    expect(matchEquivalentProject(old, candidates)?.id).toBe('r2')
  })

  it('完全不匹配返回 null', () => {
    const old = makeProject({ id: 'local-1' })
    expect(matchEquivalentProject(old, [])).toBeNull()
    expect(
      matchEquivalentProject(old, [makeProject({ id: 'x', name: 'zzz', remoteURL: 'https://a/b.git' })]),
    ).toBeNull()
  })
})
