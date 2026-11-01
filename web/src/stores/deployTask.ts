import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { deployApi, type DeployTask, type DeployerInstance } from '../api/client'
import { getUnlockToken } from './lock'

export interface DeployLogEntry {
  time: string
  deployer: string
  step: string
  level: 'info' | 'ok' | 'warn' | 'fail'
  message: string
  messageKey?: string
  messageParams?: Record<string, string | number>
}

interface WSLogPayload {
  time: string
  deployer: string
  step: string
  level: DeployLogEntry['level']
  message: string
  messageKey?: string
  messageParams?: Record<string, string | number>
}

interface WSDonePayload {
  status: DeployTask['status']
  error?: string
}

const MAX_LOGS = 1000

// 从 "[i/total] starting xxx" 消息中解析 i 和 total
const PROGRESS_RE = /^\[(\d+)\/(\d+)\]/

export const useDeployTaskStore = defineStore('deployTask', () => {
  const currentTask = ref<DeployTask | null>(null)
  const logs = ref<DeployLogEntry[]>([])
  const publicKeys = ref<Array<{ keyName: string; publicKey: string }>>([])
  const wsConnection = ref<WebSocket | null>(null)
  const connected = ref(false)
  // 真实进度：从后端 "[i/total] starting xxx" 日志解析
  // 不能用 currentTask.instances.length，因为后端会补齐依赖，resolved 总数可能更大
  const progressIndex = ref(0)
  const progressTotal = ref(0)

  const finished = computed(() => {
    const s = currentTask.value?.status
    return s === 'completed' || s === 'failed' || s === 'cancelled'
  })

  // 任务级 WS 断线重连：服务端 Subscribe 会回放最近 200 条日志，重连安全。
  // 有限次数（5 次，指数退避 2s→15s）——部署任务有时限，无限重连无意义；
  // 超限后进度面板保持已有内容，任务结束态由通知中心兜底
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  let wsReconnectAttempts = 0
  const MAX_WS_RECONNECTS = 5

  function scheduleWsReconnect(taskId: string) {
    if (wsReconnectTimer) return
    if (finished.value) return
    if (wsReconnectAttempts >= MAX_WS_RECONNECTS) return
    const delay = Math.min(2000 * 2 ** wsReconnectAttempts, 15000)
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null
      if (currentTask.value?.id === taskId && !finished.value) {
        wsReconnectAttempts++
        // 重连后服务端回放最近 200 条日志：清空本地避免重复展示
        logs.value = []
        publicKeys.value = []
        connect(taskId)
      }
    }, delay)
  }

  function clearWsReconnect() {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer)
      wsReconnectTimer = null
    }
  }

  async function trigger(hostId: string, instances: DeployerInstance[], noWait = false) {
    reset()
    const res = (await deployApi.trigger({ hostId, instances, noWait })) as unknown as { taskId: string }
    currentTask.value = {
      id: res.taskId,
      hostId,
      host: '',
      instances,
      status: 'queued',
      currentIndex: 0,
      currentStep: '',
    }
    progressIndex.value = 0
    progressTotal.value = instances.length
    connect(res.taskId)
    // 同主机排队（P-20261004-36）：waitingFor/queuePosition 只在任务详情里，
    // 触发后补拉一次让「排队中（等 #任务）」立即可见。失败静默（WS 日志与终态
    // 通知兜底）；回填不让旧详情回退 WS 已推进的本地状态
    try {
      const detail = await loadTask(res.taskId)
      const cur = currentTask.value
      if (detail && cur && cur.id === res.taskId) {
        const status = detail.status === 'queued' && cur.status !== 'queued' ? cur.status : detail.status
        currentTask.value = { ...cur, ...detail, status }
      }
    } catch { /* 静默 */ }
    return res.taskId
  }

  function connect(taskId: string) {
    clearWsReconnect()
    if (wsConnection.value) {
      const old = wsConnection.value
      wsConnection.value = null
      old.close()
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // 内存令牌缺省（刷新后会话在 HttpOnly cookie）时握手不带子协议，
    // 由浏览器自动携带的同源 cookie 兜底（P-20261019-2）
    const unlockToken = getUnlockToken() || ''
    const url = `${proto}//${location.host}/ws/deploy/${taskId}`
    const ws = new WebSocket(url, unlockToken ? [unlockToken] : undefined)
    wsConnection.value = ws

    ws.onopen = () => { connected.value = true; wsReconnectAttempts = 0 }
    ws.onclose = () => {
      connected.value = false
      // 孤儿 socket 守卫：被 done/reset/重连替换的旧连接不触发重连
      if (wsConnection.value !== ws) return
      scheduleWsReconnect(taskId)
    }
    ws.onerror = () => { connected.value = false }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'log') handleLog(msg.data as WSLogPayload)
        else if (msg.type === 'done') handleDone(msg.data as WSDonePayload)
      } catch (e) {
        console.error('deploy ws parse failed', e)
      }
    }
  }

  function handleLog(p: WSLogPayload) {
    logs.value.push({
      time: p.time, deployer: p.deployer, step: p.step, level: p.level,
      message: p.message,
      messageKey: p.messageKey,
      messageParams: p.messageParams,
    })
    if (logs.value.length > MAX_LOGS) {
      logs.value.splice(0, logs.value.length - MAX_LOGS)
    }
    // 排队任务取到锁进入运行（P-20261004-36）：queued→running 过渡由 WS 日志
    // 驱动（taskStarted 只在 run 开始时广播一条），进度区状态标签即时翻转
    if (p.step === 'start' && p.messageKey === 'deploy.log.taskStarted' && currentTask.value) {
      currentTask.value.status = 'running'
      currentTask.value.waitingFor = undefined
      currentTask.value.queuePosition = undefined
    }
    // 解析 [i/total] starting xxx，更新真实进度
    // i 是从 1 开始的序号，total 是后端 resolved 后的真实总数
    if (p.step === 'start') {
      const m = PROGRESS_RE.exec(p.message)
      if (m && m[1] && m[2]) {
        const idx = parseInt(m[1], 10)
        const total = parseInt(m[2], 10)
        if (!isNaN(idx) && !isNaN(total) && total > 0) {
          progressIndex.value = idx - 1
          progressTotal.value = total
          if (currentTask.value) {
            currentTask.value.currentIndex = idx - 1
          }
        }
      }
    }
    if (p.step === 'publicKey' && p.message.includes(':')) {
      const idx = p.message.indexOf(':')
      publicKeys.value.push({
        keyName: p.message.substring(0, idx).trim(),
        publicKey: p.message.substring(idx + 1).trim(),
      })
    }
  }

  function handleDone(p: WSDonePayload) {
    if (currentTask.value) {
      currentTask.value.status = p.status
      if (p.error) currentTask.value.error = p.error
    }
    // 任务结束：进度推到 100%
    if (progressTotal.value > 0) {
      progressIndex.value = progressTotal.value
    }
    clearWsReconnect()
    if (wsConnection.value) {
      const ws = wsConnection.value
      wsConnection.value = null
      ws.close()
    }
  }

  async function cancel() {
    if (!currentTask.value) return
    await deployApi.cancel(currentTask.value.id)
  }

  function sendCancel() {
    if (wsConnection.value && wsConnection.value.readyState === WebSocket.OPEN) {
      wsConnection.value.send('cancel')
    }
  }

  function reset() {
    currentTask.value = null
    logs.value = []
    publicKeys.value = []
    progressIndex.value = 0
    progressTotal.value = 0
    clearWsReconnect()
    wsReconnectAttempts = 0
    if (wsConnection.value) {
      const ws = wsConnection.value
      wsConnection.value = null
      ws.close()
    }
  }

  async function loadTask(taskId: string) {
    const res = (await deployApi.get(taskId)) as unknown as { data?: DeployTask }
    return res.data
  }

  // 排队中刷新当前任务（P-20261004-36）：队列位次是动态内存态，随前方任务
  // 完成前移；DeployDialog 在 queued 态低频轮询调用，终态/重置时停止
  async function refreshCurrent() {
    const cur = currentTask.value
    if (!cur || finished.value) return
    try {
      const detail = await loadTask(cur.id)
      if (detail && currentTask.value && currentTask.value.id === cur.id) {
        const now = currentTask.value
        // 与 trigger 同款防回退：WS 已推进到 running/终态时，不让在途的旧
        // queued 详情把本地状态拉回去（响应乱序窗口，下轮轮询本可自愈，此处
        // 直接消除闪回）
        const status = detail.status === 'queued' && now.status !== 'queued' ? now.status : detail.status
        currentTask.value = { ...now, ...detail, status }
      }
    } catch { /* 静默：下轮轮询重试 */ }
  }

  async function listRecent() {
    const res = (await deployApi.listTasks()) as unknown as { data?: DeployTask[] }
    return res.data || []
  }

  return {
    currentTask, logs, publicKeys, connected, finished,
    progressIndex, progressTotal,
    trigger, connect, cancel, sendCancel, reset, loadTask, refreshCurrent, listRecent,
  }
})

