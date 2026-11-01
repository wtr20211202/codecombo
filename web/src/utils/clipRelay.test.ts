import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clipByteLength, isForeignArrival, ownClipDeviceId, readLocalClipboardText, resetClipRelayStateForTest } from './clipRelay'
import { safeStorage } from './storage'

// 跨设备剪贴板中继（P-20261002-32）纯函数面：设备 id 持久与回声过滤、
// 本机剪贴板读取的降级链（readText → 应用内历史 → null）

const DEVICE_KEY = 'sc.clip-relay.device'

beforeEach(() => {
  resetClipRelayStateForTest()
  safeStorage.removeItem(DEVICE_KEY)
})

afterEach(() => {
  // 还原可能被用例替换的 navigator.clipboard（jsdom 无此属性，逐个清理）
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('ownClipDeviceId', () => {
  it('首次生成并持久化，后续调用稳定复用', () => {
    const id1 = ownClipDeviceId()
    expect(id1).toBeTruthy()
    expect(safeStorage.getItem(DEVICE_KEY)).toBe(id1)
    expect(ownClipDeviceId()).toBe(id1)
  })

  it('持久层已有 id 时直接复用不重生成', () => {
    safeStorage.setItem(DEVICE_KEY, 'clip-existing')
    expect(ownClipDeviceId()).toBe('clip-existing')
  })

  it('持久层丢失（清存储）后重新生成，不与旧值相同', () => {
    const id1 = ownClipDeviceId()
    safeStorage.removeItem(DEVICE_KEY)
    resetClipRelayStateForTest()
    expect(ownClipDeviceId()).not.toBe(id1)
  })
})

describe('isForeignArrival', () => {
  it('origin 等于本机 id = 自己的回声，不提示', () => {
    const own = ownClipDeviceId()
    expect(isForeignArrival({ origin: own, size: 3 })).toBe(false)
  })

  it('origin 不同 = 他机到达', () => {
    ownClipDeviceId()
    expect(isForeignArrival({ origin: 'clip-other-device', size: 3 })).toBe(true)
  })

  it('origin 缺失按他人处理（宁多提示不漏提示）', () => {
    expect(isForeignArrival(undefined)).toBe(true)
    expect(isForeignArrival({})).toBe(true)
    expect(isForeignArrival({ origin: '  ' })).toBe(true)
  })
})

describe('readLocalClipboardText', () => {
  it('readText 可用且非空 → 原样返回', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: async () => 'from-clipboard' },
      configurable: true,
    })
    await expect(readLocalClipboardText([{ text: 'from-history' }])).resolves.toBe('from-clipboard')
  })

  it('readText 拒绝（权限/失焦）→ 回退应用内历史最新一条', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: async () => { throw new Error('denied') } },
      configurable: true,
    })
    await expect(readLocalClipboardText([{ text: 'mru-entry' }, { text: 'older' }])).resolves.toBe('mru-entry')
  })

  it('readText 返回空串 → 回退应用内历史', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: async () => '' },
      configurable: true,
    })
    await expect(readLocalClipboardText([{ text: 'history-fallback' }])).resolves.toBe('history-fallback')
  })

  it('非安全上下文（clipboard 为 undefined）→ 回退应用内历史', async () => {
    await expect(readLocalClipboardText([{ text: 'lan-http-fallback' }])).resolves.toBe('lan-http-fallback')
  })

  it('两条来源皆空 → null（调用方给无可发送提示）', async () => {
    await expect(readLocalClipboardText([])).resolves.toBeNull()
  })
})

describe('clipByteLength', () => {
  it('按 UTF-8 字节计（CJK 下 length 低估）', () => {
    expect(clipByteLength('abc')).toBe(3)
    expect(clipByteLength('密')).toBe(3)
  })
})
