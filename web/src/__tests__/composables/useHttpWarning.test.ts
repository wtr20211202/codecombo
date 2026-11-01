import { describe, it, expect } from 'vitest'
import { isPlainHttpContext, useHttpWarning } from '@/composables/useHttpWarning'

// HTTP 明文访问警示（P-20261002-30）：检测谓词全组合 + dismiss 记忆落盘。
// jsdom 的 window.location 不可替换（Unforgeable），默认 origin 即
// http://localhost —— 恰好直接覆盖「loopback 豁免」主路径的运行时形态。

describe('isPlainHttpContext', () => {
  it('http + 非 loopback 主机名 → 明文访问（警示出现）', () => {
    expect(isPlainHttpContext({ protocol: 'http:', hostname: '192.168.1.10' })).toBe(true)
    expect(isPlainHttpContext({ protocol: 'http:', hostname: 'gpu-server.lan' })).toBe(true)
  })

  it('http + loopback 主机名 → 豁免（硬要求：全量 e2e 跑在 http://localhost）', () => {
    expect(isPlainHttpContext({ protocol: 'http:', hostname: 'localhost' })).toBe(false)
    expect(isPlainHttpContext({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(false)
    // URL.hostname 对 IPv6 回环返回无方括号形式
    expect(isPlainHttpContext({ protocol: 'http:', hostname: '::1' })).toBe(false)
    expect(isPlainHttpContext({ protocol: 'http:', hostname: 'LOCALHOST' })).toBe(false)
  })

  it('https 下无论主机名 → 不警示（已加密）', () => {
    expect(isPlainHttpContext({ protocol: 'https:', hostname: '192.168.1.10' })).toBe(false)
    expect(isPlainHttpContext({ protocol: 'https:', hostname: 'localhost' })).toBe(false)
  })
})

describe('useHttpWarning', () => {
  it('jsdom 默认 localhost origin 下 visible 恒为 false（豁免生效）', () => {
    expect(window.location.protocol).toBe('http:')
    expect(window.location.hostname).toBe('localhost')
    const { visible } = useHttpWarning()
    expect(visible.value).toBe(false)
  })

  it('dismiss() 把记忆写入 localStorage（safeStorage 键），锁屏/顶栏共享', () => {
    localStorage.removeItem('sc.httpWarningDismissed')
    const { dismiss } = useHttpWarning()
    dismiss()
    expect(localStorage.getItem('sc.httpWarningDismissed')).toBe('1')
    localStorage.removeItem('sc.httpWarningDismissed')
  })
})
