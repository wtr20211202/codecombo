import { ref, watch } from 'vue'
import { applyLockRejection, getUnlockToken, LOCK_REJECTED_CLOSE_CODE, useLockStore } from '../stores/lock'
import { OPS_AGENT_GROUPS_CHANGED, OPS_NAVIGATE, OPS_NOTIFY, OPS_PANEL, OPS_PROJECTS_CHANGED, OPS_SETTINGS_CHANGED, OPS_TASK_PROGRESS } from '../utils/opsEvents'

/**
 * 智能操作通道客户端（AI Native 协议的前端侧）：
 * - 常驻订阅 /ws/ops-channel（App 层 init 一次，模块级单例）
 * - 后端 / 外部 Agent（claude/dsh 等，经 POST /api/ops-notify）发布的事件
 *   以 window CustomEvent 二次分发，各视图按需订阅：
 *     projects.changed → 首页项目列表自动刷新
 *     settings.changed → 主题/终端皮肤等实时跟随
 *     agent.groups.changed → 会话分组结构就地跟随（agent 分组操作面写端广播）
 *     navigate         → 前端路由跳转（外部 Agent 可驱动界面）
 *     notify           → 前端 toast
 * - 锁定态下服务端拒绝升级（无 token）：解锁 watch 立即重连；常态断线 5s 退避重连
 */

const connected = ref(false)
let started = false
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0

// 指数退避封顶：与 useWebSocketBase 同策略——常驻通道无限重试但封顶 30s，
// 服务端宕机期间不再固定 5s 风暴；onopen 归零 attempts，恢复后快速重试
const BASE_RECONNECT_DELAY = 5000
const MAX_RECONNECT_DELAY = 30000

function dispatch(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  // 锁定门控：锁定期间不调度空跑（解锁 watch 会立即补连）
  if (useLockStore().isLocked) return
  const delay = Math.min(BASE_RECONNECT_DELAY * 2 ** Math.max(0, reconnectAttempts - 1), MAX_RECONNECT_DELAY)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

// 恢复触发器：网络恢复 / 切回标签页时立即重连并重置退避
function handleRecovery(): void {
  if (connected.value || ws) return
  if (useLockStore().isLocked) return
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  connect()
}

function connect(): void {
  const lockStore = useLockStore()
  // 锁定态下服务端拒绝升级（无 token）：不发起连接，解锁 watch 会立即补连
  if (lockStore.isLocked) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  const token = getUnlockToken() || ''
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${location.host}/ws/ops-channel`
  // 内存令牌缺省（刷新后会话在 HttpOnly cookie）时握手不带子协议，
  // 由浏览器自动携带的同源 cookie 兜底（P-20261019-2）
  ws = token ? new WebSocket(url, [token]) : new WebSocket(url)

  ws.onopen = () => { connected.value = true; reconnectAttempts = 0 }
  ws.onmessage = (msg) => {
    try {
      const ev = JSON.parse(String(msg.data)) as { type?: string; payload?: Record<string, unknown> }
      if (!ev.type || ev.type === 'hello') return
      switch (ev.type) {
        case 'projects.changed': dispatch(OPS_PROJECTS_CHANGED, ev.payload); break
        case 'settings.changed': dispatch(OPS_SETTINGS_CHANGED, ev.payload); break
        // agent.groups.changed（P-20261111-1-S3）：服务端分组操作面写 uiState 后
        // 广播——映射到既有窗口事件（前端内部事件早于服务端事件存在，window 名
        // 是连字符旧形态非直通恒等），消费方收事件即拉全量
        case 'agent.groups.changed': dispatch(OPS_AGENT_GROUPS_CHANGED, ev.payload); break
        case 'navigate': dispatch(OPS_NAVIGATE, ev.payload); break
        case 'notify': dispatch(OPS_NOTIFY, ev.payload); break
        case 'task.progress': dispatch(OPS_TASK_PROGRESS, ev.payload); break
        case 'panel': dispatch(OPS_PANEL, ev.payload); break
        default: dispatch(`sc-ops:${ev.type}`, ev.payload)
      }
    } catch { /* 非 JSON 消息忽略 */ }
  }
  ws.onclose = (ev) => {
    connected.value = false
    // 释放死连接引用：handleRecovery 的 ws 守卫据此放行，
    // 否则断线后 ws 仍指向 CLOSED socket，online/visible 恢复触发永远失效
    ws = null
    // 锁定拒绝（close 4001）：token 已失效，统一切锁定屏（解锁 watch 会重连）；
    // 其余关闭原因按指数退避重连（5s 起步封顶 30s）
    if (ev.code === LOCK_REJECTED_CLOSE_CODE) {
      applyLockRejection()
      return
    }
    reconnectAttempts++
    scheduleReconnect()
  }
  ws.onerror = () => { ws?.close() }
}

/** 启动通道（幂等）：App 挂载时调用一次 */
export function initOpsChannel(): void {
  if (started) return
  started = true
  window.addEventListener('online', handleRecovery)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handleRecovery()
  })
  const lockStore = useLockStore()
  watch(() => lockStore.isLocked, (locked) => {
    if (locked) {
      // 锁定：token 已撤销，主动断开并停止重连
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      ws?.close()
      ws = null
    } else {
      // 解锁：立即补连
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      connect()
    }
  })
  connect()
}

export function useOpsChannelState() {
  return { connected }
}
