import { defineStore } from 'pinia'
import { ref } from 'vue'
import { lockApi, type LockState } from '@/api/lock'
import { safeStorage } from '@/utils/storage'
import { buildClearLockCookie } from '@/utils/lockCookie'

// localStorage key：P-20261019-2 起不再是令牌载体（令牌改服务端下发的
// HttpOnly cookie，localStorage 可读副本停写）。保留常量用于两处遗留清扫：
// 启动期清掉旧版本前端写入的令牌副本（收口同主机任意端口 JS 的读取面）、
// 锁定/拒绝路径再兜底清除一次。全局共享：所有需要引用该键的模块都必须
// import 此常量，避免字面量散落导致漂移
export const UNLOCK_TOKEN_KEY = 'sc.unlockToken'

// 解锁令牌的进程内存态（P-20261019-2）：与 cookie 载体并存。
//   - 内存 token（本 tab 解锁/设密签发）：WS 子协议与 X-Lock-Token 头的直接
//     载体——不依赖服务端 cookie 也能过锁（旧服务端兼容形态）；
//   - 刷新后内存清空：同源请求（HTTP/WS 握手）由浏览器自动携带 HttpOnly
//     cookie，服务端锁校验按「头 > 子协议 > cookie」回退，无感续会话。
// 模块级变量 + setter：消费面（api/http、五个 WS 通道、instanceFetch、
// deploy/notification/terminal）在 pinia 未激活的极窄启动窗也可能读取
//（与 http.ts setInstanceContext 同款模块级注入模式），不经 store ref
let memoryUnlockToken: string | null = null

/** 读当前解锁令牌（内存态；刷新后为 null，由 cookie 载体兜底） */
export function getUnlockToken(): string | null {
  return memoryUnlockToken
}

/** 写内存令牌：锁 store 的 unlock/setup/lock 与 applyLockRejection 调用；单测注入同此口 */
export function setUnlockToken(token: string | null): void {
  memoryUnlockToken = token
}

// 遗留清扫（P-20261019-2 兼容过渡）：清掉旧版本前端落 localStorage 的令牌
// 副本与 document.cookie 写入的非 HttpOnly cookie。HttpOnly cookie 由服务端
// Set-Cookie 签发/清除，document.cookie 对它读写皆无效——本清除只影响
// 过渡期内残留的旧形态副本，新 cookie 不受影响（浏览器忽略同名覆盖）
function sweepLegacyTokenCopies(): void {
  safeStorage.removeItem(UNLOCK_TOKEN_KEY)
  try {
    document.cookie = buildClearLockCookie(window.location.protocol === 'https:')
  } catch {
    /* 隐私模式等 document.cookie 不可写：清扫尽力而为 */
  }
}

// 服务端锁定拒绝的应用约定 WS 关闭码（4000-4999 为 RFC 6455 应用保留段）。
// 浏览器读不到 WS 握手的 HTTP 423（onclose 一律 1006，与网络故障不可区分），
// 服务端改为升级后以本关闭码关闭，前端据此确定性识别「token 已失效」
export const LOCK_REJECTED_CLOSE_CODE = 4001

// WS 通道识别到锁定拒绝（close 4001）时的统一处置，
// 与 api/http.ts handleLockedResponse 的真锁定分支同语义：
// 清内存/遗留令牌副本 + 切锁定屏；解锁后由各通道的 isLocked watch 自动重连
//（HttpOnly cookie 的清除在服务端 423 响应侧完成）
export function applyLockRejection(): void {
  setUnlockToken(null)
  sweepLegacyTokenCopies()
  try {
    const lockStore = useLockStore()
    lockStore.isLocked = true
    lockStore.unlockToken = null
  } catch {
    console.warn('[lock] pinia not active, will recheck on mount')
  }
}
// localStorage key：保存用户自定义的锁定快捷键 combo 字符串
const SHORTCUT_KEY = 'sc.lockShortcut'
// 默认锁定快捷键：Win/Linux 为 Ctrl+Shift+L（避开 Ctrl+L 浏览器地址栏
// 冲突）；macOS 用 Cmd+Shift+L（左手 Ctrl 在 mac 键盘上不可发现，
// matchShortcut 对 ctrl/meta 精确匹配，默认值必须与平台修饰键一致）
const DEFAULT_LOCK_SHORTCUT
  = navigator.platform.toLowerCase().includes('mac') ? 'meta+shift+l' : 'ctrl+shift+l'

// 用户活动事件：监听这些以重置闲置计时
const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  'mousedown', 'keydown', 'scroll', 'touchstart',
]

// 默认闲置时长（分钟），后端尚未返回时兜底
const DEFAULT_AUTO_LOCK_MINUTES = 120

export const useLockStore = defineStore('lock', () => {
  // 是否处于锁定状态：默认 true，启动后由 checkStatus 探测真实状态
  const isLocked = ref(true)
  // 启动是否完成首次状态探测：true 之前 App.vue 显示 boot loading 遮罩，避免刷新时闪现锁定页
  const isReady = ref(false)
  // 当前 unlock token（内存态；同步 memoryUnlockToken 供非 store 消费面读取。
  // 持久载体是服务端下发的 HttpOnly cookie——刷新后本 ref 为 null，会话由
  // cookie 延续，见 checkStatus 的 cookie 探测）
  const unlockToken = ref<string | null>(memoryUnlockToken)
  // 最近一次后端返回的 state
  const state = ref<LockState | null>(null)
  // 是否使用默认密码（提示用户修改）
  const isDefaultPassword = ref(false)
  // 后端从未初始化配置（首次安装/reset-lock 后）：锁屏走设密流程
  const needsSetup = ref(false)
  // 用户配置的锁定快捷键 combo：空字符串表示禁用
  // 持久化到 localStorage，未设置时使用默认 Ctrl+Shift+L
  const lockShortcut = ref<string>(
    safeStorage.getItem(SHORTCUT_KEY) ?? DEFAULT_LOCK_SHORTCUT,
  )

  let idleTimer: number | null = null
  let activityBound = false

  // 启动应用时调用：探测后端是否启用锁定 + 当前 token 是否有效
  // 无论成功还是异常，try/finally 保证 isReady=true，避免启动遮罩永远卡死
  async function checkStatus() {
    // 遗留清扫：旧版本前端落的 localStorage 令牌副本一经启动即清
    //（P-20261019-2 读取面收口；cookie 载体不在清扫范围——它是本会话凭证）
    sweepLegacyTokenCopies()
    try {
      const s = await lockApi.getState()
      state.value = s
      isDefaultPassword.value = s.isDefaultPassword
      needsSetup.value = !!s.needsSetup

      // 首次安装/被 reset-lock：无论 enabled 与否，先走设密流程
      if (s.needsSetup) {
        isLocked.value = true
        return
      }

      // 功能关闭：永远不锁定
      if (!s.enabled) {
        isLocked.value = false
        return
      }

      // 功能开：探测 token 是否仍然有效。内存有 token（本 tab 刚解锁）与
      // 内存无 token（刷新后会话在 HttpOnly cookie 里）走同一探测——cookie
      // 由浏览器对同源请求自动携带，探测通过即会话有效；423 则真锁定
      try {
        await lockApi.getConfig()
        isLocked.value = false
        if (s.autoLockEnabled) {
          startIdleTimer()
        }
      } catch {
        // 423 已被 axios 拦截器处理（清内存令牌 + 切锁定），此处兜底
        unlockToken.value = null
        setUnlockToken(null)
        isLocked.value = true
      }
    } finally {
      // 首次探测结束：关闭 App.vue 的 boot loading 遮罩
      isReady.value = true
    }
  }

  // 用户输入密码解锁。令牌落内存 + 服务端 Set-Cookie（HttpOnly）——
  // 不再写 localStorage / 可读 cookie（P-20261019-2）
  async function unlock(password: string) {
    const { token } = await lockApi.unlock(password)
    unlockToken.value = token
    setUnlockToken(token)
    isLocked.value = false
    if (state.value?.autoLockEnabled) {
      startIdleTimer()
    }
  }

  // 首次设置密码：后端写入配置并直接签发 token，重新探测刷新 state
  async function setup(password: string) {
    const { token } = await lockApi.setup(password)
    unlockToken.value = token
    setUnlockToken(token)
    needsSetup.value = false
    isLocked.value = false
    // 重新探测：enabled / autoLock 等取配置写入后的真实值
    await checkStatus()
  }

  // 主动锁定或被超时锁定：服务端撤销 token（并过期 HttpOnly cookie），
  // 前端清理内存态与遗留副本。无条件调 API：刷新后的会话只在 HttpOnly
  // cookie 里（内存读不到也无从判断），能否撤销由服务端按请求所带载体定；
  // 无任何凭证时 423 由下方 catch 静默吞掉（清本地态兜底不变）
  async function lock() {
    try {
      await lockApi.lock()
    } catch {
      // 静默：服务端可能已经撤销了（如 RevokeAllTokens 后），仍清前端状态
      console.warn('[lock] lock API failed, clearing local token anyway')
    }
    unlockToken.value = null
    setUnlockToken(null)
    sweepLegacyTokenCopies()
    isLocked.value = true
    stopIdleTimer()
  }

  // 启动闲置计时器：超时自动 lock
  function startIdleTimer() {
    stopIdleTimer()
    const minutes = state.value?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES
    const ms = minutes * 60 * 1000
    idleTimer = window.setTimeout(() => {
      void lock()
    }, ms)

    if (!activityBound) {
      ACTIVITY_EVENTS.forEach(evt =>
        window.addEventListener(evt, resetIdleTimer, { passive: true }),
      )
      activityBound = true
    }
  }

  // 用户活动时重置计时：避免使用中误锁
  function resetIdleTimer() {
    if (idleTimer !== null && !isLocked.value) {
      clearTimeout(idleTimer)
      const minutes = state.value?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES
      const ms = minutes * 60 * 1000
      idleTimer = window.setTimeout(() => {
        void lock()
      }, ms)
    }
  }

  // 停止闲置计时：锁定 / 解锁失败 / 卸载时
  function stopIdleTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (activityBound) {
      ACTIVITY_EVENTS.forEach(evt =>
        window.removeEventListener(evt, resetIdleTimer),
      )
      activityBound = false
    }
  }

  // 配置保存后的定时器对账（P-20261008-13 走查结论的根因侧修复）：
  // autoLock 计时器只由本 store 持有，服务端无对应定时器（GET /lock/state 的
  // autoLock 字段是纯数据面）——配置更新若不对账本定时器，「设置页关掉
  // autoLock 保存成功，已武装的定时器仍在 N 分钟后把人锁出去」。
  // 对账语义与 checkStatus 的武装条件同构：功能关闭或 autoLock 关闭即取消
  // （功能关闭下回锁会先于重探测把人切到锁定屏，与「关闭=永不锁定」矛盾）；
  // 两者都开且当前解锁态则按新时长重排（startIdleTimer 内部先停旧定时器）；
  // 锁定态本就无在场定时器，只同步 state 镜像供下次解锁取值。
  // 调用点：设置页保存配置成功后（useSecurityLock.saveConfig）；e2e 种子/CLI
  // 的 API 直写路径无页面定时器在场，无需对账
  function syncAutoLockConfig(cfg: { enabled: boolean; autoLockEnabled: boolean; autoLockMinutes: number }) {
    if (state.value) {
      state.value.enabled = cfg.enabled
      state.value.autoLockEnabled = cfg.autoLockEnabled
      state.value.autoLockMinutes = cfg.autoLockMinutes
    }
    if (!cfg.enabled || !cfg.autoLockEnabled) {
      stopIdleTimer()
      return
    }
    if (!isLocked.value) {
      startIdleTimer()
    }
  }

  // 重新绑定锁定快捷键：空字符串表示禁用快捷键；持久化到 localStorage
  // 规范化：去空格、统一小写，保证 matchShortcut 比对一致
  function setLockShortcut(combo: string) {
    const normalized = (combo || '')
      .toLowerCase()
      .split('+')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .join('+')
    lockShortcut.value = normalized
    if (normalized) {
      safeStorage.setItem(SHORTCUT_KEY, normalized)
    } else {
      safeStorage.removeItem(SHORTCUT_KEY)
    }
  }

  // 重置为默认快捷键 Ctrl+Shift+L
  function resetLockShortcut() {
    setLockShortcut(DEFAULT_LOCK_SHORTCUT)
  }

  return {
    isLocked,
    isReady,
    unlockToken,
    state,
    isDefaultPassword,
    needsSetup,
    lockShortcut,
    checkStatus,
    unlock,
    setup,
    lock,
    setLockShortcut,
    resetLockShortcut,
    syncAutoLockConfig,
  }
})
