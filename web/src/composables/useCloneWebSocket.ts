import type { CloneResult, CloneStatus } from './useCloneProgress'
import { applyLockRejection, getUnlockToken, LOCK_REJECTED_CLOSE_CODE } from '@/stores/lock'
import i18n from '@/i18n'

/**
 * 克隆进度 WS 的统一入口：所有调用方（useCloneProgress / CloneModal / useProjectActions）
 * 都必须经此 helper 连接，确保握手期携带 unlock token，否则后端 LockMiddleware 会返 423
 * 让前端永远卡在 loading（业务侧表现为「锁定状态下 clone 永不结束」）
 */

// 断线重连策略：服务端 CloneProgressWS 支持快照补发（先重放已缓冲进度，
// 再收实时流；任务已结束时立即收到 done），断线重连可无损恢复进度显示。
// 重试耗尽按错误收尾——典型对应服务端重启（任务在内存中，重启即消失）
export const CLONE_WS_MAX_RETRIES = 10
export const CLONE_WS_RETRY_DELAY = 2000

export function parseCloneProgress(line: string): number | null {
  const m = line.match(/(\d+)%/)
  return m?.[1] ? parseInt(m[1], 10) : null
}

export function getCloneWSUrl(taskId: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws/clone/${taskId}`
}

// token 缺失时返回 undefined：内存令牌（P-20261019-2 起的载体之一）缺省时
// 握手不带子协议，由浏览器自动携带的 HttpOnly cookie 兜底；系统启用锁定且
// 两者皆无时，握手会被后端 LockMiddleware 423（升级后 4001 关闭）拒绝
export function getCloneWSProtocols(): string[] | undefined {
  const token = getUnlockToken()
  return token ? [token] : undefined
}

export interface CloneWSHandlers {
  onProgress?: (line: string, percent: number | null) => void
  onDone?: (status: CloneStatus, result: CloneResult | null) => void
  onError?: () => void
}

/**
 * 连接克隆进度 WS（低层 API，供 useCloneProgress 这类需要流式 progress 回调的场景使用）
 *
 * 返回 WebSocket 实例，调用方负责在不再需要时 close()
 * 内部已绑定 onmessage / onerror，解析 { type: 'progress' | 'done' } 消息后回调
 */
export function connectCloneWS(taskId: string, handlers: CloneWSHandlers = {}): WebSocket {
  const url = getCloneWSUrl(taskId)
  const protocols = getCloneWSProtocols()
  const ws = protocols && protocols.length > 0 ? new WebSocket(url, protocols) : new WebSocket(url)

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'progress') {
        const line = msg.line as string
        handlers.onProgress?.(line, parseCloneProgress(line))
      } else if (msg.type === 'done') {
        const status = msg.status as CloneStatus
        const result = msg.result as CloneResult | null
        handlers.onDone?.(status, result)
      }
    } catch {
      // 解析失败的消息直接丢弃，不影响后续合法消息处理
    }
  }
  ws.onerror = () => {
    handlers.onError?.()
  }
  return ws
}

/**
 * 等待克隆任务结束（高层 API，供 CloneModal / useProjectActions 这种只需「跑完知道成败」的场景使用）
 *
 * - 成功 → resolve()
 * - 失败/取消 → reject(Error)，error.message 优先取 result.error，其次 status
 * - 锁定拒绝（close 4001）→ 清 token 切锁定屏 + reject 明确的锁定错误
 * - 断线 → 自动重连补发快照（上限 CLONE_WS_MAX_RETRIES），耗尽后 reject
 */
export function waitForCloneDone(taskId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let attempts = 0
    let ws: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (ws) {
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
        ws = null
      }
      settle()
    }

    const connectOnce = () => {
      try {
        ws = connectCloneWS(taskId, {
          onDone: (status, result) => {
            if (status === 'success') finish(resolve)
            else finish(() => reject(new Error(result?.error || status)))
          },
          // onerror 不在此收尾：连接异常后必有 onclose，统一在 onclose 处理
        })
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))))
        return
      }

      ws.onclose = (ev) => {
        if (settled) return
        // 锁定拒绝：token 失效，切锁定屏并明确报错（任务仍在服务端运行，
        // 解锁后重新打开进度即可看到补发快照）
        if (ev.code === LOCK_REJECTED_CLOSE_CODE) {
          applyLockRejection()
          finish(() => reject(new Error(i18n.global.t('errors.lockedWs'))))
          return
        }
        // 普通断线：自动重连，服务端补发快照后继续实时流
        if (++attempts <= CLONE_WS_MAX_RETRIES) {
          retryTimer = setTimeout(connectOnce, CLONE_WS_RETRY_DELAY)
          return
        }
        finish(() => reject(new Error('websocket closed')))
      }
    }
    connectOnce()
  })
}
