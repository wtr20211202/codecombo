import { describe, it, expect } from 'vitest'
import { buildSessionDeepLinkUrl, normCwd, projectIdForCwd, turnParam } from '../../utils/sessionDeepLink'

// 会话回放深链纯函数单测（P-20261003-154）：URL 约定单一事实源（复制端
// SessionTimeline.copyTurnLink 与消费端 useSessionReplayDeepLink 共用）
describe('buildSessionDeepLinkUrl', () => {
  it('全参数：origin + /project?session=&project=&turn=（参数序定位域在前）', () => {
    expect(buildSessionDeepLinkUrl('http://localhost:9999', {
      sessionId: 'abc-123',
      turn: 47,
      projectId: 'p1',
    })).toBe('http://localhost:9999/project?session=abc-123&project=p1&turn=47')
  })

  it('无归属项目：省略 project 参数（会话 id 全局可寻址）', () => {
    expect(buildSessionDeepLinkUrl('http://x', { sessionId: 's1', turn: 2 }))
      .toBe('http://x/project?session=s1&turn=2')
  })

  it('无 turn：只开会话不定位；sessionId 经 URL 编码', () => {
    expect(buildSessionDeepLinkUrl('http://x', { sessionId: 'a b/c' }))
      .toBe('http://x/project?session=a%20b%2Fc')
  })
})

describe('turnParam', () => {
  it('仅接受 ≥1 整数（字符串/数字形态）', () => {
    expect(turnParam('47')).toBe(47)
    expect(turnParam(1)).toBe(1)
  })

  it('缺省/非数值/零/负数/小数/数组重复参一律忽略', () => {
    expect(turnParam(undefined)).toBeUndefined()
    expect(turnParam('')).toBeUndefined()
    expect(turnParam('abc')).toBeUndefined()
    expect(turnParam('0')).toBeUndefined()
    expect(turnParam('-3')).toBeUndefined()
    expect(turnParam('2.5')).toBeUndefined()
    expect(turnParam(['1', '2'])).toBeUndefined()
  })
})

describe('normCwd', () => {
  it('反斜杠归一 + 去尾分隔符 + 小写（win 形态对齐）', () => {
    expect(normCwd('D:\\Demo\\Proj\\')).toBe('d:/demo/proj')
    expect(normCwd('/srv/demo/')).toBe('/srv/demo')
  })
})

describe('projectIdForCwd', () => {
  const projects = [
    { id: 'p1', path: 'D:\\demo\\proj' },
    { id: 'p2', path: '/srv/other' },
  ]

  it('精确匹配优先', () => {
    expect(projectIdForCwd(projects, 'D:\\demo\\proj')).toBe('p1')
  })

  it('精确落空走归一化兜底（分隔符/尾分隔符/大小写差异）', () => {
    expect(projectIdForCwd(projects, 'd:/demo/proj/')).toBe('p1')
  })

  it('不归属任何项目返回空串（调用方省略 project 参数）', () => {
    expect(projectIdForCwd(projects, '/nowhere/else')).toBe('')
    expect(projectIdForCwd(projects, '')).toBe('')
  })
})
