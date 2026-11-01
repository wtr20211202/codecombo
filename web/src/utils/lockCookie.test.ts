import { describe, expect, it } from 'vitest'
import { buildClearLockCookie, LOCK_COOKIE_NAME } from './lockCookie'

// 解锁 cookie 载体（P-20261020-1 引入，P-20261019-2 起由服务端专管）：
// JS 侧只剩清除串，用于清掉旧版本前端 document.cookie 写入的非 HttpOnly
// 遗留 cookie；服务端签发的 HttpOnly cookie 对 document.cookie 写免疫。

describe('lockCookie', () => {
  it('清除串与旧写入侧属性对齐（path=/ + max-age=0 + SameSite）', () => {
    expect(buildClearLockCookie(true)).toBe(`${LOCK_COOKIE_NAME}=; path=/; SameSite=Lax; max-age=0; Secure`)
    expect(buildClearLockCookie(false)).toBe(`${LOCK_COOKIE_NAME}=; path=/; SameSite=Lax; max-age=0`)
  })

  it('cookie 名与服务端 middleware.LockCookieName 对应', () => {
    expect(LOCK_COOKIE_NAME).toBe('sc_lock_token')
  })
})
