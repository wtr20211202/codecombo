// 浏览器侧诊断环（P-20261124-2 S1a/S1b）：本地 JSON 导出为主路径的小型环形
// 采集器——网络失败请求（错误中心投影 + 直连 fetch）、脚本/Promise 未捕获异常、
// 资源加载失败、WS 生命周期，全部在捕获点脱敏后入环，诊断按钮一次性下载。
//
// 为什么不落服务端（本步）：P-2b 的服务端报告端点需要安全评审（写路由/CSRF/
// 限额/Redactor 二次过滤），本步只做不依赖服务端的本地环；JSON 不经服务器，
// 服务器卡死/无法导出时仍可用——这正是 P-20261124-1 复盘暴露的缺口。
//
// 隐私边界：
//   - 唯一真源是内存数组（关标签即失）；sessionStorage 只是最近 50 条快照
//     （刷新留存），走 safeStorage 通道（禁裸 sessionStorage）；
//   - 条目字段是白名单构造（projectDiagEntry 逐字段拷贝），永远不含请求/响应
//     body、请求头、retry params、rawMessage、原始 URL；
//   - 导出默认过滤 silent 探测（4xx 存在性探测是预期失败），只留 silent 超时/
//     5xx，并给 silentCount 说明被折叠的量；canceled（AbortError）默认过滤。
//
// 体量：内存环 200 条 / 下载 200KB 上限（超限从最旧丢并标 truncated=true）；
// session 快照 50 条。低价值字段（screen/performance.memory）不采集——跨浏览器
// 形态差异大且与本次排障目标（哪条请求/WS 断）无关。

import { safeStorage } from './storage'
import { getWsLifecycleEntries, clearWsLifecycle, type WsLifecycleEntry } from './wsLifecycle'
import { diagErrorClassOf, sanitizeMessage, sanitizeUrlPath, truncateChars, type DiagErrorClass } from './diagSanitize'

export const DIAG_SCHEMA_VERSION = 1
export const DIAG_ENTRY_LIMIT = 200
export const DIAG_RESOURCE_LIMIT = 50
export const DIAG_SNAPSHOT_LIMIT = 50
export const DIAG_PAYLOAD_BYTE_LIMIT = 200 * 1024
/** server 作用域条目上限（P-20261126-2：POST 上传最新 50 条，本地环 200 条全量仍只走本地下载） */
export const DIAG_SERVER_ENTRY_LIMIT = 50
const SNAPSHOT_KEY = 'sc.diag.snapshot'
const SNAPSHOT_WRITE_DELAY_MS = 1000
const DEDUPE_WINDOW_MS = 60_000
const UA_MAX = 256
const MESSAGE_MAX = 500

export type DiagEntryKind = 'request' | 'script' | 'promise'
/** 捕获口来源：xhr=axios 错误中心投影 / fetch=window.fetch 包装 / vue=Vue
 *  errorHandler / window=window.onerror / promise=unhandledrejection */
export type DiagEntrySource = 'xhr' | 'fetch' | 'vue' | 'window' | 'promise'

/** 诊断请求/脚本条目（白名单字段；新增字段必须先过隐私评审） */
export interface DiagEntry {
  kind: DiagEntryKind
  source: DiagEntrySource
  ts: string
  /** 请求开始时刻（ISO；仅请求条目） */
  startedAt?: string
  durationMs?: number
  errorClass: DiagErrorClass
  method?: string
  /** 模板化路径（无 host/query；如 /api/projects/:id/file） */
  path?: string
  status?: number
  requestId?: string
  timedOut?: boolean
  clientTimeoutMs?: number
  silent?: boolean
  /** 捕获时的前端路由（pathname） */
  route?: string
  /** 已脱敏消息（≤500 字符；不含 rawMessage/body/header） */
  message: string
  /** 同文案同分钟去重命中次数（脚本体错误折叠，不刷环） */
  repeats?: number
  crossOrigin?: boolean
  /** AbortError（fetch 主动取消）——导出默认过滤 */
  canceled?: boolean
  /** fetch 只能测到响应头（TTFB），不声称总耗时 */
  durationKind?: 'ttfb'
  /** fetch 慢成功（≥5s）标记（status 可能 <500） */
  slow?: boolean
  line?: number
  col?: number
}

export interface DiagResourceEntry {
  ts: string
  /** img/script/link/video 等标签名（小写） */
  tag: string
  path: string
  crossOrigin: boolean
}

export interface BrowserDiagnosticsPage {
  protocol: string
  /** 服务端观测 host 仅服务端能给出（P-2b 以请求 Host 为准）；本地导出缺省 */
  serverObservedHost?: string
  timezone: string
  tzOffsetMinutes: number
  visibility: string
  userAgent: string
}

export interface BrowserDiagnosticsPayload {
  schemaVersion: number
  generatedAt: string
  page: BrowserDiagnosticsPage
  entries: DiagEntry[]
  ws: WsLifecycleEntry[]
  resource: DiagResourceEntry[]
  /** 任一环/字节上限触发截断（从最旧丢） */
  truncated: boolean
  /** 环内 silent 条目数（导出默认只保留 silent 超时/5xx） */
  silentCount: number
  /** sessionStorage 快照写失败（配额满/被禁用）——只标记，不影响导出 */
  snapshotWriteFailed?: boolean
}

let entries: DiagEntry[] = []
let resources: DiagResourceEntry[] = []
let entryEvicted = false
let snapshotWriteFailed = false
let snapshotTimer: ReturnType<typeof setTimeout> | null = null
let installed = false

function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

/** 当前前端路由（pathname；脱敏后仅作「哪个页面发生的」定位线索） */
export function currentDiagRoute(): string {
  if (typeof location === 'undefined') return ''
  return sanitizeUrlPath(location.pathname || '')
}

function pushEntry(entry: DiagEntry): void {
  entries.unshift(entry)
  if (entries.length > DIAG_ENTRY_LIMIT) {
    entries.length = DIAG_ENTRY_LIMIT
    entryEvicted = true
  }
  scheduleSnapshot()
}

/**
 * 入环唯一入口：先白名单归一（normalizeDiagEntry 逐字段拷贝 + 重新脱敏——
 * 调用方误传 body/header/rawMessage 也进不了环），脚本类错误做「同文案 1 分钟」
 * 去重（同一异常经多个捕获口/重复派发时只留一条并累计 repeats；Vue errorHandler
 * 投影的是本地化 userMessage，与 window.onerror 原文不同文案时各留一条——两者
 * 描述的是不同观测面而非重复）；请求条目不去重（错误中心全量投影是排障基线，
 * 折叠会失真）。
 */
export function recordDiagEntry(entry: DiagEntry): void {
  const normalized = normalizeDiagEntry(entry)
  if (!normalized) return
  if (normalized.kind !== 'request') {
    const now = Date.now()
    const hit = entries.find((e) => e.kind === normalized.kind && e.message === normalized.message
      && Math.abs(now - Date.parse(e.ts)) <= DEDUPE_WINDOW_MS)
    if (hit) {
      hit.repeats = (hit.repeats ?? 1) + 1
      scheduleSnapshot()
      return
    }
  }
  pushEntry(normalized)
}

/**
 * 错误中心条目 → 诊断条目（useErrorLogStore.add 投影点）。
 * 只取白名单字段：url → 模板化 path；rawMessage/retry/响应体永不外发。
 * @param source 'xhr'（axios 错误）| 'vue'（errorHandler 入账的渲染错误）
 */
export function projectErrorLogEntry(entry: {
  timestamp: string
  category: string
  method: string
  url: string
  status: number
  userMessage: string
  requestId?: string
  errorClass?: DiagErrorClass
  durationMs?: number
  startedAt?: string
  silent?: boolean
  timedOut?: boolean
  clientTimeoutMs?: number
  route?: string
}, source: DiagEntrySource = 'xhr'): DiagEntry {
  const isVue = source === 'vue'
  return {
    kind: isVue ? 'script' : 'request',
    source,
    ts: entry.timestamp,
    startedAt: entry.startedAt,
    durationMs: typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
      ? entry.durationMs
      : undefined,
    errorClass: entry.errorClass ?? 'unknown',
    method: entry.method,
    path: sanitizeUrlPath(entry.url),
    status: entry.status,
    requestId: entry.requestId,
    timedOut: entry.timedOut || undefined,
    clientTimeoutMs: typeof entry.clientTimeoutMs === 'number' ? entry.clientTimeoutMs : undefined,
    silent: entry.silent || undefined,
    route: entry.route ?? currentDiagRoute(),
    // 只导 userMessage（面向用户的本地化文案）；rawMessage 属服务端原文，不入诊断包
    message: sanitizeMessage(entry.userMessage || '', MESSAGE_MAX),
  }
}

/** 资源加载失败入环（capture 相 error 事件的 target 分支） */
export function recordResourceFailure(tag: string, rawUrl: string, crossOrigin: boolean): void {
  resources.unshift({
    ts: new Date().toISOString(),
    tag: truncateChars(tag.toLowerCase(), 32),
    path: crossOrigin ? '' : sanitizeUrlPath(rawUrl).slice(0, 300),
    crossOrigin,
  })
  if (resources.length > DIAG_RESOURCE_LIMIT) resources.length = DIAG_RESOURCE_LIMIT
}

// ── sessionStorage 快照（P-20261124-2 S1b b）──────────────────────────────
// 只存最近 50 条已脱敏条目；节流 1s 尾写；safeStorage 通道（禁裸 sessionStorage）。
// 两类不可留存都只标 snapshotWriteFailed（不阻断导出）：配额满（setItem 被吞，
// 回读不一致）与存储不可用（隐私模式属性访问即抛，safeStorage 落内存兜底——
// 会话内可读、关标签即清，正是目标语义的降级形态）。内存数组恒为真源。

function snapshotPayload(): string {
  return JSON.stringify({
    schemaVersion: DIAG_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    entries: entries.slice(0, DIAG_SNAPSHOT_LIMIT),
  })
}

function writeSnapshotNow(): void {
  const payload = snapshotPayload()
  safeStorage.sessionSet(SNAPSHOT_KEY, payload)
  // 写失败两种形态都标：存储不可用（隐私模式属性即抛，safeStorage 落内存兜底）
  // 或配额满（setItem 被静默吞掉，回读不一致）——快照都不会跨刷新留存。只标记
  // 不降级：内存数组仍是真源，导出照常。
  snapshotWriteFailed = !safeStorage.sessionAvailable() || safeStorage.sessionGet(SNAPSHOT_KEY) !== payload
}

function scheduleSnapshot(): void {
  if (snapshotTimer !== null) return
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null
    writeSnapshotNow()
  }, SNAPSHOT_WRITE_DELAY_MS)
}

function flushSnapshot(): void {
  if (snapshotTimer !== null) {
    clearTimeout(snapshotTimer)
    snapshotTimer = null
    writeSnapshotNow()
  }
}

/** 快照归一：只认白名单字段 + 重新脱敏（sessionStorage 是 XSS 可读面，读侧
 *  防御性重建——被篡改的条目不能把任意字段带进导出） */
function normalizeDiagEntry(raw: unknown): DiagEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.message !== 'string' || typeof r.ts !== 'string') return null
  const kind: DiagEntryKind = r.kind === 'script' || r.kind === 'promise' ? r.kind : 'request'
  const source: DiagEntrySource = r.source === 'fetch' || r.source === 'vue' || r.source === 'window'
    || r.source === 'promise' || r.source === 'xhr' ? r.source : 'xhr'
  const errorClass: DiagErrorClass = r.errorClass === 'timeout' || r.errorClass === 'network'
    || r.errorClass === 'offline' || r.errorClass === 'http4xx' || r.errorClass === 'http5xx'
    ? r.errorClass : 'unknown'
  return {
    kind,
    source,
    ts: r.ts,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : undefined,
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : undefined,
    errorClass,
    method: typeof r.method === 'string' ? truncateChars(r.method, 16) : undefined,
    // path 也是读侧不可信输入（快照可被同源脚本篡改）：URL 模板化后再过一遍
    // 绝对路径脱敏（正常 API 路径不以系统根开头，零误伤）
    path: typeof r.path === 'string' ? sanitizeMessage(sanitizeUrlPath(r.path), 300) : undefined,
    status: typeof r.status === 'number' ? r.status : undefined,
    requestId: typeof r.requestId === 'string' ? truncateChars(r.requestId, 64) : undefined,
    timedOut: r.timedOut === true || undefined,
    clientTimeoutMs: typeof r.clientTimeoutMs === 'number' ? r.clientTimeoutMs : undefined,
    silent: r.silent === true || undefined,
    route: typeof r.route === 'string' ? sanitizeUrlPath(r.route) : undefined,
    message: sanitizeMessage(r.message, MESSAGE_MAX),
    repeats: typeof r.repeats === 'number' ? r.repeats : undefined,
    crossOrigin: r.crossOrigin === true || undefined,
    canceled: r.canceled === true || undefined,
    durationKind: r.durationKind === 'ttfb' ? 'ttfb' : undefined,
    slow: r.slow === true || undefined,
    line: typeof r.line === 'number' ? r.line : undefined,
    col: typeof r.col === 'number' ? r.col : undefined,
  }
}

function restoreSnapshot(): void {
  const raw = safeStorage.sessionGet(SNAPSHOT_KEY)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: number; entries?: unknown }
    if (parsed?.schemaVersion !== DIAG_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      safeStorage.sessionRemove(SNAPSHOT_KEY)
      return
    }
    const restored: DiagEntry[] = []
    for (const item of parsed.entries) {
      const normalized = normalizeDiagEntry(item)
      if (normalized) restored.push(normalized)
      if (restored.length >= DIAG_SNAPSHOT_LIMIT) break
    }
    entries = [...restored, ...entries].slice(0, DIAG_ENTRY_LIMIT)
  } catch {
    safeStorage.sessionRemove(SNAPSHOT_KEY)
  }
}

/** 清掉 session 快照（锁定/登出等隐私边界用；内存环保留供本标签页会话内导出） */
export function clearDiagSnapshot(): void {
  if (snapshotTimer !== null) {
    clearTimeout(snapshotTimer)
    snapshotTimer = null
  }
  safeStorage.sessionRemove(SNAPSHOT_KEY)
  snapshotWriteFailed = false
}

/** 全清（错误中心清空/实例切换）：内存环 + 快照 + WS 环 */
export function clearBrowserDiagnostics(): void {
  entries = []
  resources = []
  entryEvicted = false
  clearDiagSnapshot()
  clearWsLifecycle()
}

// ── 捕获口（installBrowserDiagnostics 幂等安装）───────────────────────────

function isSameOrigin(raw: string): boolean {
  if (!raw || typeof location === 'undefined') return false
  try {
    return new URL(raw, location.href).origin === location.origin
  } catch {
    return false
  }
}

function onWindowError(event: Event): void {
  // 资源加载失败在 capture 相是普通 Event（target 为 img/script/link…）；
  // 脚本错误是 ErrorEvent。用 ErrorEvent 判别而非 target===window——jsdom/
  // 部分封装环境下 window 代理与 event.target 引用不恒等（实测 vitest jsdom）
  if (typeof ErrorEvent === 'undefined' || !(event instanceof ErrorEvent)) {
    const el = event.target as (HTMLElement | null)
    const raw = (el as (HTMLElement & { src?: string; href?: string }) | null)?.src
      || (el as (HTMLElement & { src?: string; href?: string }) | null)?.href
      || ''
    recordResourceFailure(el?.tagName || 'unknown', raw, !isSameOrigin(raw))
    return
  }
  const e = event
  if (!e.message) return
  const crossOrigin = e.message === 'Script error.' || (!!e.filename && !isSameOrigin(e.filename))
  recordDiagEntry({
    kind: 'script',
    source: 'window',
    ts: new Date().toISOString(),
    errorClass: 'unknown',
    path: crossOrigin ? undefined : sanitizeUrlPath(e.filename || ''),
    message: sanitizeMessage(crossOrigin ? 'Script error.' : e.message, MESSAGE_MAX),
    crossOrigin: crossOrigin || undefined,
    line: crossOrigin ? undefined : e.lineno || undefined,
    col: crossOrigin ? undefined : e.colno || undefined,
    route: currentDiagRoute(),
  })
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  const reason = (event as PromiseRejectionEvent).reason
  const message = reason instanceof Error ? reason.message : reason
  recordDiagEntry({
    kind: 'promise',
    source: 'promise',
    ts: new Date().toISOString(),
    errorClass: diagErrorClassOf(null),
    message: sanitizeMessage(message, MESSAGE_MAX),
    route: currentDiagRoute(),
  })
}

/**
 * 安装浏览器捕获口（幂等）：capture 相 error（脚本 + 资源）+ unhandledrejection
 * + pagehide（只 flush 本地快照，不发网络）。不 preventDefault——零语义改变。
 */
export function installBrowserDiagnostics(): void {
  if (installed || !hasWindow()) return
  installed = true
  restoreSnapshot()
  window.addEventListener('error', onWindowError, true)
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  window.addEventListener('pagehide', flushSnapshot)
}

// ── 导出 ────────────────────────────────────────────────────────────────

function resolvePage(): BrowserDiagnosticsPage {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  // 时区读取在部分隐私模式/老浏览器会抛（Intl 缺失）：兜底空串，诊断仍可导出
  let timezone: string
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    timezone = ''
  }
  return {
    protocol: typeof location === 'undefined' ? '' : location.protocol,
    timezone,
    tzOffsetMinutes: typeof Date === 'undefined' ? 0 : new Date().getTimezoneOffset(),
    visibility: typeof document === 'undefined' ? '' : document.visibilityState,
    userAgent: truncateChars(nav?.userAgent ?? '', UA_MAX),
  }
}

function byteLength(text: string): number {
  if (typeof TextEncoder === 'undefined') return text.length
  return new TextEncoder().encode(text).length
}

/**
 * 组装导出载荷：默认过滤 canceled 与 silent 4xx/network 探测（只留 silent
 * timeout/5xx/offline）；超 200KB 从最旧条目丢并标 truncated。
 */
export function buildBrowserDiagnosticsPayload(): BrowserDiagnosticsPayload {
  const silentCount = entries.reduce((n, e) => (e.silent ? n + 1 : n), 0)
  const kept = entries.filter((e) => {
    if (e.canceled) return false
    if (!e.silent) return true
    return e.errorClass === 'timeout' || e.errorClass === 'http5xx' || e.errorClass === 'offline'
  })
  const payload: BrowserDiagnosticsPayload = {
    schemaVersion: DIAG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    page: resolvePage(),
    entries: kept.map((e) => ({ ...e })),
    ws: getWsLifecycleEntries(),
    resource: resources.map((r) => ({ ...r })),
    truncated: entryEvicted,
    silentCount,
  }
  if (snapshotWriteFailed) payload.snapshotWriteFailed = true
  let json = JSON.stringify(payload)
  if (byteLength(json) <= DIAG_PAYLOAD_BYTE_LIMIT) return payload

  payload.truncated = true
  while (payload.entries.length > 0 && byteLength(json) > DIAG_PAYLOAD_BYTE_LIMIT) {
    payload.entries.pop()
    json = JSON.stringify(payload)
  }
  while (payload.ws.length > 0 && byteLength(json) > DIAG_PAYLOAD_BYTE_LIMIT) {
    payload.ws.pop()
    json = JSON.stringify(payload)
  }
  while (payload.resource.length > 0 && byteLength(json) > DIAG_PAYLOAD_BYTE_LIMIT) {
    payload.resource.pop()
    json = JSON.stringify(payload)
  }
  return payload
}

export interface BrowserDiagnosticsDownload {
  fileName: string
  bytes: number
  entries: number
}

// ── server 作用域裁剪（P-20261126-2 P-2b）─────────────────────────────────
// 本文件保持叶子（只依赖脱敏原语）：上传用 axios 调用与本模块分离——
// 裁剪 builder 在此（纯函数，vitest 直测），POST 调用点在 ServerLogsSection
// 经 api/domains/diagnostics 执行。两层防线的前端半场：非白名单数据（resource
// 环 / page.userAgent / page.protocol）在这里就不出浏览器，服务端 typed 白名单
// 只做兜底而不是唯一防线（评审 A1）。

/** server 作用域 page：顶层 host/UA/protocol 不出浏览器（host 由服务端以请求
 *  Host 回填 serverObservedHost；UA/protocol 是拓扑/指纹面，非排障必需） */
export interface ServerClientReportPage {
  timezone: string
  tzOffsetMinutes: number
  visibility: string
}

/** POST /api/system/diagnostics/client-report 的载荷形状（= 服务端 typed
 *  白名单的镜像；entry/ws 字段即本地环白名单形状，捕获点已脱敏） */
export interface ServerClientReportPayload {
  schemaVersion: number
  generatedAt: string
  page: ServerClientReportPage
  entries: DiagEntry[]
  ws: WsLifecycleEntry[]
}

/**
 * 本地载荷 → server 作用域裁剪版：entries/ws 取**最新 50**（本地构造序=
 * unshift 序即最新优先，slice 前 50 就是最新 50；服务端 ≤50 只是兜底——
 * 超限截断不拒收，评审 A2），剔除 resource[] 与 page.userAgent/protocol。
 * 单次构造（评审 B1）：入参是已构造好的本地 payload，与本地下载文件同源
 * 快照——zip 内 browser.json 与用户本地文件内容一致。
 */
export function buildServerClientReport(payload: BrowserDiagnosticsPayload): ServerClientReportPayload {
  return {
    schemaVersion: payload.schemaVersion,
    generatedAt: payload.generatedAt,
    page: {
      timezone: payload.page.timezone,
      tzOffsetMinutes: payload.page.tzOffsetMinutes,
      visibility: payload.page.visibility,
    },
    entries: payload.entries.slice(0, DIAG_SERVER_ENTRY_LIMIT).map((e) => ({ ...e })),
    ws: payload.ws.slice(0, DIAG_SERVER_ENTRY_LIMIT).map((w) => ({ ...w })),
  }
}

// P-20261127-1：前端 `lastReportPostAt` 5 分钟条件携带窗口已退役——「导出诊断
// 包」按钮自身在直链前恒先 POST 一份最新快照（成功才带 clientReport=1），不再
// 读「点过『导出浏览器诊断』没有」。服务端 5 分钟会话窗（TTL/封顶）不受影响，
// 仍按 cookie 取最近一份入包。本模块不发网络，POST 调用点在 ServerLogsSection。

function diagnosticsFileName(): string {
  // 文件名只用 [0-9A-Za-z-]：Windows 不允许冒号，ISO 串去冒号/点后跨平台安全
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return `browser-diagnostics-${ts}.json`
}

/**
 * 主路径：立即本地下载 `browser-diagnostics-<ts>.json`（Blob，不经服务器）。
 * payload 可传入已构造好的载荷（P-20261126-2 B1 单次构造：本地下载与 POST
 * 上传共用同一快照——环在变，两次构造可能不同）；缺省自行构造。失败
 * （Blob/URL 不可用等）向上抛，调用方 toast 可重试——不写 localStorage、
 * 不后台发送。
 */
export function downloadBrowserDiagnostics(payload: BrowserDiagnosticsPayload = buildBrowserDiagnosticsPayload()): BrowserDiagnosticsDownload {
  const json = JSON.stringify(payload)
  const fileName = diagnosticsFileName()
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { fileName, bytes: byteLength(json), entries: payload.entries.length }
}

/** 当前环内条目数（UI 反馈用） */
export function diagEntryCount(): number {
  return entries.length
}
