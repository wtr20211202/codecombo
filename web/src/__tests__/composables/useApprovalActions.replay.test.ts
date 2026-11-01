import { describe, it, expect } from 'vitest'
import { pickClaudeConversation } from '../../composables/useApprovalActions'
import type { ClaudeSessionInfo } from '../../api/domains/claude'

// pickClaudeConversation 纯函数单测（P-20261002-82）：审批卡「回放」目标
// 消歧——同工作目录多条 Claude 对话按「审批时刻与活跃窗口的距离」选最近
describe('pickClaudeConversation', () => {
  function conv(partial: Partial<ClaudeSessionInfo>): ClaudeSessionInfo {
    return {
      id: 's',
      title: 't',
      cwd: 'D:\\demo',
      messageCount: 1,
      firstAt: '',
      lastAt: '',
      sizeBytes: 0,
      active: false,
      ...partial,
    }
  }

  it('时刻落在活跃窗口内的会话胜出（距离 0）', () => {
    const a = conv({ id: 'a', firstAt: '2026-10-01T08:00:00Z', lastAt: '2026-10-01T09:00:00Z' })
    const b = conv({ id: 'b', firstAt: '2026-10-01T09:10:00Z', lastAt: '2026-10-01T09:20:00Z' })
    expect(pickClaudeConversation([a, b], '2026-10-01T08:30:00Z')?.id).toBe('a')
  })

  it('全体在窗口外：取窗口边界最近的', () => {
    const a = conv({ id: 'a', firstAt: '2026-10-01T07:00:00Z', lastAt: '2026-10-01T07:10:00Z' })
    const b = conv({ id: 'b', firstAt: '2026-10-01T06:00:00Z', lastAt: '2026-10-01T06:05:00Z' })
    expect(pickClaudeConversation([b, a], '2026-10-01T07:12:00Z')?.id).toBe('a')
  })

  it('无审批时刻：退化为最近活动（lastAt 最新）', () => {
    const a = conv({ id: 'a', firstAt: '2026-10-01T07:00:00Z', lastAt: '2026-10-01T07:10:00Z' })
    const b = conv({ id: 'b', firstAt: '2026-10-01T09:00:00Z', lastAt: '2026-10-01T09:10:00Z' })
    expect(pickClaudeConversation([a, b])?.id).toBe('b')
  })

  it('空候选返回 null', () => {
    expect(pickClaudeConversation([], '2026-10-01T08:00:00Z')).toBeNull()
  })
})
