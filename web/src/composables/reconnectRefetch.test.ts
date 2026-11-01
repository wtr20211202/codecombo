import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerReconnectRefetch,
  registeredReconnectDomains,
  resetReconnectRefetchRegistryForTest,
  runReconnectRefetches,
} from './reconnectRefetch'

/**
 * 重连补拉集中注册表（P-20261003-236）语义单测：注册/覆盖/统一遍历/失败收口。
 * 各域 fn 的业务行为由域主自身测试覆盖（如 notification.test.ts 的 onOpen
 * 补拉用例——经本注册表路径触发）；此处只测注册表本体。
 */

// 微任务排空：run 的 fn 经 Promise.resolve().then 延迟，断言前先让微任务落地
const flushMicrotasks = () => new Promise<void>(r => setTimeout(r, 0))

beforeEach(() => {
  // 注册表是模块级单例：逐用例清空防串扰（生产代码不得调用本出口）
  resetReconnectRefetchRegistryForTest()
})

describe('reconnectRefetch registry', () => {
  it('注册即入表：run 按注册序遍历执行全部域，fn 同步起跑（原 refetchAfterReconnect 派发时序）', async () => {
    const calls: string[] = []
    registerReconnectRefetch('a', () => { calls.push('a') })
    registerReconnectRefetch('b', () => { calls.push('b') })
    expect(registeredReconnectDomains()).toEqual(['a', 'b'])

    runReconnectRefetches()
    // 同步派发：run 返回前 fn 已执行（onOpen 返回前请求已发出的既有语义）
    expect(calls).toEqual(['a', 'b'])
    await flushMicrotasks()
    expect(calls).toEqual(['a', 'b'])
  })

  it('同域重复注册覆盖（装配幂等）：旧 fn 不再执行', async () => {
    const first = vi.fn()
    const second = vi.fn()
    registerReconnectRefetch('x', first)
    registerReconnectRefetch('x', second)

    expect(registeredReconnectDomains()).toEqual(['x'])
    runReconnectRefetches()
    await flushMicrotasks()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('单域拒绝不拖累其余域执行、经 console.warn 收口不产生未处理 rejection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = vi.fn()
    registerReconnectRefetch('bad', () => Promise.reject(new Error('boom')))
    registerReconnectRefetch('ok', ok)

    runReconnectRefetches()
    await flushMicrotasks()
    expect(ok).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('bad')
    warnSpy.mockRestore()
    // 未处理 rejection 由 vitest 默认判定为用例失败——本用例通过即收口成立
  })

  it('同步抛错与异步拒绝同途收口：不中断遍历', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = vi.fn()
    registerReconnectRefetch('sync-throw', () => { throw new Error('sync boom') })
    registerReconnectRefetch('ok', ok)

    runReconnectRefetches()
    await flushMicrotasks()
    expect(ok).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('sync-throw')
    warnSpy.mockRestore()
  })

  it('空表 run 无副作用；清空出口复位注册序', async () => {
    expect(() => runReconnectRefetches()).not.toThrow()
    expect(registeredReconnectDomains()).toEqual([])

    registerReconnectRefetch('a', () => {})
    resetReconnectRefetchRegistryForTest()
    expect(registeredReconnectDomains()).toEqual([])
  })
})
