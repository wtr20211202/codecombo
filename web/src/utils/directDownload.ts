/**
 * 同源直链下载（P-20261030-2）：文件树导出点 blob 反模式直链化。
 *
 * blob 反模式的代价（旧 useFileTreeContext 实现）：responseType:'blob' +
 * timeout:0 把整个响应读进内存才触发保存——1GB 级文件下载期间应用内零反馈、
 * 内存峰值等于文件大小。直链（<a href> 程序化点击）把传输交还浏览器：下载条
 * 原生进度、流式落盘（内存常量）、失败有浏览器级错误显示。
 *
 * 鉴权语义（实施时服务端核验结论，直链可行的基础）：
 *   - 锁保护组 LockMiddlewareWithCookie 按「头 > cookie」回退，同源原生 GET
 *     自动携带 HttpOnly sc_lock_token cookie（P-20261019-2 cookie 载体）；
 *   - TokenAuthMiddleware 无 Authorization 头时放行（本机 UI 直连形态）；
 *   - LockCSRF 只拦写方法，GET 直链不受限；
 *   - 远程实例走回环代理 /proxy/<id>/api，代理侧注入 Bearer 实例令牌。
 *
 * 与 frontendAtomActions.handleFrontendDownload（P-20261023-4 ops 原子）同形；
 * 本模块补齐实例感知 URL 构造与失败预检，供文件树多处导出点共用。
 */
import { getCurrentInstanceContext } from '../api/http'
import { getUnlockToken } from '../stores/lock'

/** 批量归档 paths 数组 query 手工序列化：axios 默认序列化成 paths[]=，与
 *  服务端 QueryArray 形态不匹配（原 git.ts 内联实现迁此，直链构造共用） */
export function filesArchivePathsQuery(paths: string[]): string {
  return paths.map(p => `paths=${encodeURIComponent(p)}`).join('&')
}

/** 当前实例的 API 基址：本机同源 /api，远程实例回环代理 /proxy/<id>/api。
 *  与 axios 实例改写拦截器 / instanceFetchRaw 同语义——远程项目的文件树直链
 *  必须落在代理路径上，写 /api 会打到本机实例 404 */
export function instanceApiBase(): string {
  const { instanceId, isRemote } = getCurrentInstanceContext()
  return isRemote && instanceId ? `/proxy/${instanceId}/api` : '/api'
}

/** 单文件下载直链（GET /projects/:id/file/download?path=） */
export function fileDownloadUrl(projectId: string, path: string): string {
  return `${instanceApiBase()}/projects/${encodeURIComponent(projectId)}/file/download?path=${encodeURIComponent(path)}`
}

/** 目录打包直链（GET /projects/:id/dir-archive?path=[&override=1]）；
 *  响应恒 application/zip + 附件头（敏感拦回走 409，不落假包） */
export function dirArchiveUrl(projectId: string, path: string, override = false): string {
  const q = new URLSearchParams({ path })
  if (override) q.set('override', '1')
  return `${instanceApiBase()}/projects/${encodeURIComponent(projectId)}/dir-archive?${q.toString()}`
}

/** 多选批量归档直链（GET /projects/:id/files-archive?paths=…[&override=1]） */
export function filesArchiveUrl(projectId: string, paths: string[], override = false): string {
  const suffix = override ? '&override=1' : ''
  return `${instanceApiBase()}/projects/${encodeURIComponent(projectId)}/files-archive?${filesArchivePathsQuery(paths)}${suffix}`
}

/** 程序化点击直链（frontendAtomActions 同款形态：先入 DOM 再 click——Firefox
 *  对游离锚点的 click 不触发导航）。Content-Disposition（服务端净化链）是
 *  保存名权威，download 属性只兜头缺失的形态 */
export function triggerDirectDownload(url: string, fallbackName: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = fallbackName
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * 直链失败预检：浏览器原生下载失败只体现在下载条（应用内无感知——「点了
 * 没反应」的另一面），确定性失败（文件已被删/路径越界/锁定）提前拦下交给
 * 调用方 toast。探测用 1 字节 Range GET 而非 HEAD：gin 路由严格按方法匹配，
 * GET 端点对 HEAD 返回 404；Range=0-0 走的正是真实下载的同一条服务端路径
 * （c.File/ServeFile 的 Range 语义），单文件下载端点零新增服务端面。
 * 返回 null = 预检通过；数字 = HTTP 状态码；0 = 网络层失败。
 */
export async function precheckDownload(url: string): Promise<number | null> {
  const token = getUnlockToken() || ''
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
        ...(token ? { 'X-Lock-Token': token } : {}),
      },
    })
    // 响应体（至多 1 字节）即刻释放，不留给浏览器缓冲
    await res.body?.cancel().catch(() => {})
    if (res.ok) return null
    return res.status
  } catch {
    return 0
  }
}
