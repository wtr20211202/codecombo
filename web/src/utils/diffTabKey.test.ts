import { describe, expect, it } from 'vitest'
import { parseDiffKey, diffRightIsWorkspace, diffWorkspaceTarget } from './diffTabKey'

// diff 标签伪键解析与「在编辑器打开」守卫（P-20261003-57）：
// 键模板 diff:<oldRef>:<newRef>:<filePath>（useOpenFiles.openDiffView 产出）
describe('parseDiffKey', () => {
  it('解析工作区 diff 键（变更面板 oldRef=HEAD 无 newRef → wt）', () => {
    expect(parseDiffKey('diff:HEAD:wt:src/app.ts')).toEqual({
      oldRef: 'HEAD', newRef: 'wt', filePath: 'src/app.ts',
    })
  })

  it('解析历史对比键（commits 面板 base hash ↔ HEAD）', () => {
    expect(parseDiffKey('diff:1a2b3c4d:HEAD:README.md')).toEqual({
      oldRef: '1a2b3c4d', newRef: 'HEAD', filePath: 'README.md',
    })
  })

  it('filePath 段含冒号不截断（远程伪路径形态）', () => {
    expect(parseDiffKey('diff:HEAD:wt:remote:h1:/etc/nginx.conf')?.filePath).toBe('remote:h1:/etc/nginx.conf')
  })

  it('解析变更基线分流键（P-20261004-42：HEAD↔index / index↔wt）', () => {
    expect(parseDiffKey('diff:HEAD:index:src/app.ts')).toEqual({
      oldRef: 'HEAD', newRef: 'index', filePath: 'src/app.ts',
    })
    expect(parseDiffKey('diff:index:wt:src/app.ts')).toEqual({
      oldRef: 'index', newRef: 'wt', filePath: 'src/app.ts',
    })
  })

  it('非 diff: 键 / 段缺失返回 null', () => {
    expect(parseDiffKey('src/app.ts')).toBeNull()
    expect(parseDiffKey('untitled://1')).toBeNull()
    expect(parseDiffKey('diff:HEAD')).toBeNull()
    expect(parseDiffKey('diff:')).toBeNull()
  })
})

describe('diffRightIsWorkspace', () => {
  it('wt / clipboard / cmpto- 右侧均为工作区版本', () => {
    expect(diffRightIsWorkspace({ oldRef: 'HEAD', newRef: 'wt', filePath: 'a.ts' })).toBe(true)
    expect(diffRightIsWorkspace({ oldRef: 'clipboard', newRef: 'wt', filePath: 'a.ts' })).toBe(true)
    expect(diffRightIsWorkspace({ oldRef: 'cmpto-base.ts%401', newRef: 'wt', filePath: 'a.ts' })).toBe(true)
  })

  it('HEAD / commit sha / index 右侧为历史或暂存区版本，不适用', () => {
    expect(diffRightIsWorkspace({ oldRef: '1a2b3c4d', newRef: 'HEAD', filePath: 'a.ts' })).toBe(false)
    expect(diffRightIsWorkspace({ oldRef: 'HEAD', newRef: '9f8e7d6c', filePath: 'a.ts' })).toBe(false)
    expect(diffRightIsWorkspace({ oldRef: 'HEAD', newRef: 'index', filePath: 'a.ts' })).toBe(false)
  })
})

describe('diffWorkspaceTarget', () => {
  it('工作区 diff 返回真实文件路径（「在编辑器打开」可用）', () => {
    expect(diffWorkspaceTarget('diff:HEAD:wt:src/app.ts')).toBe('src/app.ts')
    expect(diffWorkspaceTarget('diff:clipboard:wt:notes.md')).toBe('notes.md')
  })

  it('历史对比 / 远程伪路径返回 null（守卫置灰）', () => {
    expect(diffWorkspaceTarget('diff:1a2b3c4d:HEAD:README.md')).toBeNull()
    expect(diffWorkspaceTarget('diff:HEAD:wt:remote:h1:/etc/hosts')).toBeNull()
  })

  it('非 diff 键返回 null', () => {
    expect(diffWorkspaceTarget('src/app.ts')).toBeNull()
  })
})
