import { test, expect } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知外发 webhook（P-20261002-31）E2E：
 *   - POST JSON 模式：error 通知（important 范围）→ 本文件内起的 Node HTTP
 *     接收端收到 {"title","body"}；info 通知被过滤不外发
 *   - GET 模板插值：{title}/{body} 以查询参数转义落到 all 范围的 info 通知
 *   - 审批挂起：POST /api/ops-confirm 广播 approval.pending → 总线 → webhook
 *     接收端收到审批推送（人在环最后一公里的主场景）
 *   - 发送测试推送：/api/notifications/webhook-test 走已保存偏好同步外发；
 *     未启用时 400 + 原因
 *   - 设置页 UI：外部推送段开关/URL/测试按钮全链路（按钮先保存再测试）
 * 接收端 = 测试进程内的 http.createServer（后端进程外发到 127.0.0.1 随机口）。
 * webhook 偏好为服务端全局状态：beforeAll 快照、afterAll 还原，不污染共享实例。
 */

interface RecvRequest {
  method: string
  path: string
  rawQuery: string
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

// webhook 偏好段覆盖（其余字段继承快照），并把全部类别打开——important 范围
// 之外的过滤不依赖类别开关，但 Add 落库本身会被类别开关挡掉，测试需可落库
function withWebhook(prefs: Record<string, unknown>, webhook: Record<string, unknown>): Record<string, unknown> {
  return {
    ...prefs,
    enabled: { git: true, task: true, clone: true, system: true, error: true },
    webhook,
  }
}

async function seed(headers: Record<string, string>, n: { type: string; category: string; title: string; body?: string }): Promise<void> {
  const res = await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST',
    headers,
    body: JSON.stringify(n),
  })
  expect(res.ok).toBeTruthy()
}

// 测试进程内起接收端（后端 webhook 外发的落点，等价 Go 单测的 httptest.Server）
async function startReceiver() {
  const requests: RecvRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      requests.push({
        method: req.method || '',
        path: req.url?.split('?')[0] || '',
        rawQuery: req.url?.split('?')[1] || '',
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200)
      res.end('ok')
    })
  })
  // listen 异步：等 listening 事件后 address() 才有端口
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
  const expectNone = async (timeoutMs = 1500): Promise<void> => {
    await new Promise(r => setTimeout(r, timeoutMs))
  }
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    waitFor,
    expectNone,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

let headers: Record<string, string>
let prefsSnapshot: Record<string, unknown>

// 服务端 → 测试侧监听可达性金丝雀（P-20261005-187）：接收端绑在测试进程
// 127.0.0.1 随机口，跨拓扑（WSL NAT）下服务端 127.0.0.1 是自身环回，结构性
// 不可达（镜像网络形态可达）。beforeAll 以 webhook-test 同步外发实测判定，
// 不可达时四条用例整体 skip——环境边界而非用例失败，且镜像网络机器自动恢复实跑
let deliverable = true

async function probeDeliverable(): Promise<boolean> {
  const rx = await startReceiver()
  try {
    await putPrefs(headers, withWebhook(prefsSnapshot, {
      enabled: true, mode: 'post', url: `${rx.base}/canary`, scope: 'all',
    }))
    const ok = await fetch(`${API_BASE}/api/notifications/webhook-test`, { method: 'POST', headers })
    // 已启用态下非 200 = 同步试发失败（跨拓扑 NAT 拒连即此形态，实测 400 携
    // dial tcp refused）→ 不可达；200 且接收端真的收到才算可达（防半开形态）
    if (!ok.ok) return false
    try {
      await rx.waitFor(r => r.path === '/canary', 4000)
      return true
    } catch {
      return false
    }
  } finally {
    await putPrefs(headers, prefsSnapshot).catch(() => { /* 还原失败由 afterAll 兜底 */ })
    await rx.close()
  }
}

test.beforeAll(async () => {
  headers = await unlockHeaders()
  prefsSnapshot = await getPrefs(headers)
  deliverable = await probeDeliverable()
  if (!deliverable) {
    console.warn('[e2e-wh] 服务端外发不可达测试侧接收端（跨拓扑 NAT？）——webhook 用例 skip')
  }
})

test.afterAll(async () => {
  if (prefsSnapshot && Object.keys(prefsSnapshot).length > 0) {
    await putPrefs(headers, prefsSnapshot)
  }
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('POST 模式：error 通知外发 JSON，info 通知被 important 范围过滤', async () => {
  test.skip(!deliverable, '服务端外发不可达测试侧接收端（跨拓扑 NAT 边界，镜像网络可跑）——P-20261005-187')
  const rx = await startReceiver()
  try {
    await putPrefs(headers, withWebhook(prefsSnapshot, {
      enabled: true, mode: 'post', url: `${rx.base}/hook?key=secret`, scope: 'important',
    }))

    await seed(headers, { type: 'error', category: 'task', title: 'e2e-wh-失败推送', body: 'e2e-wh-正文' })
    const hit = await rx.waitFor(r => r.path === '/hook')
    expect(hit.method).toBe('POST')
    const payload = JSON.parse(hit.body) as Record<string, string>
    expect(payload.title).toBe('e2e-wh-失败推送')
    expect(payload.body).toBe('e2e-wh-正文')

    // important 范围（默认）：info 类通知不外发
    await seed(headers, { type: 'info', category: 'git', title: 'e2e-wh-普通通知' })
    await rx.expectNone()
    expect(rx.requests.filter(r => r.body.includes('e2e-wh-普通通知'))).toHaveLength(0)
  } finally {
    await rx.close()
  }
})

test('GET 模板：{title}/{body} 查询参数插值，all 范围全量外发', async () => {
  test.skip(!deliverable, '服务端外发不可达测试侧接收端（跨拓扑 NAT 边界，镜像网络可跑）——P-20261005-187')
  const rx = await startReceiver()
  try {
    await putPrefs(headers, withWebhook(prefsSnapshot, {
      enabled: true, mode: 'get', url: `${rx.base}/get?title={title}&body={body}`, scope: 'all',
    }))

    await seed(headers, { type: 'info', category: 'git', title: 'e2e-wh-GET 推送', body: 'a&b=c' })
    const hit = await rx.waitFor(r => r.path === '/get')
    expect(hit.method).toBe('GET')
    const params = new URLSearchParams(hit.rawQuery)
    expect(params.get('title')).toBe('e2e-wh-GET 推送')
    expect(params.get('body')).toBe('a&b=c')
  } finally {
    await rx.close()
  }
})

test('审批挂起外发 + 测试推送端点（未启用时报配置错误）', async () => {
  test.skip(!deliverable, '服务端外发不可达测试侧接收端（跨拓扑 NAT 边界，镜像网络可跑）——P-20261005-187')
  const rx = await startReceiver()
  try {
    await putPrefs(headers, withWebhook(prefsSnapshot, {
      enabled: true, mode: 'post', url: `${rx.base}/hook`, scope: 'important',
    }))

    // 审批挂起：approval.pending 广播 → 总线 → webhook（important 范围含审批）
    const created = await fetch(`${API_BASE}/api/ops-confirm`, {
      method: 'POST', headers,
      body: JSON.stringify({ op: 'e2e.webhook.op', target: '/tmp/e2e-target', detail: 'e2e-webhook-审批明细' }),
    })
    expect(created.ok).toBeTruthy()
    const approvalId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''

    const hit = await rx.waitFor(r => r.path === '/hook')
    const payload = JSON.parse(hit.body) as Record<string, string>
    expect(payload.title).toContain('审批挂起')
    expect(payload.body).toContain('e2e.webhook.op')
    expect(payload.body).toContain('/tmp/e2e-target')

    // 清账：拒绝该审批（broadcast approval.resolved，不留卡片给后续用例）
    if (approvalId) {
      await fetch(`${API_BASE}/api/ops-confirm/${approvalId}/resolve`, {
        method: 'POST', headers, body: JSON.stringify({ allow: false }),
      })
    }

    // 测试推送：走已保存偏好同步外发
    const ok = await fetch(`${API_BASE}/api/notifications/webhook-test`, { method: 'POST', headers })
    expect(ok.ok).toBeTruthy()
    expect(((await ok.json()) as { ok?: boolean }).ok).toBe(true)
    await rx.waitFor(r => r.body.includes('Test Push'))

    // 未启用：400 + 原因（前端按钮展示该消息）
    await putPrefs(headers, withWebhook(prefsSnapshot, { enabled: false, mode: 'post', url: '', scope: 'important' }))
    const bad = await fetch(`${API_BASE}/api/notifications/webhook-test`, { method: 'POST', headers })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error?: string }).error).toBeTruthy()
  } finally {
    await rx.close()
  }
})

test('设置页 UI：外部推送段开关/URL/测试按钮全链路', async ({ page }) => {
  test.skip(!deliverable, '服务端外发不可达测试侧接收端（跨拓扑 NAT 边界，镜像网络可跑）——P-20261005-187')
  const rx = await startReceiver()
  try {
    await putPrefs(headers, withWebhook(prefsSnapshot, {
      enabled: false, mode: 'post', url: '', scope: 'important',
    }))

    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    await page.locator('button[title="通知中心"]').first().click()
    await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
    // 通知偏好快捷入口直达设置通知页签（与 notification-center.spec 同一入口）
    await page.locator('.nc-action-btn').first().click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })

    const pane = page.locator('.settings-modal .content-pane:visible')
    await expect(pane.locator('.setting-row', { hasText: '外部推送' })).toBeVisible()

    // 开启外部推送 → 字段区展开
    await pane.locator('.setting-row', { hasText: '外部推送' }).locator('.n-checkbox').click()
    const fields = pane.locator('.webhook-fields')
    await expect(fields).toBeVisible()

    // 默认 POST + 审批挂起与失败（服务端归一化默认值）
    await expect(fields.locator('.n-select').first()).toContainText('POST JSON')
    await expect(fields.locator('.n-select').nth(1)).toContainText('审批挂起与失败')

    // 填接收端 URL → 测试按钮（先保存当前编辑再同步外发）
    await fields.locator('input').fill(`${rx.base}/hook`)
    await fields.getByRole('button', { name: '发送测试推送' }).click()
    await expect(fields.locator('.permission-status.granted')).toContainText('✓', { timeout: 8000 })
    await rx.waitFor(r => r.body.includes('Test Push'))
  } finally {
    await rx.close()
  }
})
