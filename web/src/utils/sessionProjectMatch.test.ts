import { describe, it, expect } from 'vitest'
import { sessionBelongsToProject } from './sessionProjectMatch'

describe('sessionBelongsToProject', () => {
  const pid = 'p1'
  const root = 'D:/ws/demo'

  it('shell 会话按 projectId 绑定判定', () => {
    expect(sessionBelongsToProject({ id: 'a', kind: 'shell', projectId: 'p1' }, pid, root)).toBe(true)
    expect(sessionBelongsToProject({ id: 'a', kind: 'shell', projectId: 'p2' }, pid, root)).toBe(false)
    expect(sessionBelongsToProject({ id: 'a', kind: 'shell', projectId: '' }, pid, root)).toBe(false)
  })

  it('agent 会话工作目录=项目根 判定为归属', () => {
    expect(sessionBelongsToProject({ id: 'b', kind: 'agent', projectId: '', path: 'D:\\ws\\demo' }, pid, root)).toBe(true)
  })

  it('agent 会话工作目录=项目子目录 判定为归属（反斜杠归一）', () => {
    expect(sessionBelongsToProject({ id: 'c', kind: 'agent', projectId: '', currentDir: 'D:\\ws\\demo\\sub\\pkg' }, pid, root)).toBe(true)
  })

  it('agent 会话目录在项目外（同名前缀目录也不算）不归属', () => {
    expect(sessionBelongsToProject({ id: 'd', kind: 'agent', projectId: '', path: 'D:/ws/demo-x' }, pid, root)).toBe(false)
    expect(sessionBelongsToProject({ id: 'e', kind: 'agent', projectId: '', path: 'E:/elsewhere' }, pid, root)).toBe(false)
  })

  it('无目录线索的 agent 会话宁漏不计', () => {
    expect(sessionBelongsToProject({ id: 'f', kind: 'agent', projectId: '' }, pid, root)).toBe(false)
    expect(sessionBelongsToProject({ id: 'g', kind: 'agent', projectId: '', path: 'D:/ws/demo' }, pid, '')).toBe(false)
  })

  it('尾部斜杠与混合分隔符归一后相等', () => {
    expect(sessionBelongsToProject({ id: 'h', kind: 'agent', projectId: '', path: 'D:\\ws\\demo\\' }, pid, 'D:/ws/demo/')).toBe(true)
  })

  it('其他 kind 不归属；空会话防御', () => {
    expect(sessionBelongsToProject({ id: 'i', kind: 'other', projectId: 'p1' }, pid, root)).toBe(false)
    expect(sessionBelongsToProject(null as unknown as Parameters<typeof sessionBelongsToProject>[0], pid, root)).toBe(false)
  })
})
