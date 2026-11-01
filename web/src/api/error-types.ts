import type { AxiosError } from 'axios'

export type ErrorCategory =
  | 'network' | 'auth' | 'forbidden' | 'notFound'
  | 'validation' | 'gitConflict' | 'conflict'
  | 'server' | 'client' | 'unknown'

/**
 * 错误中心原地重试配置（P-20261003-179）：仅幂等 GET 失败附带。
 * 非幂等方法（POST/DELETE）重放会重复副作用（重复创建/删除/发信），安全边界
 * 一律不提供——恢复走原面板重新操作；PUT/PATCH 尽管语义幂等，同为写意图请求，
 * 从严不放行（只放行读意图的 GET）。
 */
export interface ErrorRetryInfo {
  /** 重放路径：远程代理改写前的原始相对路径快照（重放经请求拦截器重新改写，存改写后路径会叠加 /proxy 前缀） */
  url: string
  /** 原请求 query 参数（readFile 的 path、file-tree 的 path 等 GET 语义载荷） */
  params?: Record<string, unknown>
  /** 失败时的实例上下文快照：重放前校验，实例已切换（本地↔远程/换主机）则拒绝原地重试，防打到错误目标 */
  instanceId: string | null
  isRemote: boolean
}

export interface ErrorLogEntry {
  id: string
  timestamp: string
  category: ErrorCategory
  method: string
  url: string
  status: number
  rawMessage: string
  userMessage: string
  sourceLabel?: string
  /** 后端 X-Request-Id 响应头（P-20261003-216）：与后端日志 rid= 字段对齐；无响应（网络层失败）时缺省 */
  requestId?: string
  /** 结构化错误码（P-305 响应体 {error, code}；P-20261005-153）：详情面板徽标透出供报障引用；未迁移端点/网络层失败时缺省 */
  code?: string
  /** GET 类失败的原地重试配置（P-20261003-179）；非幂等方法不附（安全边界，见 ErrorRetryInfo 注） */
  retry?: ErrorRetryInfo
  /** 重试成功时刻（ISO）：非空即「已恢复」态，重试钮让位已恢复标记 */
  recoveredAt?: string
}

export class AppError extends Error {
  constructor(
    public category: ErrorCategory,
    public rawMessage: string,
    public status: number,
    public url: string,
    public method: string,
    public sourceLabel?: string,
    /** 拦截器生成的友好提示（errorLabel / 已知错误映射 / 分类兜底），组件展示优先用它 */
    public userMessage?: string,
    /** 响应体结构化载荷（409 携 remoteBranches/currentContent 等影响面明细），按需读取 */
    public data?: Record<string, unknown>,
  ) {
    super(rawMessage)
    this.name = 'AppError'
  }
}

export function classify(error: AxiosError): ErrorCategory {
  if (!error.response) return 'network'
  const status = error.response.status
  const raw = (error.response.data as { error?: string } | undefined)?.error ?? ''
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'notFound'
  if (status === 400) return 'validation'
  if (status === 409) return raw.includes('CONFLICT') ? 'gitConflict' : 'conflict'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'unknown'
}
