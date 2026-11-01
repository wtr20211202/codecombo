/**
 * 远程任务进度命名空间（P-20261004-131）：联邦派发回流把对端会话进度映射进
 * 本地 bySession 时，terminalId 键用 `remote:<instanceId>:<sessionId>` 防撞——
 * 本地会话 id（uuid）不可能携带该前缀形态，本地/远程两条命名空间零交集。
 * 纯函数收口：构建（回流轮询写）、解析（徽标/跳转/通知读）共用同一形态。
 */

export const REMOTE_TASK_PREFIX = 'remote:'

/** 远程任务键元组 */
export interface RemoteTaskRef {
  instanceId: string
  sessionId: string
}

/** 构建远程任务键（回流写入侧） */
export function remoteTaskKey(instanceId: string, sessionId: string): string {
  return `${REMOTE_TASK_PREFIX}${instanceId}:${sessionId}`
}

/**
 * 解析远程任务键：非 remote: 前缀（本地会话 id）或段缺失返回 null——
 * 消费侧一律 null 守卫，本地键走既有链路零感知
 */
export function parseRemoteTaskKey(key: string | null | undefined): RemoteTaskRef | null {
  if (!key || !key.startsWith(REMOTE_TASK_PREFIX)) return null
  const rest = key.slice(REMOTE_TASK_PREFIX.length)
  // instanceId / sessionId 段均非空才算合法键（uuid 两段，分隔符只认首个冒号
  // 之后的整体为 instanceId——实例 id 自身不含冒号，注册库生成）
  const sep = rest.indexOf(':')
  if (sep <= 0 || sep === rest.length - 1) return null
  return { instanceId: rest.slice(0, sep), sessionId: rest.slice(sep + 1) }
}
