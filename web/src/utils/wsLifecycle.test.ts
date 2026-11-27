import { beforeEach, describe, expect, it } from 'vitest'
import {
  WS_LIFECYCLE_LIMIT,
  clearWsLifecycle,
  getWsLifecycleEntries,
  recordWsLifecycle,
  wsCloseKindOf,
} from './wsLifecycle'

describe('wsLifecycle 生命周期环（S1a④）', () => {
  beforeEach(() => clearWsLifecycle())

  it('记录模板化路径：host/query/token 不入环', () => {
    recordWsLifecycle(
      'ws://127.0.0.1:9999/ws/terminal/t-1?browserId=secret-browser',
      1006, '', false, Date.now() - 5000, 2, false,
    )
    const e = getWsLifecycleEntries()[0]!
    expect(e.path).toBe('/ws/terminal/:id')
    expect(e.code).toBe(1006)
    expect(e.closeKind).toBe('abnormal')
    expect(e.wasClean).toBe(false)
    expect(e.attempt).toBe(2)
    expect(e.intentional).toBe(false)
    expect(e.openMs).toBeGreaterThanOrEqual(4000)
  })

  it('1006/4001/1009/1011 分别保留（各自语义分类）', () => {
    recordWsLifecycle('ws://h/ws/projects/p1', 1006, 'abnormal', false, 0, 1, false)
    recordWsLifecycle('ws://h/ws/terminal/t1', 4001, 'locked', false, 0, 0, false)
    recordWsLifecycle('ws://h/ws/terminal/t2', 1009, 'too big', true, 0, 0, false)
    recordWsLifecycle('ws://h/ws/notifications', 1011, 'boom', false, 0, 0, false)
    const got = getWsLifecycleEntries().map((e) => [e.code, e.closeKind])
    expect(got).toEqual([[1011, 'internal-error'], [1009, 'message-too-big'], [4001, 'locked'], [1006, 'abnormal']])
  })

  it('主动关闭（1005/intentional）归 normal，与 4001 锁定拒绝区分', () => {
    recordWsLifecycle('ws://h/ws/terminal/t1', 1005, '', true, Date.now(), 0, true)
    const e = getWsLifecycleEntries()[0]!
    expect(e.intentional).toBe(true)
    expect(e.closeKind).toBe('normal')
    expect(wsCloseKindOf(4001, true)).toBe('locked')
  })

  it('reason 截断 200 并去绝对路径', () => {
    recordWsLifecycle('ws://h/ws/terminal/t1', 1000, `x ${'/home/alice/secret'} ${'y'.repeat(300)}`, true, 0, 0, true)
    const e = getWsLifecycleEntries()[0]!
    expect(e.reason.length).toBeLessThanOrEqual(200)
    expect(e.reason).not.toContain('alice')
    expect(e.reason).toContain('<path>')
  })

  it('环上限 50 最旧淘汰；get 返回拷贝', () => {
    for (let i = 0; i < WS_LIFECYCLE_LIMIT + 5; i++) {
      recordWsLifecycle(`ws://h/ws/clone/task-${i}`, 1000, '', true, 0, 0, true)
    }
    const got = getWsLifecycleEntries()
    expect(got).toHaveLength(WS_LIFECYCLE_LIMIT)
    got[0]!.code = 9999
    expect(getWsLifecycleEntries()[0]!.code).toBe(1000)
  })

  // ── 分支覆盖：全 code 判定 / 缺省值归一 ──
  it('close code 语义矩阵：1000/1001/1005 正常、0=仅 error、其余 unknown、4001 优先锁定', () => {
    expect(wsCloseKindOf(1000, false)).toBe('normal')
    expect(wsCloseKindOf(1001, false)).toBe('normal')
    expect(wsCloseKindOf(1005, false)).toBe('normal')
    expect(wsCloseKindOf(0, false)).toBe('error')
    expect(wsCloseKindOf(3000, false)).toBe('unknown')
    // 服务端语义码优先于 intentional（4001 + intentional 仍是 locked）
    expect(wsCloseKindOf(4001, true)).toBe('locked')
    expect(wsCloseKindOf(1006, true)).toBe('abnormal')
  })

  it('缺省值归一：openedAt=0 无 openMs；非法 code/attempt→0；reason 非字符串→空串', () => {
    recordWsLifecycle(
      'ws://h/ws/deploy/t1',
      Number.NaN,
      undefined as unknown as string,
      undefined as unknown as boolean,
      0,
      Number.NaN,
      false,
    )
    const e = getWsLifecycleEntries()[0]!
    expect(e.code).toBe(0)
    expect(e.attempt).toBe(0)
    expect(e.reason).toBe('')
    expect(e.wasClean).toBe(false)
    expect(e.openMs).toBeUndefined()
  })
})
