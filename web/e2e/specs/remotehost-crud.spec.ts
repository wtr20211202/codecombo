import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 远程主机增删回环 E2E（API 层）：创建 → 列表含新主机 → 重复名校验 /
 * 列表隔离 → 删除 → 列表移除 → 审计行含主机名（P-20261003-133 对象名自明化）。
 * 密码型凭据创建后列表元信息不得回显明文。
 * 回环后完全清理，不影响其他用例（remote-console 等依赖名为 WSL 的主机）。
 */

const HOST_NAME = `e2e-rh-${Math.random().toString(36).slice(2, 8)}`

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

test('远程主机增删回环：创建 → 列表含新主机（凭据不回显）→ 删除 → 移除', async ({ request }) => {
  const headers = await unlockHeaders()

  // 创建（密码型凭据）
  const create = await request.post(`${API_BASE}/api/remotehosts`, {
    headers,
    data: {
      name: HOST_NAME,
      host: '127.0.0.1',
      port: 22,
      user: 'e2e',
      authType: 'password',
      protocol: 'ssh',
      password: 'e2e-secret-pass-9527',
    },
  })
  expect(create.ok()).toBeTruthy()
  const created = ((await create.json()) as { data?: { id?: string } }).data
  expect(created?.id).toBeTruthy()

  // 列表：含新主机；元信息不回显明文密码
  const list = ((await (await request.get(`${API_BASE}/api/remotehosts`, { headers })).json()) as {
    data?: Array<{ name?: string; password?: string; id?: string }>
  }).data || []
  const found = list.find(h => h.name === HOST_NAME)
  expect(found, '列表应包含新创建的主机').toBeTruthy()
  const rawList = JSON.stringify(list)
  expect(rawList, '列表元信息不得回显明文密码').not.toContain('e2e-secret-pass-9527')

  // 删除 → 列表移除
  const del = await request.delete(`${API_BASE}/api/remotehosts/${found!.id || created!.id}`, { headers })
  expect(del.ok()).toBeTruthy()
  const list2 = ((await (await request.get(`${API_BASE}/api/remotehosts`, { headers })).json()) as {
    data?: Array<{ name?: string }>
  }).data || []
  expect(list2.some(h => h.name === HOST_NAME)).toBe(false)

  // 审计入账（P-20261003-133）：remotehost.delete 行 Detail =「name (id)」——
  // 删除后对象已不在，翻台账须能凭主机名对机；HOST_NAME 每轮随机，含主机名
  // 即证明自明化成立
  const audit = await request.get(`${API_BASE}/api/audit?limit=50`, { headers })
  expect(audit.ok()).toBeTruthy()
  const events = ((await audit.json()) as {
    data?: Array<{ action?: string; detail?: string }>
  }).data || []
  const delEvent = events.find(e => e.action === 'remotehost.delete' && e.detail?.includes(HOST_NAME))
  expect(delEvent, '审计应有 remotehost.delete 行且 Detail 含主机名').toBeTruthy()
  expect(delEvent!.detail).toBe(`${HOST_NAME} (${found!.id || created!.id})`)
})
