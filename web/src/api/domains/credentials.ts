// 凭据域 API：Git 凭据（PAT/密码 + OAuth Device Flow）+ OAuth Client + SSH Key
import api from '../http'

// Git 凭据（PAT/密码 + OAuth Device Flow + OAuth Web）
// 后端字段统一为 snake_case；auth_type 区分来源，status 反映有效期
export interface Credential {
  id: string
  host: string
  platform: string
  auth_type: string  // "basic" | "oauth-device" | "oauth-web"
  username: string
  has_secret: boolean
  refresh_token_set?: boolean
  expires_at?: string | null
  scope?: string
  status: 'active' | 'expired'
  last_error?: string
  created_at: string
  updated_at: string
  last_used_at?: string
}

// 旧名兼容：保留导出避免破坏现有 caller（字段已迁移到 Credential，Task 4 起逐步切换引用）
export type GitCredential = Credential

// 测试凭据返回结构
export interface TestCredentialResp {
  status: 'ok' | 'limited' | 'expired' | 'network_error'
  message?: string
}

export const credentialApi = {
  list: () => api.get<{ data: Credential[] }>('/credentials'),
  save: (data: {
    host: string
    username: string
    secret?: string
    auth_type?: string
    platform?: string
  }) => api.post<{ data: Credential }>('/credentials', data),
  remove: (id: string) => api.delete(`/credentials/${id}`),
  // 测试凭据是否仍有效（OAuth 会尝试 refresh，basic 走 API 调用或 ls-remote）
  // repoUrl 仅 generic 平台用：走 git ls-remote 真实验证（generic 无标准 /user API）
  // timeout: 0（P-20261002-53 涉网超时矩阵补齐）：ls-remote/refresh 涉网可超 30s，
  // 服务端 git_timeout 网络档兜底
  test: (id: string, repoUrl?: string) =>
    api.post<TestCredentialResp>(`/credentials/${id}/test`, repoUrl ? { repo_url: repoUrl } : undefined, { timeout: 0 }),
}

// OAuth Client 配置（GitHub/Gitea 等平台的 OAuth App 凭据）
export interface OAuthClient {
  platform: string
  host: string
  client_id: string
  has_secret: boolean
}

export interface SaveOAuthClientReq {
  platform: string
  host: string
  client_id: string
  client_secret?: string
}

export const oauthClientApi = {
  list: () => api.get<{ clients: OAuthClient[] }>('/oauth-clients'),
  // silent：拦截器已弹 toast，调用方（OAuthClientManager.save）本地再弹会双提示；
  // remove 的调用方 catch 不本地弹错（拦截器统一处理），保持非 silent
  save: (req: SaveOAuthClientReq) => api.post('/oauth-clients', req, { silent: true }),
  remove: (platform: string, host: string) =>
    api.delete(`/oauth-clients/${encodeURIComponent(platform)}/${encodeURIComponent(host)}`),
}

// OAuth Device Flow
export interface OAuthStartReq {
  platform: string
  host?: string
}

export interface OAuthStartResp {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface OAuthPollResp {
  status: 'pending' | 'ok' | 'expired' | 'denied'
  credential_id?: string
  interval?: number
}

export const oauthApi = {
  start: (req: OAuthStartReq) => api.post<OAuthStartResp>('/oauth/start', req),
  poll: (platform: string, host: string, deviceCode: string) =>
    api.get<OAuthPollResp>('/oauth/poll', { params: { platform, host, device_code: deviceCode } }),
  refresh: (credId: string) => api.post(`/oauth/refresh/${credId}`),
  revoke: (credId: string) => api.delete(`/oauth/revoke/${credId}`),
}

// SSH Key 管理
export interface SshKey {
  id: string
  name: string
  fingerprint: string
  algo: string
  host: string
  createdAt: string
}
export const sshKeyApi = {
  list: () => api.get<{ data: SshKey[] }>('/sshkeys'),
  generate: (data: { name: string; algo: string }) =>
    api.post<{ data: SshKey; pubKey: string }>('/sshkeys/generate', data),
  import: (data: { name: string; privateKey: string }) =>
    api.post<{ data: SshKey }>('/sshkeys/import', data),
  remove: (id: string) => api.delete(`/sshkeys/${id}`),
  getPub: (id: string) => api.get<{ pubKey: string }>(`/sshkeys/${id}/pub`),
}
