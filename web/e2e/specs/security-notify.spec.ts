import { test, expect } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 破坏性安全操作的通知回执（P-20261003-54）E2E：
 *   - 删除远程主机：审计之外同位产即时回执——webhook 接收端（important 范围
 *     含 warning）收到含对象名的推送，通知中心 UI 出现 i18n 模板渲染的条目
 *   - Agent Token 轮换：通知回执 titleKey/bodyKey + 来源 IP 入 msgParams
 *   - SSH 指纹重置：同上，标题含对象名（幂等：未钉扎也回执）
 * 通知/偏好为服务端全局状态：beforeAll 快照+清空、afterAll 还原+清空；
 * 自建主机用随机名并在用例内删除，不触碰共享实例的 WSL 记录。
 */

interface RecvRequest {
  method: string
  path: string
  body: string
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getPrefs(headers: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/api/notifications/prefs`, { headers })
  return (await res.json()) as Record<string, unknown>
}

async function putPrefs(headers: Record<string, string>, prefs: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API_BASE}/api/notifications/prefs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(prefs),
  })
  expect(res.ok).toBeTruthy()
}

// webhook 段覆盖 + 全类别打开（Add 落库本身会被类别开关挡掉，测试需可落库）
function withWebhook(prefs: Record<string, unknown>, webhook: Record<string, unknown>): Record<string, unknown> {
  return {
    ...prefs,
    enabled: { git: true, task: true, clone: true, system: true, error: true },
    webhook,
  }
}

// 测试进程内起 webhook 接收端（后端外发落点，同 notify-webhook.spec 手法）
async function startReceiver() {
  const requests: RecvRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      requests.push({
        method: req.method || '',
        path: req.url?.split('?')[0] || '',
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200)
      res.end('ok')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const waitFor = async (pred: (r: RecvRequest) => boolean, timeoutMs = 5000): Promise<RecvRequest> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = requests.find(pred)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`receiver request not arrived within ${timeoutMs}ms; got ${JSON.stringify(requests)}`)
      await new Promise(r => setTimeout(r, 100))
    }
  }
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    waitFor,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

async function listNotifications(headers: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  expect(res.ok).toBeTruthy()
  return ((await res.json()) as { data?: Array<Record<string, unknown>> }).data || []
}

async function createHost(headers: Record<string, string>, name: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/remotehosts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name, host: '127.0.0.1', port: 22, user: 'e2e',
      authType: 'password', protocol: 'ssh', password: 'e2e-sec-pass',
    }),
  })
  expect(res.ok).toBeTruthy()
  const id = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(id).toBeTruthy()
  return id
}

let headers: Record<string, string>
let prefsSnapshot: Record<string, unknown>

test.beforeAll(async () => {
  headers = await unlockHeaders()
  prefsSnapshot = await getPrefs(headers)
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  if (prefsSnapshot && Object.keys(prefsSnapshot).length > 0) {
    await putPrefs(headers, prefsSnapshot)
  }
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('删除主机：webhook 外发命中（warning 落 important 范围）+ 通知中心条目含对象名', async ({ page }) => {
  const rx = await startReceiver()
  const hostName = `e2e-sec-del-${Math.random().toString(36).slice(2, 8)}`
  try {
    await putPrefs(headers, withWebhook(prefsSnapshot, {
      enabled: true, mode: 'post', url: `${rx.base}/hook`, scope: 'important',
    }))

    const hostId = await createHost(headers, hostName)
    const del = await fetch(`${API_BASE}/api/remotehosts/${hostId}`, { method: 'DELETE', headers })
    expect(del.ok).toBeTruthy()

    // webhook 外发：标题含对象名，body 带主机摘要与来源 IP
    const hit = await rx.waitFor(r => r.body.includes(hostName))
    expect(hit.method).toBe('POST')
    const payload = JSON.parse(hit.body) as Record<string, string>
    expect(payload.title).toContain('远程主机已删除')
    expect(payload.title).toContain(hostName)
    expect(payload.body).toContain('e2e@127.0.0.1:22')
    expect(payload.body).toContain('来源 IP')

    // 通知中心 UI：i18n 模板渲染的条目（titleKey audit.notify.hostDelete.title）
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    await page.locator('button[title="通知中心"]').first().click()
    await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
    await expect(
      page.locator('.nc-item:not(.nc-sub)').filter({ hasText: hostName }).first(),
    ).toContainText('远程主机已删除', { timeout: 3000 })
  } finally {
    await rx.close()
  }
})

test('Agent Token 轮换：通知回执带来源 IP（titleKey + msgParams 断言）', async () => {
  const res = await fetch(`${API_BASE}/api/agent-token/rotate`, { method: 'POST', headers })
  expect(res.ok).toBeTruthy()

  const list = await listNotifications(headers)
  const n = list.find(x => x.titleKey === 'audit.notify.agentTokenRotate.title')
  expect(n, '轮换应产通知回执').toBeTruthy()
  expect(n!.type).toBe('warning')
  expect(String(n!.title)).toContain('Agent')
  const params = (n!.msgParams ?? {}) as Record<string, unknown>
  expect(String(params.ip ?? ''), '来源 IP 应入 msgParams').not.toBe('')
  expect(String(n!.body)).toContain('来源 IP')
})

test('SSH 指纹重置：通知回执标题含对象名 + 来源 IP（未钉扎幂等）', async () => {
  const hostName = `e2e-sec-fp-${Math.random().toString(36).slice(2, 8)}`
  const hostId = await createHost(headers, hostName)
  try {
    const res = await fetch(`${API_BASE}/api/remotehosts/${hostId}/hostkey/reset`, { method: 'POST', headers })
    expect(res.ok).toBeTruthy()

    const list = await listNotifications(headers)
    const n = list.find(x => x.titleKey === 'audit.notify.hostkeyReset.title')
    expect(n, '指纹重置应产通知回执').toBeTruthy()
    expect(n!.type).toBe('warning')
    expect(String(n!.title)).toContain(hostName)
    const params = (n!.msgParams ?? {}) as Record<string, unknown>
    expect(String(params.ip ?? ''), '来源 IP 应入 msgParams').not.toBe('')
    expect(String(params.name)).toBe(hostName)
  } finally {
    // 清理自建主机（删除动作本身产的回执由 afterAll 清空兜底）
    await fetch(`${API_BASE}/api/remotehosts/${hostId}`, { method: 'DELETE', headers })
  }
})
