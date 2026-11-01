// 远程部署域 API：部署配置 + 部署任务 + Deployer 元信息
import type { AxiosRequestConfig } from 'axios'
import api from '../http'

// 部署配置（脱敏返回，token 字段为 ****xxxx 形式）
export interface DeployConfig {
  anthropicToken: string
  hasAnthropicToken: boolean
  anthropicBaseUrl: string
  model: string
  binaryDir: string
}

// Deployer 参数 schema
export interface ParamOption {
  value: string
  label: string
}
export interface ParamSpec {
  key: string
  label: string
  type: 'text' | 'password' | 'email' | 'select'
  required: boolean
  default: string
  placeholder?: string
  help?: string
  options?: ParamOption[]
}

// Deployer 元信息
export interface DeployerInfo {
  id: string
  name: string
  category: 'init' | 'dev_tool' | 'self_host'
  description: string
  dependsOn: string[]
  steps: string[]
  allowMultiple: boolean
  paramsSchema: ParamSpec[]
}

// 部署任务实例
export interface DeployerInstance {
  deployerId: string
  params: Record<string, string>
}

// 部署任务
export interface DeployTask {
  id: string
  hostId: string
  host: string
  instances: DeployerInstance[]
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  currentIndex: number
  currentStep: string
  error?: string
  startedAt?: string
  finishedAt?: string
  publicKeys?: Array<{ keyName: string; publicKey: string }>
  // 同主机排队（P-20261004-36）：waitingFor=排队等待的在途任务 id（仅 queued
  // 排队态非空）；queuePosition=队列位次（1 起，动态内存态仅详情接口附带的）
  waitingFor?: string
  queuePosition?: number
}

// 本地二进制扫描结果
export interface PlatformBinary {
  fileName: string
  os: string
  arch: string
  sizeBytes: number
}

// 测试连接结果
export interface TestConnectionResult {
  ok: boolean
  os?: string
  arch?: string
  whoami?: string
  error?: string
}

export const deployConfigApi = {
  get: () => api.get<{ data: DeployConfig }>('/deploy-config'),
  update: (data: Partial<{
    anthropicToken: string
    anthropicBaseUrl: string
    model: string
    binaryDir: string
  }>) => api.put('/deploy-config', data),
}

export const deployApi = {
  listDeployers: () => api.get<{ data: DeployerInfo[] }>('/deploy/deployers'),
  scanBinaries: () => api.get<{ data: PlatformBinary[] }>('/deploy/binaries'),
  listTasks: () => api.get<{ data: DeployTask[] }>('/deploy/tasks'),
  trigger: (payload: { hostId: string; instances: DeployerInstance[]; noWait?: boolean }) =>
    api.post<{ taskId: string }>('/deploy', payload),
  // config：部署失败通知「交给智能体修复」（P-20261003-289）动作触发时的
  // 补拉走 silent——保留窗口外 404 是预期降级分支，不弹错误 toast
  get: (taskId: string, config?: AxiosRequestConfig) => api.get<{ data: DeployTask }>(`/deploy/${taskId}`, config),
  cancel: (taskId: string) => api.post<{ ok: boolean }>(`/deploy/${taskId}/cancel`),
  // 部署日志留档下载（P-20261003-142）：服务端内存日志环直出 txt 附件
  //（终态 1h 内存窗，窗外 410 携 `deploy log expired` 稳定标记）。silent +
  // blob：错误提示由调用方就地解析 blob 错误体给出（拦截器读不出 blob 原文），
  // 下载名客户端合成（导出族同约定，axios 不透 Content-Disposition）
  downloadLog: (taskId: string) =>
    api.get<Blob>(`/deploy/${taskId}/log`, { responseType: 'blob', timeout: 0, silent: true }),
}
