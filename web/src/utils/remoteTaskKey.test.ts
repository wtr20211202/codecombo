import { describe, it, expect } from 'vitest'
import { remoteTaskKey, parseRemoteTaskKey, REMOTE_TASK_PREFIX } from '@/utils/remoteTaskKey'

// 远程任务进度命名空间（P-20261004-131）：构建/解析往返 + 形态守卫——
// 本地会话 id（uuid）不可能命中 remote: 前缀，两命名空间零交集

describe('remoteTaskKey 构建/解析', () => {
  it('构建形态 = remote:<instanceId>:<sessionId>', () => {
    expect(remoteTaskKey('inst-1', 'term-9')).toBe('remote:inst-1:term-9')
    expect(REMOTE_TASK_PREFIX).toBe('remote:')
  })

  it('解析往返一致', () => {
    const ref = parseRemoteTaskKey(remoteTaskKey('inst-abc', 'term-xyz'))
    expect(ref).toEqual({ instanceId: 'inst-abc', sessionId: 'term-xyz' })
  })

  it('sessionId 段可含冒号（首冒号后整体归 sessionId）', () => {
    expect(parseRemoteTaskKey('remote:inst-1:term-a:b')).toEqual({
      instanceId: 'inst-1',
      sessionId: 'term-a:b',
    })
  })
})

describe('parseRemoteTaskKey 形态守卫', () => {
  it('本地会话 id（无前缀）返回 null', () => {
    expect(parseRemoteTaskKey('b3f1c2a4-1234-5678-9abc-def012345678')).toBeNull()
    expect(parseRemoteTaskKey('term-local-1')).toBeNull()
  })

  it('段缺失/空段返回 null', () => {
    expect(parseRemoteTaskKey('remote:')).toBeNull()
    expect(parseRemoteTaskKey('remote:inst-1')).toBeNull()
    expect(parseRemoteTaskKey('remote:inst-1:')).toBeNull()
    expect(parseRemoteTaskKey('remote::term-1')).toBeNull()
  })

  it('空值/远前缀污染返回 null', () => {
    expect(parseRemoteTaskKey('')).toBeNull()
    expect(parseRemoteTaskKey(null)).toBeNull()
    expect(parseRemoteTaskKey(undefined)).toBeNull()
    expect(parseRemoteTaskKey('remoteX:a:b')).toBeNull()
    // 前缀大小写敏感：REMOTE: 不命中
    expect(parseRemoteTaskKey('REMOTE:a:b')).toBeNull()
  })
})
