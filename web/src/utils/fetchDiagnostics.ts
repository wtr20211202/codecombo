// window.fetch 透明诊断包装（P-20261124-2 S1b a）：主 API 走 axios（错误中心
// 已有 200 条环），本包装只补「直连点」——同源 /api/、/proxy/ 的裸 fetch 失败
// 此前在浏览器侧零留痕（下载预检/实例探针/快捷链等）。零语义红线：
//   - 原函数/this/init/signal 原样透传；不 clone、不读 body、不 await；
//   - 调用方拿到的仍是原响应对象/原异常对象（异常经 then 重抛，绝不换成新错误）；
//   - 只在「失败 / status>=500 / 慢成功（TTFB>=5s）」时才入环——正常成功零开销；
//   - 跳过 /preview/、静态资源、blob:/data:、诊断端点自身（防递归）。
//
// fetch 只能测到响应头到达（TTFB），durationKind 如实标 ttfb，不声称总耗时；
// AbortError 标 canceled（导出默认过滤），navigator.onLine=false 归 offline。
// 请求头不注入 X-Request-Id（注入会改变请求语义）——rid 是纯客户端标识，服务端
// 对齐仍以 axios 主链路为准。

import { recordDiagEntry, currentDiagRoute, type DiagEntry } from './browserDiagnostics'
import { diagErrorClassOf, newClientRequestId, sanitizeMessage, sanitizeUrlPath } from './diagSanitize'

/** 慢成功阈值：超过此时长的成功响应也入环（卡顿证据） */
export const FETCH_SLOW_SUCCESS_MS = 5000
const MESSAGE_MAX = 500
// 防递归 + 非 JSON 面：诊断端点自身的请求不入环；预览/静态资源不是 API 证据
const SKIP_PATHS = ['/api/system/diagnostics/', '/api/preview/', '/preview/']

let installed = false

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  return String(input)
}

/** 是否记录：同源 + /api 或 /proxy + 非跳过面（解析失败一律不记） */
export function shouldRecordFetch(rawUrl: string): boolean {
  if (typeof location === 'undefined') return false
  try {
    const u = new URL(rawUrl, location.href)
    if (u.origin !== location.origin) return false
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (!u.pathname.startsWith('/api/') && !u.pathname.startsWith('/proxy/')) return false
    return !SKIP_PATHS.some((p) => u.pathname.startsWith(p) || u.pathname.includes(p))
  } catch {
    return false
  }
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError'
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return err == null ? '' : String(err)
}

function recordFetchOutcome(entry: DiagEntry): void {
  recordDiagEntry(entry)
}

/**
 * 安装 fetch 包装（幂等）。必须在首个业务请求前调用（main.ts 启动链）。
 */
export function installFetchDiagnostics(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  installed = true
  const originalFetch = window.fetch

  window.fetch = function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const startedWall = Date.now()
    const startedMono = typeof performance !== 'undefined' ? performance.now() : startedWall
    const rawUrl = requestUrlOf(input)
    const result = originalFetch.call(this, input, init)
    if (!shouldRecordFetch(rawUrl)) return result

    const method = (init?.method
      || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
      || 'GET').toUpperCase()
    const path = sanitizeUrlPath(rawUrl)
    const requestId = newClientRequestId()
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

    return result.then(
      (res) => {
        const durationMs = Math.max(0, Math.round(nowMs() - startedMono))
        const slow = durationMs >= FETCH_SLOW_SUCCESS_MS
        if (res.status >= 500 || slow) {
          recordFetchOutcome({
            kind: 'request',
            source: 'fetch',
            ts: new Date().toISOString(),
            startedAt: new Date(startedWall).toISOString(),
            durationMs,
            durationKind: 'ttfb',
            errorClass: res.status >= 500 ? 'http5xx' : 'unknown',
            method,
            path,
            status: res.status,
            requestId,
            route: currentDiagRoute(),
            message: '',
            slow: slow || undefined,
          })
        }
        return res
      },
      (err: unknown) => {
        const durationMs = Math.max(0, Math.round(nowMs() - startedMono))
        const canceled = isAbortError(err)
        const errorClass = canceled
          ? 'unknown'
          : diagErrorClassOf({
              code: (err as { code?: string } | null)?.code,
              message: errorMessageOf(err),
              response: undefined,
            })
        recordFetchOutcome({
          kind: 'request',
          source: 'fetch',
          ts: new Date().toISOString(),
          startedAt: new Date(startedWall).toISOString(),
          durationMs,
          durationKind: 'ttfb',
          errorClass,
          method,
          path,
          requestId,
          route: currentDiagRoute(),
          message: sanitizeMessage(errorMessageOf(err), MESSAGE_MAX),
          canceled: canceled || undefined,
        })
        // 原异常对象原样透传（零语义：异常类型/字段/栈由调用方照旧消费）
        throw err
      },
    )
  }
}
