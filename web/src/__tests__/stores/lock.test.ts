import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useLockStore, applyLockRejection, getUnlockToken, setUnlockToken, LOCK_REJECTED_CLOSE_CODE } from '@/stores/lock'
import { lockApi } from '@/api/lock'

vi.mock('@/api/lock')

// P-20261019-2：令牌载体 = 进程内存态 + 服务端 HttpOnly cookie（不可 JS 读）。
// 本文件断言内存态（getUnlockToken）与「不再落 localStorage / 可读 cookie」；
// cookie 侧行为（HttpOnly/Strict/Secure）由服务端 Set-Cookie 保证，属 Go 单测
// 与 e2e 的断言面。

const ENABLED_STATE = {
  enabled: true,
  autoLockEnabled: true,
  autoLockMinutes: 120,
  tokenTTLMinutes: 120,
  isDefaultPassword: false,
  needsSetup: false,
}

const ENABLED_CONFIG = {
  enabled: true,
  autoLockEnabled: true,
  autoLockMinutes: 120,
  tokenTTLMinutes: 120,
}

describe('useLockStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    setUnlockToken(null)
    document.cookie = 'sc_lock_token=; path=/; max-age=0'
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('默认 isLocked=true（启动等 checkStatus）', () => {
    const store = useLockStore()
    expect(store.isLocked).toBe(true)
  })

  it('默认 isReady=false（启动等 checkStatus）', () => {
    const store = useLockStore()
    expect(store.isReady).toBe(false)
  })

  it('checkStatus 完成（无论成功/异常）后 isReady=true', async () => {
    // 异常路径：getState 抛错也应置 ready
    vi.mocked(lockApi.getState).mockRejectedValue(new Error('network down'))
    const store = useLockStore()
    await expect(store.checkStatus()).rejects.toThrow('network down')
    expect(store.isReady).toBe(true)
  })

  it('checkStatus 功能关闭 → isLocked=false', async () => {
    vi.mocked(lockApi.getState).mockResolvedValue({
      enabled: false,
      autoLockEnabled: true,
      autoLockMinutes: 120,
      tokenTTLMinutes: 120,
      isDefaultPassword: false,
    })
    const store = useLockStore()
    await store.checkStatus()
    expect(store.isLocked).toBe(false)
  })

  it('checkStatus 功能开 + 探测 423（无任何载体）→ isLocked=true', async () => {
    vi.mocked(lockApi.getState).mockResolvedValue({
      ...ENABLED_STATE,
      isDefaultPassword: true,
    })
    // cookie/内存都无有效会话：getConfig 探测失败（axios 拦截器之外的原始拒绝）
    vi.mocked(lockApi.getConfig).mockRejectedValue(new Error('423'))
    const store = useLockStore()
    await store.checkStatus()
    expect(store.isLocked).toBe(true)
    expect(store.isDefaultPassword).toBe(true)
    expect(store.unlockToken).toBeNull()
    expect(getUnlockToken()).toBeNull()
  })

  it('checkStatus 功能开 + cookie 载体探测通过（内存无 token）→ isLocked=false', async () => {
    vi.mocked(lockApi.getState).mockResolvedValue({ ...ENABLED_STATE })
    // 刷新后内存无 token，会话在 HttpOnly cookie：探测（同源请求自动带 cookie）通过
    vi.mocked(lockApi.getConfig).mockResolvedValue({ ...ENABLED_CONFIG })
    const store = useLockStore()
    await store.checkStatus()
    expect(store.isLocked).toBe(false)
  })

  it('checkStatus needsSetup=true → isLocked=true（走设密流程）', async () => {
    // 即使 enabled=false（无配置的 zero value），needsSetup 仍优先锁定
    vi.mocked(lockApi.getState).mockResolvedValue({
      enabled: false,
      autoLockEnabled: false,
      autoLockMinutes: 120,
      tokenTTLMinutes: 120,
      isDefaultPassword: false,
      needsSetup: true,
    })
    const store = useLockStore()
    await store.checkStatus()
    expect(store.isLocked).toBe(true)
    expect(store.needsSetup).toBe(true)
  })

  it('setup 成功 → token 只落内存（不写 localStorage/可读 cookie）+ 重新探测后 isLocked=false', async () => {
    // 第一次探测：无配置；setup 之后的重探测：配置已写入
    vi.mocked(lockApi.getState)
      .mockResolvedValueOnce({
        enabled: false,
        autoLockEnabled: false,
        autoLockMinutes: 120,
        tokenTTLMinutes: 120,
        isDefaultPassword: false,
        needsSetup: true,
      })
      .mockResolvedValue({
        ...ENABLED_STATE,
        needsSetup: false,
      })
    vi.mocked(lockApi.setup).mockResolvedValue({ token: 'scl_setup_token', expiresIn: 7200 })
    vi.mocked(lockApi.getConfig).mockResolvedValue({ ...ENABLED_CONFIG })

    const store = useLockStore()
    await store.checkStatus()
    expect(store.isLocked).toBe(true)

    await store.setup('new-pass-123')

    expect(store.isLocked).toBe(false)
    expect(store.needsSetup).toBe(false)
    expect(store.unlockToken).toBe('scl_setup_token')
    expect(getUnlockToken()).toBe('scl_setup_token')
    // 读取面收口：localStorage 与 document.cookie 都不再出现令牌
    expect(localStorage.getItem('sc.unlockToken')).toBeNull()
    expect(document.cookie).not.toContain('sc_lock_token=scl_setup_token')
  })

  it('unlock 成功 → token 只落内存 + isLocked=false + 遗留 localStorage 副本被清扫', async () => {
    vi.mocked(lockApi.getState).mockResolvedValue({
      ...ENABLED_STATE,
      isDefaultPassword: true,
    })
    vi.mocked(lockApi.getConfig).mockResolvedValue({ ...ENABLED_CONFIG })
    vi.mocked(lockApi.unlock).mockResolvedValue({
      token: 'scl_test_token',
      expiresIn: 7200,
    })

    // 模拟旧版本前端遗留的 localStorage 副本
    localStorage.setItem('sc.unlockToken', 'scl_legacy_copy')

    const store = useLockStore()
    await store.checkStatus()
    await store.unlock('admin')

    expect(store.isLocked).toBe(false)
    expect(store.unlockToken).toBe('scl_test_token')
    expect(getUnlockToken()).toBe('scl_test_token')
    expect(localStorage.getItem('sc.unlockToken')).toBeNull()
  })

  it('lock → 清内存 token + 清遗留副本 + isLocked=true', async () => {
    vi.mocked(lockApi.lock).mockResolvedValue(undefined)
    localStorage.setItem('sc.unlockToken', 'scl_old')
    setUnlockToken('scl_old')

    const store = useLockStore()
    await store.lock()

    expect(store.isLocked).toBe(true)
    expect(store.unlockToken).toBeNull()
    expect(getUnlockToken()).toBeNull()
    expect(localStorage.getItem('sc.unlockToken')).toBeNull()
  })

  it('lock API 失败时仍清本地 token（服务端已撤销场景）', async () => {
    vi.mocked(lockApi.lock).mockRejectedValue(new Error('token revoked'))
    localStorage.setItem('sc.unlockToken', 'scl_old')
    setUnlockToken('scl_old')

    const store = useLockStore()
    await store.lock()

    expect(store.isLocked).toBe(true)
    expect(store.unlockToken).toBeNull()
    expect(getUnlockToken()).toBeNull()
    expect(localStorage.getItem('sc.unlockToken')).toBeNull()
  })

  it('lock 无内存令牌（cookie-only 会话）也调服务端撤销', async () => {
    vi.mocked(lockApi.lock).mockResolvedValue(undefined)
    // 刷新后形态：内存无 token，会话只在 HttpOnly cookie
    const store = useLockStore()
    await store.lock()
    expect(lockApi.lock).toHaveBeenCalledTimes(1)
    expect(store.isLocked).toBe(true)
  })

  it('闲置超时触发 lock', async () => {
    vi.mocked(lockApi.getState).mockResolvedValue({
      ...ENABLED_STATE,
      autoLockEnabled: true,
      autoLockMinutes: 1,
    })
    vi.mocked(lockApi.getConfig).mockResolvedValue({ ...ENABLED_CONFIG, autoLockMinutes: 1 })
    vi.mocked(lockApi.unlock).mockResolvedValue({
      token: 'scl_x',
      expiresIn: 3600,
    })
    vi.mocked(lockApi.lock).mockResolvedValue(undefined)

    const store = useLockStore()
    await store.checkStatus()
    // checkStatus 路径已启动闲置计时，无需再 unlock
    expect(store.isLocked).toBe(false)

    // 快进 1 分钟 + 1 秒
    await vi.advanceTimersByTimeAsync(61 * 1000)

    expect(store.isLocked).toBe(true)
  })

  it('用户活动重置闲置计时', async () => {
    vi.mocked(lockApi.getState).mockResolvedValue({
      ...ENABLED_STATE,
      autoLockEnabled: true,
      autoLockMinutes: 1,
    })
    vi.mocked(lockApi.getConfig).mockResolvedValue({ ...ENABLED_CONFIG, autoLockMinutes: 1 })
    vi.mocked(lockApi.lock).mockResolvedValue(undefined)

    const store = useLockStore()
    await store.checkStatus()
    expect(store.isLocked).toBe(false)

    // 30 秒时触发用户活动——预期应重置计时
    await vi.advanceTimersByTimeAsync(30 * 1000)
    window.dispatchEvent(new Event('mousedown'))

    // 40 秒后（总耗时 70 秒）若未重置则应已锁定；重置则保持未锁
    await vi.advanceTimersByTimeAsync(40 * 1000)
    expect(store.isLocked).toBe(false)

    // 完整过完 1 分钟后才会真正锁定
    await vi.advanceTimersByTimeAsync(21 * 1000)
    expect(store.isLocked).toBe(true)
  })

  describe('syncAutoLockConfig（配置保存后的定时器对账，P-20261008-13）', () => {
    it('关闭 autoLock → 已武装的闲置定时器被取消（到点不再回锁）', async () => {
      vi.mocked(lockApi.getState).mockResolvedValue({
        ...ENABLED_STATE,
        autoLockEnabled: true,
        autoLockMinutes: 1,
      })
      vi.mocked(lockApi.getConfig).mockResolvedValue({ ...ENABLED_CONFIG, autoLockMinutes: 1 })
      vi.mocked(lockApi.lock).mockResolvedValue(undefined)

      const store = useLockStore()
      await store.checkStatus()
      expect(store.isLocked).toBe(false) // 定时器已武装（1 分钟）

      // 设置页关掉 autoLock 保存成功 → 对账必须取消定时器
      store.syncAutoLockConfig({ enabled: true, autoLockEnabled: false, autoLockMinutes: 120 })
      expect(store.state?.autoLockEnabled).toBe(false)

      // 快进原定到期点：无对账修复时此处已被回锁
      await vi.advanceTimersByTimeAsync(61 * 1000)
      expect(store.isLocked).toBe(false)
      expect(lockApi.lock).not.toHaveBeenCalled()
    })

    it('开启 autoLock（解锁态）→ 按新时长武装定时器', async () => {
      // 功能开 + autoLock 关的基线：checkStatus 不武装定时器
      vi.mocked(lockApi.getState).mockResolvedValue({
        ...ENABLED_STATE,
        autoLockEnabled: false,
        autoLockMinutes: 120,
      })
      vi.mocked(lockApi.getConfig).mockResolvedValue({ ...ENABLED_CONFIG, autoLockEnabled: false })
      vi.mocked(lockApi.lock).mockResolvedValue(undefined)

      const store = useLockStore()
      await store.checkStatus()
      expect(store.isLocked).toBe(false)

      store.syncAutoLockConfig({ enabled: true, autoLockEnabled: true, autoLockMinutes: 1 })
      expect(store.state?.autoLockEnabled).toBe(true)

      await vi.advanceTimersByTimeAsync(61 * 1000)
      expect(store.isLocked).toBe(true)
    })

    it('改时长 → 按新时长重排（旧到期点不触发）', async () => {
      vi.mocked(lockApi.getState).mockResolvedValue({
        ...ENABLED_STATE,
        autoLockEnabled: true,
        autoLockMinutes: 1,
      })
      vi.mocked(lockApi.getConfig).mockResolvedValue({ ...ENABLED_CONFIG, autoLockMinutes: 1 })
      vi.mocked(lockApi.lock).mockResolvedValue(undefined)

      const store = useLockStore()
      await store.checkStatus()

      // 1 分钟改为 5 分钟：旧到期点（61s）应保持解锁
      store.syncAutoLockConfig({ enabled: true, autoLockEnabled: true, autoLockMinutes: 5 })
      await vi.advanceTimersByTimeAsync(61 * 1000)
      expect(store.isLocked).toBe(false)

      // 新到期点（5 分钟）到点才回锁
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
      expect(store.isLocked).toBe(true)
    })

    it('功能关闭 → 取消定时器（与 checkStatus「关闭=永不锁定」不变量同构）', async () => {
      vi.mocked(lockApi.getState).mockResolvedValue({
        ...ENABLED_STATE,
        autoLockEnabled: true,
        autoLockMinutes: 1,
      })
      vi.mocked(lockApi.getConfig).mockResolvedValue({ ...ENABLED_CONFIG, autoLockMinutes: 1 })
      vi.mocked(lockApi.lock).mockResolvedValue(undefined)

      const store = useLockStore()
      await store.checkStatus()

      // 保存了 enabled=false + autoLockEnabled=true 的组合：功能关优先，不武装
      store.syncAutoLockConfig({ enabled: false, autoLockEnabled: true, autoLockMinutes: 1 })
      expect(store.state?.enabled).toBe(false)

      await vi.advanceTimersByTimeAsync(61 * 1000)
      expect(store.isLocked).toBe(false)
      expect(lockApi.lock).not.toHaveBeenCalled()
    })

    it('锁定态对账 → 只同步 state 镜像，不武装定时器', async () => {
      // 解锁探测失败（423）→ 锁定态，state 仍来自 getState
      vi.mocked(lockApi.getState).mockResolvedValue({ ...ENABLED_STATE })
      vi.mocked(lockApi.getConfig).mockRejectedValue(new Error('423'))

      const store = useLockStore()
      await store.checkStatus()
      expect(store.isLocked).toBe(true)

      store.syncAutoLockConfig({ enabled: true, autoLockEnabled: true, autoLockMinutes: 1 })
      expect(store.state?.autoLockEnabled).toBe(true)
      expect(store.state?.autoLockMinutes).toBe(1)

      // 越过假设的到期点：锁定态不武装定时器，也不触发 lock()
      await vi.advanceTimersByTimeAsync(61 * 1000)
      expect(store.isLocked).toBe(true)
      expect(lockApi.lock).not.toHaveBeenCalled()
    })
  })

  describe('lockShortcut 字段', () => {
    it('默认 ctrl+shift+l', () => {
      const store = useLockStore()
      expect(store.lockShortcut).toBe('ctrl+shift+l')
    })

    it('localStorage 已有值时读取持久化值', () => {
      localStorage.setItem('sc.lockShortcut', 'ctrl+alt+k')
      const store = useLockStore()
      expect(store.lockShortcut).toBe('ctrl+alt+k')
    })

    it('setLockShortcut 写入并持久化', () => {
      const store = useLockStore()
      store.setLockShortcut('meta+shift+l')
      expect(store.lockShortcut).toBe('meta+shift+l')
      expect(localStorage.getItem('sc.lockShortcut')).toBe('meta+shift+l')
    })

    it('setLockShortcut 空字符串 → 禁用快捷键并清 localStorage', () => {
      localStorage.setItem('sc.lockShortcut', 'ctrl+shift+l')
      const store = useLockStore()
      store.setLockShortcut('')
      expect(store.lockShortcut).toBe('')
      expect(localStorage.getItem('sc.lockShortcut')).toBeNull()
    })

    it('resetLockShortcut 恢复为默认 ctrl+shift+l', () => {
      localStorage.setItem('sc.lockShortcut', 'ctrl+alt+k')
      const store = useLockStore()
      store.resetLockShortcut()
      expect(store.lockShortcut).toBe('ctrl+shift+l')
      expect(localStorage.getItem('sc.lockShortcut')).toBe('ctrl+shift+l')
    })

    it('setLockShortcut 规范化大小写与空格', () => {
      const store = useLockStore()
      store.setLockShortcut('Ctrl + Shift + L')
      expect(store.lockShortcut).toBe('ctrl+shift+l')
      expect(localStorage.getItem('sc.lockShortcut')).toBe('ctrl+shift+l')
    })
  })

  describe('applyLockRejection（WS 4001 锁定拒绝统一处置）', () => {
    it('清内存 token + 清遗留副本 + 切锁定屏', () => {
      localStorage.setItem('sc.unlockToken', 'scl_stale_token')
      setUnlockToken('scl_stale_token')
      const store = useLockStore()
      store.unlockToken = 'scl_stale_token'
      store.isLocked = false

      applyLockRejection()

      expect(localStorage.getItem('sc.unlockToken')).toBeNull()
      expect(getUnlockToken()).toBeNull()
      expect(store.unlockToken).toBeNull()
      expect(store.isLocked).toBe(true)
    })

    it('关闭码常量为 4001（与服务端 WithWSLockAuth 约定一致）', () => {
      expect(LOCK_REJECTED_CLOSE_CODE).toBe(4001)
    })
  })
})
