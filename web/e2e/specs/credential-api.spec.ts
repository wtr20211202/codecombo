import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 凭据 API E2E（凭据安全横切面）：
 *   - 保存：host 自动识别平台（github.com → github tag 语义）
 *   - 列表：secret 明文不回显（凭据安全断言）
 *   - 同 host+username 保存 = 更新（幂等，不产生重复条目）
 *   - 缺 host/username → 400
 * 每用例自清理（凭据 store 是共享实例全局状态）。
 */

const SUFFIX = Math.random().toString(36).slice(2, 8)

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function listCredentials(request: import('@playwright/test').APIRequestContext, headers: Record<string, string>) {
  const res = await request.get(`${API_BASE}/api/credentials`, { headers })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data?: Array<{ id?: string; host?: string; username?: string; secret?: string }> }).data || []
}

test.afterEach(async ({ request }) => {
  const headers = await unlockHeaders()
  const list = await listCredentials(request, headers)
  for (const c of list) {
    if (c.username?.includes('e2e-cred')) {
      await request.delete(`${API_BASE}/api/credentials/${c.id}`, { headers })
    }
  }
})

test('凭据保存：host 自动识别平台 + secret 不回显 + 同 host+username 更新', async ({ request }) => {
  const headers = await unlockHeaders()
  const username = `e2e-cred-${SUFFIX}`

  // 保存 github.com 凭据（host 自动识别平台）
  const save = await request.post(`${API_BASE}/api/credentials`, {
    headers, data: { host: 'https://github.com', username, secret: 'ghp-e2e-secret' },
  })
  expect(save.ok()).toBeTruthy()

  const list = await listCredentials(request, headers)
  const mine = list.filter(c => c.username === username)
  expect(mine.length, '同 host+username 应只有一条（更新语义）').toBe(1)
  expect(mine[0]!.host).toContain('github.com')
  // secret 明文不得回显
  expect(JSON.stringify(list)).not.toContain('ghp-e2e-secret')

  // 同 host+username 再保存 → 更新而非新增
  const save2 = await request.post(`${API_BASE}/api/credentials`, {
    headers, data: { host: 'https://github.com', username, secret: 'ghp-e2e-rotated' },
  })
  expect(save2.ok()).toBeTruthy()
  const list2 = await listCredentials(request, headers)
  expect(list2.filter(c => c.username === username).length).toBe(1)
})

test('凭据保存：缺 host 或 username → 400', async ({ request }) => {
  const headers = await unlockHeaders()

  const noHost = await request.post(`${API_BASE}/api/credentials`, {
    headers, data: { username: 'e2e-cred-x' },
  })
  expect(noHost.status()).toBe(400)

  const noUser = await request.post(`${API_BASE}/api/credentials`, {
    headers, data: { host: 'https://github.com' },
  })
  expect(noUser.status()).toBe(400)
})
