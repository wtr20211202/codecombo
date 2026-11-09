// 多实例同步域 API（P-20261023-1）：manifest/plan/pull/push/账本/定时任务
// 前端镜像。类型与服务端 server/api/sync/model.go 一一对应（archguard
// payload 快照哨兵盯漂移，改字段两侧同改）
import api from '../http'
import type { AxiosRequestConfig } from 'axios'

/** 同步单元 kind 词表（服务端 unitContexts 全集；uiState/runtimes 等是全局单元。
 * credentials 是手动携密同步专用单元——只在 includeCredentials 开关的 E2E 通道走，
 * 不进 plan/定时词表，P-20261024-3。notes/notes-multi 已随 P-20261108-3 笔记单库化
 * 退役——本端不再产出，只可能出现在旧对端 manifest 里（plan 行 state=retired） */
export type SyncUnitKind =
  | 'project' | 'sessions' | 'notes' | 'notes-multi' | 'crons'
  | 'snippets' | 'runtimes' | 'approvals' | 'chains' | 'uistate' | 'deliver'
  | 'credentials'

/** UnitEntry manifest/plan 的单元聚合条目 */
export interface SyncUnitEntry {
  key: string
  kind: SyncUnitKind
  projectKey?: string
  name: string
  fingerprint: string
  size: number
  files: number
  path?: string
  gitRepo?: boolean
  excluded?: number
  truncated?: boolean
  exists: boolean
}

/** ManifestResponse GET /api/sync/manifest data 段 */
export interface SyncManifest {
  units: SyncUnitEntry[]
  diskFree: number
  destRoot: string
  version?: string
}

/** PlanRow plan 预览单行（四态判定；retired = 旧对端仍带的退役笔记单元，
 *  action=skip 不可勾选——P-20261108-3 知情不执行） */
export interface SyncPlanRow extends SyncUnitEntry {
  state: 'synced' | 'local-newer' | 'peer-newer' | 'conflict' | 'new' | 'retired'
  action: 'push' | 'pull' | 'skip'
  selected: boolean
  baselineMissing?: boolean
  gitBothChanged?: boolean
  destPath?: string
  lastSyncedAt?: string
  lastDirection?: string
}

/** PlanResponse POST /api/sync/plan data 段 */
export interface SyncPlan {
  rows: SyncPlanRow[]
  peerDiskFree: number
  peerDiskInsufficient?: boolean
  totalBytes: number
  peerOnline: boolean
  peerStatus?: string
  peerVersion?: string
  peerUnsupported?: boolean
  message?: string
}

/** UnitProgress 单元行内状态机 */
export interface SyncUnitProgress {
  key: string
  kind: string
  name: string
  state: 'queued' | 'enumerating' | 'transferring' | 'landing' | 'done' | 'failed' | 'conflict-skipped' | 'busy-skipped'
  sent: number
  total: number
  current?: string
  error?: string
}

/** SyncJob 进度快照（WS sync.progress 广播与 GET /sync/progress 同形） */
export interface SyncJobSnapshot {
  id: string
  direction: 'pull' | 'push'
  peerName: string
  source: string
  units: SyncUnitProgress[]
  totalBytes: number
  sentBytes: number
  startedAt: string
  finishedAt?: string
  outcome: 'running' | 'done' | 'partial' | 'failed'
  speedBytesPerSec?: number
  etaSeconds?: number
}

/** ExecuteResult 执行结果（结果卡数据源） */
export interface SyncExecuteResult {
  jobId: string
  units: Array<{
    key: string
    ok: boolean
    skipped?: boolean
    busy?: boolean
    error?: string
    overwritten?: number
    backupDir?: string
  }>
  bytes: number
  durationMs: number
  envHints?: Record<string, string>
}

/** SyncLedgerEntry 账本条目（上次同步基线） */
export interface SyncLedgerEntry {
  key?: string
  peerId: string
  unitKey: string
  localFp: string
  peerFp: string
  localSize: number
  peerSize: number
  direction: string
  syncedAt: string
}

/** SyncCron 定时同步任务（调度字段与 agentcron 同义） */
export interface SyncCron {
  id?: string
  name: string
  direction: 'pull' | 'push'
  peerIds: string[]
  projectKeys?: string[]
  contexts?: string[]
  conflictPolicy?: 'safe' | 'local-mirror' | 'peer-mirror'
  includeIgnored?: boolean
  hour: number
  minute: number
  weekdays?: number[]
  timezone?: string
  enabled: boolean
  missCatchUp?: boolean
  lastRunAt?: string
  lastResult?: string
  lastNote?: string
  history?: Array<{ at: string; result: string; note?: string }>
  createdAt?: string
  updatedAt?: string
}

export const syncApi = {
  // 响应拦截器已解包 response.data；`as unknown as` 与 domains 层既有惯例一致
  manifest: (config?: AxiosRequestConfig) =>
    api.get<{ data: SyncManifest }>('/sync/manifest', config) as unknown as Promise<{ data?: SyncManifest }>,
  plan: (body: { instanceId: string; projectKeys?: string[]; contexts?: string[] }) =>
    api.post<{ data: SyncPlan }>('/sync/plan', body) as unknown as Promise<{ data?: SyncPlan }>,
  pull: (body: {
    instanceIds: string[]
    units: string[]
    resolutions?: Record<string, string>
    includeIgnored?: boolean
    includeGit?: boolean
    includeCredentials?: boolean
    parallel?: number
    destRoot?: string
  }) => api.post<{ data: { started: boolean } }>('/sync/pull', body) as unknown as Promise<{ data?: { started: boolean } }>,
  push: (body: {
    instanceIds: string[]
    units: string[]
    resolutions?: Record<string, string>
    includeIgnored?: boolean
    includeGit?: boolean
    includeCredentials?: boolean
    parallel?: number
  }) => api.post<{ data: { started: boolean } }>('/sync/push', body) as unknown as Promise<{ data?: { started: boolean } }>,
  deliver: (body: { instanceId: string; projectId: string; relPath: string; dest: string }) =>
    api.post<{ data: unknown }>('/sync/deliver', body) as unknown as Promise<{ data?: unknown }>,
  progress: () =>
    api.get<{ data: SyncJobSnapshot | null }>('/sync/progress') as unknown as Promise<{ data?: SyncJobSnapshot | null }>,
  ledger: () =>
    api.get<{ data: SyncLedgerEntry[] }>('/sync/ledger') as unknown as Promise<{ data?: SyncLedgerEntry[] }>,
  deleteLedger: (query: { peerId?: string; unitKey?: string }) =>
    api.delete<{ data: unknown }>('/sync/ledger', { params: query }) as unknown as Promise<{ data?: unknown }>,
  crons: () =>
    api.get<{ data: SyncCron[] }>('/sync/crons') as unknown as Promise<{ data?: SyncCron[] }>,
  createCron: (body: SyncCron) =>
    api.post<{ data: SyncCron }>('/sync/crons', body) as unknown as Promise<{ data?: SyncCron }>,
  updateCron: (id: string, body: SyncCron) =>
    api.put<{ data: SyncCron }>(`/sync/crons/${id}`, body) as unknown as Promise<{ data?: SyncCron }>,
  deleteCron: (id: string) =>
    api.delete<{ data: unknown }>(`/sync/crons/${id}`) as unknown as Promise<{ data?: unknown }>,
  runCron: (id: string) =>
    api.post<{ data: unknown }>(`/sync/crons/${id}/run`) as unknown as Promise<{ data?: unknown }>,
}

// ── 手动携密同步（P-20261024-3）：配对密钥 / 首次指纹核对 / 接收端暂存仪式 ──

/** PairingStatus GET /api/sync/pairing 单行（无明文钥——只出 pairFp 短指纹与钉扎证书指纹） */
export interface SyncPairingStatus {
  instanceId: string
  name: string
  url: string
  paired: boolean
  pairFp?: string
  certVerified: boolean
  certVerifiedAt?: string
  peerCertFp?: string
  lastCredSyncAt?: string
  lastCredDirection?: string
  lastCredMeta?: string
}

/** SyncCredStaged GET /api/sync/credentials/staged 单行（接收端暂存元数据） */
export interface SyncCredStaged {
  ticket: string
  peerName: string
  pairFp: string
  summary: string
  arrivedAt: string
  expiresAt: string
}

/** SyncCertInfo GET /api/sync/credentials/certinfo（本机证书指纹；HTTP 部署 tls=false/certFp 空） */
export interface SyncCertInfo {
  certFp: string
  tls: boolean
}

export const syncCredApi = {
  pairingStatus: () =>
    api.get<{ data: SyncPairingStatus[] }>('/sync/pairing') as unknown as Promise<{ data?: SyncPairingStatus[] }>,
  generatePairing: (instanceId: string) =>
    api.post<{ data: { pairingCode: string; pairFp: string } }>(`/sync/pairing/${instanceId}/generate`) as unknown as Promise<{ data?: { pairingCode: string; pairFp: string } }>,
  setPairing: (instanceId: string, code: string) =>
    api.put<{ data: { pairFp: string } }>(`/sync/pairing/${instanceId}`, { code }) as unknown as Promise<{ data?: { pairFp: string } }>,
  clearPairing: (instanceId: string) =>
    api.delete<{ data: unknown }>(`/sync/pairing/${instanceId}`) as unknown as Promise<{ data?: unknown }>,
  verify: (instanceId: string) =>
    api.post<{ data: { verified: boolean; pairFp?: string } }>('/sync/credentials/verify', { instanceId }) as unknown as Promise<{ data?: { verified: boolean; pairFp?: string } }>,
  staged: () =>
    api.get<{ data: SyncCredStaged[] }>('/sync/credentials/staged') as unknown as Promise<{ data?: SyncCredStaged[] }>,
  resolveStaged: (ticket: string, accept: boolean) =>
    api.post<{ data: { resolved: string; summary?: string } }>(`/sync/credentials/staged/${ticket}/resolve`, { accept }) as unknown as Promise<{ data?: { resolved: string; summary?: string } }>,
  localCertInfo: (config?: AxiosRequestConfig) =>
    api.get<{ data: SyncCertInfo }>('/sync/credentials/certinfo', config) as unknown as Promise<{ data?: SyncCertInfo }>,
}
