// 换机迁移域 API（P-20261003-147）：.scpkg 导出/三段式导入前端镜像。
// 类型与服务端 server/api/sync/migration_model.go 对应（api-routes 门禁盯
// 路径漂移，payload 字段两侧同改）
import api from '../http'
import type { AxiosRequestConfig } from 'axios'

/** 配置四块勾选 */
export interface MigrationBlocks {
  credentials: boolean
  tokens: boolean
  settings: boolean
  instances: boolean
}

/** 全量包逐项目勾选 */
export interface MigrationProjectChoice {
  projectId: string
  name?: string
  key?: string
  dirName?: string
  includeGit: boolean
  includeContexts: boolean
}

/** 导出请求 */
export interface MigrationExportRequest {
  mode: 'light' | 'full'
  passphrase: string
  blocks: MigrationBlocks
  projects?: MigrationProjectChoice[]
  globalContexts?: boolean
}

/** 凭据预览行（host/用户名级元数据，无秘密明文） */
export interface MigrationCredRow {
  kind: 'git' | 'sshHost' | 'sshKey' | 'deploy'
  label: string
  detail?: string
  exists: boolean
  portable?: boolean
}

/** 设置块逐字段 diff */
export interface MigrationFieldDiff {
  field: string
  local?: string
  incoming?: string
}

/** 实例注册表预览行 */
export interface MigrationInstanceRow {
  id: string
  name: string
  url: string
  exists: boolean
}

/** 内容单元预览行 */
export interface MigrationUnitRow {
  key: string
  kind: string
  name: string
  size: number
  files: number
  dirName?: string
  includeGit?: boolean
  destPath?: string
}

/** 全量包内容档预览 */
export interface MigrationContentPreview {
  destRoot: string
  diskFree: number
  totalBytes: number
  units: MigrationUnitRow[]
}

/** 预览响应 data 段 */
export interface MigrationPreview {
  format: string
  version: number
  mode: 'light' | 'full'
  host: string
  createdAt: string
  blocks: MigrationBlocks
  ticket: string
  credentials?: MigrationCredRow[]
  settingsDiff?: MigrationFieldDiff[]
  instances?: MigrationInstanceRow[]
  hasAgentToken?: boolean
  content?: MigrationContentPreview
}

/** 单块应用结果 */
export interface MigrationBlockReport {
  imported: number
  skipped: number
  failed: number
  error?: string
}

/** 应用结果报告 */
export interface MigrationApplyReport {
  blocks: Record<string, MigrationBlockReport>
  content?: {
    units: Array<{ key: string; ok: boolean; error?: string; registered?: boolean; backupDir?: string }>
    destRoot: string
  }
  rolledBack: boolean
  error?: string
  peerCount?: number
  landedProjects?: string[]
}

/** 每块导入策略 */
export type MigrationBlockPolicy = 'merge' | 'overwrite' | 'skip'
/** 设置块策略（整块：以包为准 / 保留本机） */
export type MigrationSettingsPolicy = 'package' | 'local'

export const migrationApi = {
  /** 导出 .scpkg：blob 由调用方触发保存；大包关闭 axios 超时
   *（remote.ts blob timeout:0 同款模式）。口令遗失无法恢复 */
  export: (body: MigrationExportRequest, config?: AxiosRequestConfig) =>
    api.post('/migration/export', body, {
      responseType: 'blob',
      timeout: 0,
      ...config,
    }) as unknown as Promise<Blob>,

  /** 导入预览：multipart（file+passphrase）→ 预览载荷 + 一次性票据 */
  preview: (file: File, passphrase: string) => {
    const form = new FormData()
    form.append('file', file)
    form.append('passphrase', passphrase)
    return api.post<{ data: MigrationPreview }>('/migration/import/preview', form, {
      timeout: 0,
    }) as unknown as Promise<{ data?: MigrationPreview }>
  },

  /** 导入应用：票据 + 逐块策略（+ 全量包勾选项目键）；返回结果报告 */
  apply: (body: {
    ticket: string
    blocks: Record<string, string>
    projects?: string[]
  }) =>
    api.post<{ data: MigrationApplyReport }>('/migration/import/apply', body, {
      timeout: 0,
    }) as unknown as Promise<{ data?: MigrationApplyReport }>,
}
