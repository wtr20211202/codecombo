import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { opsBrowserId, opsBrowserIdQuery, resetOpsBrowserIdForTest } from './opsBrowserId'
import { safeStorage } from './storage'

// ops 通道浏览器实例 id（P-20261117-4）纯函数面：持久/复用/脏值重生成——
// clipRelay ownClipDeviceId（P-20261002-32）同款每浏览器粒度的姊妹面

const BROWSER_ID_KEY = 'sc.ops.browserId'

beforeEach(() => {
  resetOpsBrowserIdForTest()
  safeStorage.removeItem(BROWSER_ID_KEY)
})

describe('opsBrowserId', () => {
  it('首次生成并持久化，后续调用稳定复用（同浏览器多标签共享的前提）', () => {
    const id1 = opsBrowserId()
    expect(id1).toBeTruthy()
    expect(safeStorage.getItem(BROWSER_ID_KEY)).toBe(id1)
    expect(opsBrowserId()).toBe(id1)
  })

  it('持久层已有 id 时直接复用不重生成', () => {
    safeStorage.setItem(BROWSER_ID_KEY, 'ops-existing')
    expect(opsBrowserId()).toBe('ops-existing')
  })

  it('生成形态过服务端 SanitizeBrowserId 口径：ops- 前缀 + 白名单字符集 + ≤64', () => {
    const id = opsBrowserId()
    expect(id).toMatch(/^ops-[0-9a-z]+-[0-9a-z]+$/)
    expect(id.length).toBeLessThanOrEqual(64)
  })

  it('脏值（字符集外/超限）被拒收重生成——宁可新 id 不静默失联', () => {
    safeStorage.setItem(BROWSER_ID_KEY, 'bad id with space/path')
    const id = opsBrowserId()
    expect(id).toMatch(/^ops-/)
    expect(safeStorage.getItem(BROWSER_ID_KEY)).toBe(id)
    safeStorage.setItem(BROWSER_ID_KEY, 'x'.repeat(65))
    resetOpsBrowserIdForTest()
    expect(opsBrowserId().length).toBeLessThanOrEqual(64)
  })

  it('query 形态 = browserId= 编码携带（WS 握手/请求头同源）', () => {
    safeStorage.setItem(BROWSER_ID_KEY, 'ops-fixed')
    resetOpsBrowserIdForTest()
    expect(opsBrowserIdQuery()).toBe('browserId=ops-fixed')
  })
})

afterEach(() => {
  safeStorage.removeItem(BROWSER_ID_KEY)
})
