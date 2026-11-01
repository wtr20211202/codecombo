import { describe, expect, it, vi } from 'vitest'
import { friendlyRemoteError } from './remoteErrors'

// i18n stub：直接返回 key（断言映射目标而非文案本身）
const t = vi.fn((key: string) => key)

describe('friendlyRemoteError', () => {
  it('认证类错误映射为可行动提示', () => {
    const msg = 'ssh dial 127.0.0.1:23: auth rejected by remote server: unable to authenticate'
    expect(friendlyRemoteError(msg, t)).toBe('errors.known.authFailed')
  })

  it('连接拒绝映射', () => {
    expect(friendlyRemoteError('dial tcp 10.0.0.5:22: connect: connection refused', t))
      .toBe('errors.known.connRefused')
  })

  it('网络不可达/超时映射', () => {
    expect(friendlyRemoteError('dial tcp: i/o timeout', t)).toBe('errors.known.netUnreachable')
    expect(friendlyRemoteError('no route to host', t)).toBe('errors.known.netUnreachable')
  })

  it('权限不足映射', () => {
    expect(friendlyRemoteError('open /tmp/x: permission denied', t))
      .toBe('errors.known.permissionDenied')
  })

  it('无法识别的原文原样返回（排障线索不丢失）', () => {
    const raw = 'some totally unknown failure'
    expect(friendlyRemoteError(raw, t)).toBe(raw)
  })
})
