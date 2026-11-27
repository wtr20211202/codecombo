// 浏览器诊断环的脱敏原语（P-20261124-2 S1a②）：捕获时就地模板化/截断。
//
// 为什么在捕获点收口而不是导出时：诊断 JSON 会被用户下载/外发，token、查询参数、
// 绝对路径一旦写进环形/快照就没有第二次补救机会（之后的任何复制/缓存都会放大
// 泄漏面）。因此错误中心投影、fetch 包装、WS 生命周期、资源加载失败全部只吃本
// 模块的返回值——导出层不再做第二次清洗（服务端 P-2b 的 Redactor 是独立第二道）。
//
// 诚实边界（有意不追求通用脱敏）：
//   - URL 只保留 pathname，去掉 origin/host/query/fragment——host 可能含内网
//     拓扑，query 可能含 share token/路径参数；
//   - 路径段模板化只覆盖本产品的已知形态（/s/<token>、/api/share/<token>、
//     /proxy/<instanceId>、UUID、16 hex id），不做通用"像 id 就替换"的猜测，
//     避免把正常路径（如 /api/projects）打成 :id 后失去诊断价值；
//   - 消息去绝对路径只认三类常见根（Windows 盘符 / UNC / POSIX 系统目录），
//     相对路径与 URL 路径原样保留（诊断价值 > 过度脱敏）。

/** 诊断错误类：收口为六个固定值（P-20261124-2 评审删 cert/canceled——浏览器
 *  拿不到证书细节，取消类请求在 http.ts 提前返回不进错误环） */
export type DiagErrorClass = 'timeout' | 'network' | 'offline' | 'http4xx' | 'http5xx' | 'unknown'

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const HEX16_SEGMENT_RE = /(^|\/)[0-9a-f]{16}(?=\/|$)/gi
const PROXY_SEGMENT_RE = /(^|\/)proxy\/[^/?#]+/gi
const SHARE_S_TOKEN_RE = /(^|\/)s\/[^/?#]+/gi
const SHARE_API_TOKEN_RE = /(^|\/)(api\/)?share\/[^/?#]+/gi

// 消息里的绝对路径（去 <path>）：顺序 = 盘符 → UNC → POSIX 常见系统根。
// 只截到空白/引号/尖括号/分隔符为止——带空格路径会保留空格后的尾巴，宁可少去
// 一点（不误吞正常英文），由 500 字符截断兜底
const ABS_PATH_RES: RegExp[] = [
  /\b[A-Za-z]:[\\/][^\s"'<>|,;]*/g,
  /\\\\[^\s"'<>|,;]+/g,
  /\/(?:home|Users|root|var|tmp|opt|etc|mnt|srv|private|usr|proc|sys|dev)\/[^\s"'<>|,;]*/g,
]

/** 截断到 max 个 UTF-16 码元（与字符串长度口径一致；不做码点回退切分） */
export function truncateChars(raw: string, max: number): string {
  return raw.length <= max ? raw : raw.slice(0, max)
}

/** 把任意值安全转成字符串（Symbol / 会抛的 toString 兜底） */
function safeString(raw: unknown): string {
  try {
    return String(raw)
  } catch {
    return '[unstringifiable]'
  }
}

/**
 * URL → 诊断用路径模板：去 origin/query/fragment，已知 id 形态段模板化。
 * 输入可为绝对 URL 或相对路径；解析失败时按字符串处理（绝不抛）。
 */
export function sanitizeUrlPath(raw: string): string {
  if (!raw) return ''
  let out = raw
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(out)) {
    try {
      out = new URL(out).pathname
    } catch {
      // 非法 URL 形态：继续按相对路径清洗（保守，不原样外发）
      out = out.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    }
  }
  const cut = out.search(/[?#]/)
  if (cut >= 0) out = out.slice(0, cut)
  out = out.replace(PROXY_SEGMENT_RE, '$1proxy/:instanceId')
  out = out.replace(SHARE_API_TOKEN_RE, '$1$2share/:token')
  out = out.replace(SHARE_S_TOKEN_RE, '$1s/:token')
  out = out.replace(UUID_RE, ':id')
  out = out.replace(HEX16_SEGMENT_RE, '$1:id')
  return out
}

// WebSocket 路径的已知形态（服务端路由段）：与 sanitizeUrlPath 共用前置清洗，
// 再按通道补上语义化段名。ops/notification 属固定单例通道，无需模板化
const WS_SEGMENT_NAMES: Array<[RegExp, string]> = [
  [/(^|\/)ws\/projects\/[^/?#]+/gi, '$1ws/projects/:projectId'],
  [/(^|\/)ws\/terminal\/[^/?#]+/gi, '$1ws/terminal/:id'],
  [/(^|\/)ws\/remote-terminal\/[^/?#]+/gi, '$1ws/remote-terminal/:id'],
  [/(^|\/)ws\/deploy\/[^/?#]+/gi, '$1ws/deploy/:taskId'],
  [/(^|\/)ws\/clone\/[^/?#]+/gi, '$1ws/clone/:taskId'],
  // 远程实例经 /ws/proxy/<instanceId>/<资源>/<id> 转发：proxy 段已由
  // sanitizeUrlPath 模板化，这里补尾部资源段（终端/项目通道）
  [/(^|\/)proxy\/[^/?#]+\/terminal\/[^/?#]+/gi, '$1proxy/:instanceId/terminal/:id'],
  [/(^|\/)proxy\/[^/?#]+\/remote-terminal\/[^/?#]+/gi, '$1proxy/:instanceId/remote-terminal/:id'],
  [/(^|\/)proxy\/[^/?#]+\/projects\/[^/?#]+/gi, '$1proxy/:instanceId/projects/:projectId'],
]

/** WebSocket URL → 诊断用路径模板（协议/主机/query 一律剥离） */
export function sanitizeWsPath(raw: string): string {
  let out = sanitizeUrlPath(raw)
  for (const [re, replacement] of WS_SEGMENT_NAMES) out = out.replace(re, replacement)
  return out
}

/** 消息脱敏：绝对路径 → `<path>`，再截断到 max 字符（默认 500） */
export function sanitizeMessage(raw: unknown, max = 500): string {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : safeString(raw)
  if (!text) return ''
  let out = text
  for (const re of ABS_PATH_RES) out = out.replace(re, '<path>')
  return truncateChars(out, max)
}

/** 客户端请求关联 id：8~64 位 [A-Za-z0-9_-]，满足服务端 middleware.RequestID
 *  的上游 id 校验（8~64）。不用 crypto.randomUUID——局域网 http 非安全上下文
 *  下 crypto 随机面不可用（快速投递/opsBrowserId 同款坑） */
export function newClientRequestId(): string {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(6, '0')
  return `sc-${Date.now().toString(36)}-${rand}`
}

/** axios 错误 → 诊断错误类（六个固定值）。online=false 优先归 offline；
 *  timeout 只看浏览器等待上限（ECONNABORTED/ETIMEDOUT），真实服务端耗时看 rid */
export function diagErrorClassOf(
  err: { code?: string; message?: string; response?: { status?: number } } | null | undefined,
  online: boolean = typeof navigator === 'undefined' ? true : navigator.onLine !== false,
): DiagErrorClass {
  if (online === false) return 'offline'
  if (!err) return 'unknown'
  const code = err.code ?? ''
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(err?.message ?? '')) return 'timeout'
  const status = err?.response?.status ?? 0
  if (!status) return 'network'
  if (status >= 500) return 'http5xx'
  if (status >= 400) return 'http4xx'
  return 'unknown'
}
