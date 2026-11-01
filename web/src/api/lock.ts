import api from './client'

// 锁定状态：后端 GET /lock/state 返回结构
export interface LockState {
  enabled: boolean
  autoLockEnabled: boolean
  autoLockMinutes: number
  tokenTTLMinutes: number
  isDefaultPassword: boolean
  /** 从未初始化配置（首次安装/reset-lock 后）：走设密流程而非解锁 */
  needsSetup: boolean
  /** 服务绑定通配地址（0.0.0.0/::）：首启设密允许从局域网任意机器经 IP 完成 */
  lanSetupAllowed?: boolean
}

// 解锁响应：后端 POST /lock/unlock 返回结构
export interface UnlockResponse {
  token: string
  expiresIn: number
}

// 锁定配置：后端 GET /lock/config 返回结构
export interface LockConfig {
  enabled: boolean
  autoLockEnabled: boolean
  autoLockMinutes: number
  tokenTTLMinutes: number
}

// 锁定 API 客户端——复用全局 axios 实例，拦截器统一处理 X-Lock-Token 与 423
export const lockApi = {
  // 查询当前锁定状态（无需 token）
  getState(): Promise<LockState> {
    return api.get('/lock/state')
  },

  // 解锁：成功返回 token
  // silent：解锁失败（401 密码错误 / 429 限流）由 LockScreenOverlay 自行提示，
  // 不再额外弹全局 toast「登录已失效」，避免与表单内错误文案重复
  unlock(password: string): Promise<UnlockResponse> {
    return api.post('/lock/unlock', { password }, { silent: true })
  },

  // 首次设置密码（仅后端无配置时可用；成功直接返回 token）
  setup(password: string): Promise<UnlockResponse> {
    return api.post('/lock/setup', { password }, { silent: true })
  },

  // 主动锁定：撤销当前 token
  lock(): Promise<void> {
    return api.post('/lock/lock')
  },

  // 查询配置（需 token；423 表示 token 失效）
  getConfig(): Promise<LockConfig> {
    return api.get('/lock/config')
  },

  // 更新配置：服务端修改后会 RevokeAllTokens，自身 token 同步失效
  updateConfig(config: Partial<LockConfig>, currentPassword: string): Promise<void> {
    return api.put('/lock/config', { ...config, currentPassword })
  },

  // 修改密码：同样触发 RevokeAllTokens
  updatePassword(currentPassword: string, newPassword: string): Promise<void> {
    return api.put('/lock/password', { currentPassword, newPassword })
  },
}
