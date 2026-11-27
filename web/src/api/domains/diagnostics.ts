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
import type { ServerClientReportPayload } from '../../utils/browserDiagnostics'

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
  /**
   * 深度诊断（P-20261124-1）：服务端预算 20s → 30s，追加 self-probe、
   * TLS 全窗扫描、dmesg 等 deep-only 探针（`?deep=1`）
   */
  deep?: boolean
  /**
   * 浏览器侧报告附带（P-20261126-2 S2 / P-20261127-1 修订）：点「导出诊断包」
   * 时前端**恒先**自动 POST 一份最新裁剪快照，POST 成功才置 true——失败/超时
   * 不带参数照常下载（纯服务端包，不阻断）。参数不在场服务端不产生
   * state/browser.json 条目（防 manifest 恒注 absent 稀释缺席证据语义）。
   * 经 /proxy 的远程实例 cookie Path 不匹配天然退化为 absent（fail-closed）
   */
  clientReport?: boolean
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
    if (params?.deep) q.set('deep', '1')
    // 条件携带只表达「带参数」意图：true→clientReport=1，缺省不带参数
    if (params?.clientReport) q.set('clientReport', '1')
    const qs = q.toString()
    return `${instanceApiBase()}/system/diagnostics/export${qs ? `?${qs}` : ''}`
  },
  /**
   * 浏览器侧诊断报告上传（P-20261126-2 P-2b / P-20261127-1 修订）：调用点
   * ①「导出浏览器诊断」本地下载保底后异步附带；②「导出诊断包」直链前恒先
   * 同步附带（成功才带 clientReport=1）——均为显式点击触发，零自动后台申报。
   * 服务端 typed 白名单收口后进 5 分钟会话窗内存（纯内存、重启即清）。载荷 =
   * server 作用域裁剪版（buildServerClientReport），**不要**直接送本地全量
   * payload。失败不阻断（silent + 3s 超时由调用点给）
   */
  postClientReport: (payload: ServerClientReportPayload, config?: AxiosRequestConfig) =>
    api.post('/system/diagnostics/client-report', payload, config) as unknown as Promise<{ data?: { ok?: boolean } }>,
}
