import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 部署失败通知「交给智能体修复」（P-20261003-289）E2E：
 * 真实后端流种失败部署——注册指向不可达端口的主机（127.0.0.1:1 SSH 拒连秒
 * 失败）→ 触发部署 → 任务数秒 failed → 终态通知携 agent-fix 动作（payload=
 * 任务 id）。锁定三段契约：
 *   1. 通知中心行出现行内「交给智能体修复」按钮（入口可发现，整行点击同义）；
 *   2. 点击 → 拦截 POST /api/terminals：kind=agent 且 launchArgs 含主机名
 *      （remotehosts 按 hostId 解析）、主机地址、错误摘要段（ssh dial）、任务
 *      id 自取锚点行（GET /api/deploy/<taskId>，agent 可自行补拉完整参数）；
 *   3. 发起后 docked 管理页打开（P-109 修复链收口语义不变）。
 * 兼容契约：成功部署通知保持 panel:deploy（notify-jump.spec 锁定）。失败部署
 * 通知的主动作自本提案起为 agent-fix——失败现场最需要的动作是修复而非跳页。
 * 首页通知中心的动作消费在 Layout（/project 路由）挂载的 pendingAction watch
 * ——既有边界（各跳转型动作同此），本 spec 沿 notify-jump 先例先进项目页。
 */

const HOST_NAME = 'e2e-agent-fix'
const DEAD_PORT = 1 // 127.0.0.1:1 无人监听，ssh dial 立即拒绝

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理本 spec 产生的 agent 会话（断言基于创建链，不与残留会话混淆） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  const hosts = await (await fetch(`${API_BASE}/api/remotehosts`, { headers })).json()
  for (const h of ((hosts?.data || []) as { id: string; name: string }[])) {
    if (h.name === HOST_NAME) {
      await fetch(`${API_BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
    }
  }
  await cleanupTerminals(request)
})

test('失败部署通知 → 行内修复动作 → 点击发起 agent 会话（launchArgs 含主机名+错误摘要段）', async ({ page, request }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders(request)
  // 通知中心是跨用例共享的服务端域：先清空再播种，断言与清空后状态对齐
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await cleanupTerminals(request)

  // 种失败部署：不可达端口主机 → 触发 → 轮询至 failed（真实终态通知流）
  const createRes = await fetch(`${API_BASE}/api/remotehosts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: HOST_NAME, host: '127.0.0.1', port: DEAD_PORT, user: 'e2e', authType: 'password', password: 'e2e' }),
  })
  expect(createRes.ok).toBeTruthy()
  const hostId = ((await createRes.json()) as { data?: { id?: string } }).data?.id || ''
  expect(hostId).toBeTruthy()

  const trigRes = await fetch(`${API_BASE}/api/deploy`, {
    method: 'POST',
    headers,
    // deployerId 随 P-20261025-1 运行时标识切换改名 simple_coding → codecombo
    //（server/deploy/codecombo.go ID()）；旧名在 ResolvePlan 即 unknown deployer 拒绝
    body: JSON.stringify({ hostId, instances: [{ deployerId: 'codecombo', params: {} }] }),
  })
  expect(trigRes.ok).toBeTruthy()
  const taskId = ((await trigRes.json()) as { taskId?: string }).taskId || ''
  expect(taskId).toBeTruthy()

  let status = ''
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${API_BASE}/api/deploy/${taskId}`, { headers })
    status = ((await r.json()) as { data?: { status?: string } }).data?.status || ''
    if (status === 'failed' || status === 'completed' || status === 'cancelled') break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  expect(status).toBe('failed')

  // 进项目页（pendingAction 消费面挂载在 Layout）→ 打开通知中心
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })

  // 失败部署通知行出现，行内动作按钮「交给智能体修复」可见（入口可发现）
  const row = page.locator('.nc-item').filter({ hasText: '部署失败' }).filter({ hasText: HOST_NAME }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row).toContainText('ssh dial')
  const fixBtn = row.locator('.nc-inline-action', { hasText: '交给智能体修复' })
  await expect(fixBtn).toBeVisible()

  // 拦截创建请求：kind=agent 且 launchArgs 含主机名/地址/错误摘要段/任务自取锚点
  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await fixBtn.click()
  const req = await reqPromise
  expect(req.url()).toContain('/api/terminals')
  const body = req.postDataJSON() as { kind?: string; launchArgs?: string }
  expect(body.kind, '请求体 kind=agent').toBe('agent')
  for (const part of [HOST_NAME, `127.0.0.1:${DEAD_PORT}`, 'ssh dial', taskId, 'GET /api/deploy/']) {
    expect(body.launchArgs, `launchArgs 含「${part}」`).toContain(part)
  }

  // docked 管理页打开（修复链收口：创建 → 激活 → 打开）
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1, { timeout: 15000 })
})
