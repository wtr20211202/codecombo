import { describe, expect, it } from 'vitest'
import { buildAgentMarksMarkdown, summarizeAgentMarks } from './agentMarksList'

describe('buildAgentMarksMarkdown', () => {
  it('按全路径字典序（目录分组序）输出 markdown 行式清单', () => {
    const marks = new Map([
      ['readme.md', { sessions: 1, runtimes: ['claude'] }],
      ['notes/a.txt', { sessions: 1, runtimes: ['codex'] }],
      ['src/deep/b.ts', { sessions: 1, runtimes: ['claude'] }],
    ])
    expect(buildAgentMarksMarkdown(marks, '未知运行时')).toBe(
      ['- notes/a.txt (codex)', '- readme.md (claude)', '- src/deep/b.ts (claude)'].join('\n'),
    )
  })

  it('多会话共改标注 ×N，runtime 列表去重拼接（useAgentMarks 聚合契约）', () => {
    const marks = new Map([
      ['src/app.ts', { sessions: 3, runtimes: ['claude', 'codex'] }],
    ])
    expect(buildAgentMarksMarkdown(marks, '未知运行时')).toBe('- src/app.ts (claude/codex) ×3')
  })

  it('单会话无 ×N 后缀；空 runtime 降级未知运行时标注', () => {
    const marks = new Map([
      ['x.txt', { sessions: 1, runtimes: [] }],
    ])
    expect(buildAgentMarksMarkdown(marks, 'unknown runtime')).toBe('- x.txt (unknown runtime)')
  })

  it('空清单返回空串（调用方以 marks 非空门控，兜底不产出悬空行）', () => {
    expect(buildAgentMarksMarkdown(new Map(), '未知运行时')).toBe('')
  })
})

describe('summarizeAgentMarks 归属摘要（P-20261005-172）', () => {
  it('只数命中 marks 的文件，runtime 并集去重（marks 记录序）', () => {
    const marks = new Map<string, { sessions: number; runtimes: string[] }>([
      ['a.ts', { sessions: 1, runtimes: ['claude'] }],
      ['b.ts', { sessions: 2, runtimes: ['codex', 'claude'] }],
    ])
    expect(summarizeAgentMarks([{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'human.ts' }], marks)).toEqual({
      count: 2,
      runtimes: ['claude', 'codex'],
    })
  })

  it('无命中返回 null（调用方整行省略，不出空归属行）', () => {
    const marks = new Map([['other.ts', { sessions: 1, runtimes: ['claude'] }]])
    expect(summarizeAgentMarks([{ path: 'a.ts' }, { path: 'b.ts' }], marks)).toBeNull()
  })

  it('空 marks / 空清单同样返回 null', () => {
    expect(summarizeAgentMarks([{ path: 'a.ts' }], new Map())).toBeNull()
    expect(summarizeAgentMarks([], new Map([['a.ts', { sessions: 1, runtimes: ['claude'] }]]))).toBeNull()
  })
})
