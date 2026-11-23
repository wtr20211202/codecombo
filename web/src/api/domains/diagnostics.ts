// 诊断包导出 API（P-20261122-10 S2a）：一站式排障入口的浏览器侧契约。
//
// 为什么单开一个 domain 文件而不是塞进 system.ts：system.ts 已到 1139 行
// （冻结面，新增只会把「一次改动一个文件」变成合并冲突热点）；诊断包是
// 独立能力面（体量探针 + 直链下载），单文件单职责。
//
// 下载走同源直链而非 axios blob（utils/directDownload 的既定判词）：诊断包
// 正常几 MB、上限可到 64MiB——blob 反模式要把整包读进内存才触发保存，直链
// 把传输交还浏览器（原生进度条、流式落盘、失败可见）。
import type { AxiosRequestConfig } from 'axios'
import api from '../http'
import { instanceApiBase } from '../../utils/directDownload'

/** manifest 条目状态（与 server/diagnostics 的 Status 常量一一对应） */
export type DiagnosticsEntryStatus = 'present' | 'truncated' | 'absent' | 'derived' | 'omitted' | 'denied'

export interface DiagnosticsFileEntry {
  /** zip 内条目名（logs/… / state/… / 顶层派生文件） */
  name: string
  /** 源路径（已归一为 $DATA_DIR / ~；派生文件无） */
  source?: string
  status: DiagnosticsEntryStatus
  originalBytes: number
  includedBytes: number
  omittedBytes?: number
  reason?: string
}

export interface DiagnosticsProbe {
  generatedAt: string
  version: string
  source: string
  mask: boolean
  logDays: number
  files: DiagnosticsFileEntry[]
  totals: {
    files: number
    packedFiles: number
    absent: number
    truncated: number
    omitted: number
    includedBytes: number
    /** 无压缩上界（真实 zip 因文本压缩远小于此） */
    zipUpperBoundBytes: number
  }
  limits: {
    fullFileBytes: number
    headBytes: number
    tailBytes: number
    rawBudgetBytes: number
    zipCapBytes: number
  }
  derivedFiles: string[]
  notes?: string[]
}

export interface DiagnosticsExportParams {
  /** 按日主日志天数（默认 3，服务端按 logRetentionDays 钳制） */
  days?: number
  /** 敏感值遮蔽，缺省开；false = 取证对账档（服务端 mask=0） */
  mask?: boolean
}

export const diagnosticsApi = {
  /** 体量预览（不打包）：先看有多大再决定拉不拉——`?probe=1` */
  probe: (params?: DiagnosticsExportParams, config?: AxiosRequestConfig) =>
    api.get<{ data: DiagnosticsProbe }>('/system/diagnostics/export', { params: { ...params, probe: 1 }, ...config }) as unknown as Promise<{ data?: DiagnosticsProbe }>,
  /** 导出直链（同源原生 GET；远程实例经 /proxy 前缀由实例令牌鉴权） */
  exportUrl: (params?: DiagnosticsExportParams): string => {
    const q = new URLSearchParams()
    if (params?.days && params.days > 0) q.set('days', String(params.days))
    if (params?.mask === false) q.set('mask', '0')
    const qs = q.toString()
    return `${instanceApiBase()}/system/diagnostics/export${qs ? `?${qs}` : ''}`
  },
}
