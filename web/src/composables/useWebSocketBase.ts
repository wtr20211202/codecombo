import { ref, onUnmounted } from 'vue'
import { applyLockRejection, LOCK_REJECTED_CLOSE_CODE } from '../stores/lock'

// RFC 6455 标准关闭码中对客户端有「重连策略」含义的两个（服务端 P-20261003-313
// SetReadLimit 读上限防线超限时 gorilla 自动回 1009，见 server/api/shared/ws.go）。
// 与 4001（应用保留段锁定拒绝，stores/lock）不同，这两个是协议标准码，定义在本
// 模块供 useTerminalSession 等自管 WS 循环的 onclose 同判复用
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009
export const WS_CLOSE_INTERNAL_ERROR = 1011
// 1009/1011 的长退避间隔：不进常规指数退避（3s→30s），给服务端/用户操作留出
// 冷却窗口；仍保留重连（常驻通道无限恢复语义），只把节奏从「风暴」降到「分钟级」
export const WS_LONG_BACKOFF_DELAY_MS = 60000

// 1009/1011 长退避的用户提示回调（P-20261005-185）：通知中心 store 初始化时经
// registerWsLongBackoffNotifier 注册（reconnectRefetch 集中注册表同款解耦——base
// 不反向依赖 store，notification.ts 静态依赖本模块，反向 import 连动态形式都会被
// import-x/no-cycle 判环）。未注册（store 尚未初始化的启动极窄窗）静默跳过，
// 长退避重连调度不受影响
type WsLongBackoffNotifier = (code: number) => void
let longBackoffNotifier: WsLongBackoffNotifier | null = null
export function registerWsLongBackoffNotifier(fn: WsLongBackoffNotifier | null): void {
  longBackoffNotifier = fn
}

export interface UseWebSocketBaseOptions {
  /** 返回 WebSocket URL，返回空字符串则跳过连接 */
  getUrl: () => string
  /** 返回 Sec-WebSocket-Protocol 子协议数组（如 unlock token），返回 undefined 表示不带 */
  getProtocols?: () => string[] | undefined
  /** 消息回调 */
  onMessage: (event: MessageEvent) => void
  /** 连接成功回调，attempts 为本次重连前的尝试次数（0 表示首次连接） */
  onOpen?: (attempts: number) => void
  /** 连接关闭回调，attempts 为当前重试次数 */
  onClose?: (attempts: number) => void
  /** 连接错误回调 */
  onError?: () => void
  /** 重连延迟（毫秒），默认 3000 */
  reconnectDelay?: number
  /** 组件卸载时自动断开，默认 true */
  autoCleanup?: boolean
  /**
   * 是否允许连接/重连的门控函数，返回 false 时跳过 connect 且不调度重连。
   * 用于阻止锁定状态下因 WS 握手被中间件拒绝而陷入 onclose→重连→握手拒绝→onclose 死循环。
   * 默认 () => true。
   */
  shouldConnect?: () => boolean
}

/**
 * WebSocket 连接基础 composable：封装 connect/disconnect/reconnect 通用逻辑。
 * 用于 useWebSocket（项目 WS）和 notification store（全局通知 WS）。
 */
export function useWebSocketBase(options: UseWebSocketBaseOptions) {
  const connected = ref(false)
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0

  // shouldConnect 默认放行；返回 false 时 connect/scheduleReconnect 会跳过
  const shouldConnect = () => options.shouldConnect?.() ?? true

  // 指数退避重连：常驻通道（项目 WS / 通知 WS）必须无限重试（硬性次数上限会让
  // 后端长时间重启后功能永远无法自动恢复），但固定短间隔会在服务端宕机期间形成
  // 握手风暴。delay = base × 2^(n-1) 封顶 30s；连接成功后 attempts 归零，
  // 下次断线从 base 快速重试
  const MAX_RECONNECT_DELAY = 30000

  function nextRetryDelay() {
    const base = options.reconnectDelay ?? 3000
    const exp = base * 2 ** Math.max(0, reconnectAttempts - 1)
    return Math.min(exp, MAX_RECONNECT_DELAY)
  }

  function scheduleReconnect(fixedDelayMs?: number) {
    if (reconnectTimer) return
    // 门控检查：锁定状态下不调度重连（解锁后由外部 watch 触发 connect）
    if (!shouldConnect()) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, fixedDelayMs ?? nextRetryDelay())
  }

  // 恢复触发器：网络恢复 / 用户切回标签页时立即重连并重置退避——
  // 否则 30s 封顶退避会让服务端恢复后的首连最长多等 30s
  function handleRecovery() {
    if (connected.value || ws) return
    if (!shouldConnect()) return
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectAttempts = 0
    connect()
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') handleRecovery()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleRecovery)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  function connect() {
    // 门控检查：锁定状态下直接跳过，避免尝试连接被中间件拒绝
    if (!shouldConnect()) return
    const url = options.getUrl()
    if (!url) return

    // 避免重复连接同一个 URL
    if (ws && ws.url === url && ws.readyState === WebSocket.OPEN) return

    disconnect()

    // 子协议携带 unlock token（锁定中间件在握手期校验）
    const protocols = options.getProtocols?.()
    ws = protocols && protocols.length > 0 ? new WebSocket(url, protocols) : new WebSocket(url)

    ws.onopen = () => {
      connected.value = true
      options.onOpen?.(reconnectAttempts)
      reconnectAttempts = 0
    }

    ws.onclose = (event) => {
      connected.value = false
      ws = null
      // 服务端锁定拒绝（close 4001）：token 已失效，继续用同一 token 重连
      // 必然无限失败。统一切锁定屏（与 HTTP 423 拦截器同语义），解锁后由
      // 外部 isLocked watch 自动重连——用户重新输入密码即恢复，无需刷新页面
      if (event.code === LOCK_REJECTED_CLOSE_CODE) {
        applyLockRejection()
        return
      }
      // 消息超限（1009，P-313 服务端读上限防线的客户端对位）/ 服务端异常关闭
      // （1011）：不进常规指数退避——1009 是「我方发送内容超限」的确定性信号，
      // 短退避重连会形成 重连→补拉/重发→再 1009 的循环放大；1011 同属非瞬态
      // 服务端侧故障。两者固定长退避 + 显式 error 条目（回调由通知中心 store
      // 注册；终端通道在 useTerminalSession 同判写原因行）。与 4001 特判同结构：
      // 不调 onClose、不增 reconnectAttempts（消费方的断线计数语义由显式提示
      // 替代；onOpen 成功后 attempts 归零不变）
      if (event.code === WS_CLOSE_MESSAGE_TOO_BIG || event.code === WS_CLOSE_INTERNAL_ERROR) {
        longBackoffNotifier?.(event.code)
        scheduleReconnect(WS_LONG_BACKOFF_DELAY_MS)
        return
      }
      reconnectAttempts++
      options.onClose?.(reconnectAttempts)
      scheduleReconnect()
    }

    ws.onerror = () => {
      options.onError?.()
    }

    ws.onmessage = options.onMessage
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.onclose = null // 防止触发重连
      ws.close()
      ws = null
    }
    connected.value = false
    reconnectAttempts = 0
  }

  if (options.autoCleanup !== false) {
    onUnmounted(() => {
      disconnect()
      window.removeEventListener('online', handleRecovery)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    })
  }

  return { connected, connect, disconnect }
}
