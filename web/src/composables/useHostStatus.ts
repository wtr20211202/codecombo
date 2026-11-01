// useHostStatus —— 远程主机在线状态共享轮询（B3）
//
// 后端 30s 周期做 TCP 端口级探测（remotehost_status.go），本 composable 以同样的
// 周期轮询 GET /api/remotehosts/status 并把结果作为共享单例暴露给两处消费方：
// 远程控制台页（/remote）主机列表 + 设置页远程部署主机卡片。
// 模块级状态 = 应用生命周期内共享；首次消费时启动轮询，常驻不停止（30s 一次开销可忽略）
import { ref } from 'vue'
import { remoteHostApi } from '../api/client'

export interface HostStatus {
  state: 'online' | 'offline' | 'unknown'
  /** 最近一次真实认证（测试连接/开终端/文件浏览）是否通过；绿点 = online && authOk */
  authOk?: boolean
  lastCheck?: number
  latencyMs?: number
}

const statusMap = ref<Record<string, HostStatus>>({})
let pollTimer: ReturnType<typeof setInterval> | null = null
let fetching = false

async function fetchStatus() {
  if (fetching) return
  fetching = true
  try {
    // 响应拦截器已解包：res 即响应体 { data: { <hostId>: {state, authOk, lastCheck, latencyMs} } }
    const res = await remoteHostApi.status({ silent: true }) as unknown as {
      data?: Record<string, { state: string; authOk?: boolean; lastCheck?: number; latencyMs?: number }>
    }
    const next: Record<string, HostStatus> = {}
    for (const [id, v] of Object.entries(res.data || {})) {
      next[id] = {
        state: v.state === 'online' ? 'online' : 'offline',
        authOk: !!v.authOk,
        lastCheck: v.lastCheck,
        latencyMs: v.latencyMs,
      }
    }
    statusMap.value = next
  } catch { /* silent：锁定态/网络抖动保留上次结果 */ }
  finally {
    fetching = false
  }
}

function ensurePolling() {
  if (pollTimer) return
  void fetchStatus()
  pollTimer = setInterval(fetchStatus, 30_000)
}

/** 共享主机在线状态：statusMap[id] 缺省视为 unknown（服务尚未首轮探测） */
export function useHostStatus() {
  ensurePolling()
  // 大多数消费方随组件卸载不停止轮询（共享单例）；仅提供手动刷新入口
  return { statusMap, refresh: fetchStatus }
}

/** 测试环境/独立场景：停止轮询并清空状态 */
export function stopHostStatusPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
