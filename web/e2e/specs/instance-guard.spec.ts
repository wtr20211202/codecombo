import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 实例登记守卫 E2E（API 层）：
 * 自引用 URL（指向本机服务自身）登记实例会被 400 拒绝——防止代理把请求
 * 转发回自己形成自环。合法远程 URL 仍可正常登记后清理。
 */

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

test('登记自引用 URL → 400 拒绝且实例不产生', async ({ request }) => {
  const headers = await unlockHeaders()

  // 记录登记前实例数
  const beforeList = await (await request.get(`${API_BASE}/api/instances`, { headers })).json()
  const before = ((beforeList?.data || []) as unknown[]).length

  // 各种形态的自引用 URL 全部拒绝（不同 host 写法均指向本服务）；端口必须取
  // API_BASE 自身——服务端按「与当前请求端口一致」判自引用，写死历史端口在
  // 隔离端口运行 e2e 时会落到普通远程地址上，登记不再被拒
  const baseUrl = new URL(API_BASE)
  const selfPort = baseUrl.port || (baseUrl.protocol === 'https:' ? '443' : '80')
  for (const url of [
    `${API_BASE}/`,
    `http://localhost:${selfPort}`,
    `http://127.0.0.1:${selfPort}`,
  ]) {
    const res = await request.post(`${API_BASE}/api/instances`, {
      headers, data: { name: `self-ref-${Math.random().toString(36).slice(2, 6)}`, url },
    })
    expect(res.status(), `自引用 ${url} 应被拒绝`).toBe(400)
  }

  const afterList = await (await request.get(`${API_BASE}/api/instances`, { headers })).json()
  const after = ((afterList?.data || []) as unknown[]).length
  expect(after).toBe(before)
})

test('登记合法远程 URL → 成功创建后可删除', async ({ request }) => {
  const headers = await unlockHeaders()
  const name = `e2e-remote-ok-${Math.random().toString(36).slice(2, 6)}`

  const create = await request.post(`${API_BASE}/api/instances`, {
    headers, data: { name, url: 'http://localhost:9998', parentId: 'local' },
  })
  expect(create.ok()).toBeTruthy()
  const created = ((await create.json()) as { data?: { id?: string } }).data

  const list = await (await request.get(`${API_BASE}/api/instances`, { headers })).json()
  expect(((list?.data || []) as Array<{ name: string }>).some(i => i.name === name)).toBe(true)

  // 清理
  if (created?.id) {
    const del = await request.delete(`${API_BASE}/api/instances/${created.id}`, { headers })
    expect(del.ok()).toBeTruthy()
  }
})
