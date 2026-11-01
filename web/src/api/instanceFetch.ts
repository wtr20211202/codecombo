import { getUnlockToken } from '../stores/lock'

/**
 * 实例统一 fetch 通道：本机同源 /api，远程回环代理 /proxy/<id>/api（带锁令牌）。
 * 与 axios 拦截器的实例改写语义一致，供绕过 axios 的调用方使用
 * （多实例总览/输出查看器等需要原生 Response 或轻量 JSON 的场景）。
 */
export function instanceFetchRaw(instanceId: string, method: string, path: string, body?: unknown): Promise<Response> {
  const base = instanceId === 'local' ? '/api' : `/proxy/${instanceId}/api`
  // 令牌读内存态（P-20261019-2）：同源请求即使缺头也有 HttpOnly cookie 兜底
  const token = getUnlockToken() || ''
  return fetch(base + path, {
    method,
    headers: {
      ...(token ? { 'X-Lock-Token': token } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

/** JSON 便捷封装：非 2xx 抛错，2xx 返回解析后的 body */
export async function instanceFetch<T>(instanceId: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await instanceFetchRaw(instanceId, method, path, body)
  if (!res.ok) throw new Error(String(res.status))
  return (await res.json()) as T
}
