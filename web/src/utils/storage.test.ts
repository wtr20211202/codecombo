import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeStorage } from './storage'

describe('safeStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('localStorage 读写删往返；未设置返回 null', () => {
    expect(safeStorage.getItem('k')).toBeNull()
    safeStorage.setItem('k', 'v1')
    expect(safeStorage.getItem('k')).toBe('v1')
    safeStorage.setItem('k', 'v2')
    expect(safeStorage.getItem('k')).toBe('v2')
    safeStorage.removeItem('k')
    expect(safeStorage.getItem('k')).toBeNull()
  })

  it('sessionStorage 读写删往返（与 localStorage 命名空间隔离）', () => {
    safeStorage.sessionSet('sk', 'sv')
    expect(safeStorage.sessionGet('sk')).toBe('sv')
    expect(safeStorage.getItem('sk')).toBeNull()
    safeStorage.sessionRemove('sk')
    expect(safeStorage.sessionGet('sk')).toBeNull()
  })

  it('localStorage 属性访问被隐私模式屏蔽（访问即抛）时落内存兜底，会话内可用', () => {
    const orig = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new TypeError('SecurityError: blocked') },
    })
    try {
      safeStorage.setItem('fk', 'fv')
      expect(safeStorage.getItem('fk')).toBe('fv')
      // removeItem 同时清内存兜底
      safeStorage.removeItem('fk')
      expect(safeStorage.getItem('fk')).toBeNull()
    } finally {
      Object.defineProperty(window, 'localStorage', { value: orig, writable: true, configurable: true })
    }
  })

  it('setItem 超额抛错（QuotaExceeded）被吞掉：不炸调用链（会话内降级，无可见性承诺）', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    expect(() => safeStorage.setItem('qk', 'qv')).not.toThrow()
    // 如实语义：内存兜底仅在「存储访问不可用」窗口承载读写；存储可读时
    // 读到的是 localStorage 真值（写入失败即未持久化）
    expect(safeStorage.getItem('qk')).toBeNull()
  })

  it('getItem 抛错（读取被拦截）时回落内存兜底而非崩链（不可用窗口内写入可读回）', () => {
    // 第一步：存储访问整体被屏蔽（隐私模式形态）→ 写入落内存镜像
    const orig = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new TypeError('SecurityError: blocked') },
    })
    safeStorage.setItem('rk', 'rv')
    Object.defineProperty(window, 'localStorage', { value: orig, writable: true, configurable: true })
    // 第二步：存储恢复但 getItem 被拦 → catch 落内存兜底，镜像值仍可读
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new TypeError('read blocked') })
    expect(safeStorage.getItem('rk')).toBe('rv')
    spy.mockRestore()
    safeStorage.removeItem('rk')
  })

  it('sessionStorage 不可用（属性访问即抛）时内存兜底可读写', () => {
    const orig = window.sessionStorage
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new TypeError('SecurityError: blocked') },
    })
    try {
      safeStorage.sessionSet('mk', 'mv')
      expect(safeStorage.sessionGet('mk')).toBe('mv')
      safeStorage.sessionRemove('mk')
      expect(safeStorage.sessionGet('mk')).toBeNull()
    } finally {
      Object.defineProperty(window, 'sessionStorage', { value: orig, writable: true, configurable: true })
    }
  })
})
