import { ref, onUnmounted } from 'vue'
import { cloneApi } from '../api/client'
import { connectCloneWS, CLONE_WS_MAX_RETRIES, CLONE_WS_RETRY_DELAY } from './useCloneWebSocket'
import { applyLockRejection, LOCK_REJECTED_CLOSE_CODE } from '../stores/lock'
import { useCloneTracker } from './useCloneTracker'
import i18n from '@/i18n'

export interface CloneResult {
  projectId?: string
  projectName?: string
  path?: string
  error?: string
}

export type CloneStatus = 'idle' | 'running' | 'success' | 'failed' | 'canceled'

export interface CloneStartPayload {
  url: string
  dir: string
  branch?: string
  depth?: number
  name?: string
  sshKeyId?: string
}

/**
 * 克隆进度 composable：管理异步克隆任务的启动、WS 进度接收、取消。
 * 调用 startClone 后，status/lines/progress/result 会随 WS 消息实时更新。
 */
export function useCloneProgress() {
  const taskId = ref<string>('')
  const status = ref<CloneStatus>('idle')
  const lines = ref<string[]>([])
  const progress = ref(0) // 0-100，从进度行解析
  const result = ref<CloneResult | null>(null)
  let ws: WebSocket | null = null
  let onDone: ((s: CloneStatus, r: CloneResult | null) => void) | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempts = 0

  function connect(id: string, cb?: (s: CloneStatus, r: CloneResult | null) => void) {
    disconnect()
    onDone = cb || null
    taskId.value = id
    status.value = 'running'
    lines.value = []
    progress.value = 0
    result.value = null
    retryAttempts = 0
    attach(id)
  }

  // attach 连接进度 WS；断线时自动重连。服务端支持快照补发：
  // 重连后先重放已缓冲进度再收实时流，任务已结束时直接收到 done
  function attach(id: string) {
    ws = connectCloneWS(id, {
      onProgress: (line, percent) => {
        lines.value.push(line)
        if (lines.value.length > 100) {
          lines.value.splice(0, lines.value.length - 100)
        }
        if (percent !== null) progress.value = percent
      },
      onDone: (s, r) => {
        result.value = r
        status.value = s
        if (s === 'success') progress.value = 100
        if (onDone) onDone(s, r)
        disconnect()
      },
      // 连接错误：等 onclose 统一处理（异常后必有 close）
    })
    ws.onclose = (ev) => {
      // 已结束/已重置：disconnect 清掉了 onclose，此处只在 running 态触达
      if (status.value !== 'running') return
      if (ev.code === LOCK_REJECTED_CLOSE_CODE) {
        // 锁定拒绝：统一切锁定屏；任务仍在服务端运行，解锁后重新打开进度可续看
        applyLockRejection()
        status.value = 'failed'
        result.value = { error: i18n.global.t('errors.lockedWs') }
        return
      }
      if (++retryAttempts > CLONE_WS_MAX_RETRIES) {
        // 重试耗尽（典型：服务端重启丢任务）：明确失败，不再无限转圈
        status.value = 'failed'
        result.value = { error: i18n.global.t('errors.cloneProgressLost') }
        return
      }
      // 服务端会补发全量快照：清空本地已收行，避免重放重复
      lines.value = []
      progress.value = 0
      retryTimer = setTimeout(() => attach(id), CLONE_WS_RETRY_DELAY)
    }
  }

  function disconnect() {
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
  }

  async function startClone(payload: CloneStartPayload, onDoneCallback?: (s: CloneStatus, r: CloneResult | null) => void, config?: { errorLabel?: string; silent?: boolean }): Promise<string> {
    const res = await cloneApi.start(payload, config)
    // 注意：响应拦截器已解包 response.data，res 直接就是 {taskId}，无需 .data
    const id = (res as any)?.taskId
    if (id) {
      // 常驻跟踪（P-20261003-58）：启动即登记全局指示条（tracker 持独立 WS，
      // 弹窗关闭/组件卸载不中断）；本实例完成回调在场时 settleLocal 摘条目、
      // 提示仍归回调——两条 WS 同收 done，恰好一次移除
      const tracker = useCloneTracker()
      tracker.track(id, payload)
      connect(id, (s, r) => {
        tracker.settleLocal(id)
        onDoneCallback?.(s, r)
      })
    }
    return id
  }

  async function cancelClone() {
    if (!taskId.value) return
    try {
      await cloneApi.cancel(taskId.value)
    } catch {
      // ignore
    }
  }

  // 运行中放弃跟进（运行中被 reset / 组件卸载，如重开添加弹窗、路由切换）：
  // 任务仍在服务端跑，转孤儿由 tracker 保留条目并兜底完成提示
  function orphanIfRunning() {
    if (status.value === 'running' && taskId.value) useCloneTracker().orphan(taskId.value)
  }

  function reset() {
    orphanIfRunning()
    disconnect()
    taskId.value = ''
    status.value = 'idle'
    lines.value = []
    progress.value = 0
    result.value = null
  }

  onUnmounted(() => {
    orphanIfRunning()
    disconnect()
  })

  return {
    taskId,
    status,
    lines,
    progress,
    result,
    connect,
    startClone,
    cancelClone,
    reset,
  }
}
