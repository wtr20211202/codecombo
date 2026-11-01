import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 部署日志留档下载（P-20261003-142）E2E：GET /api/deploy/:taskId/log——
 * 服务端内存日志环直出 txt 附件（终态 1h 内存窗）。真实部署依赖远端 SSH，
 * 本 spec 沿 deploy-rerun 先例种「注定失败」任务（127.0.0.1:1 拒连秒失败），
 * logBuf 留下真实的 start/done 日志行。锁定三段契约：
 *   1. API 链路：未知任务 404；窗内任务 200 + 附件头 + 留档体含已知步骤行；
 *   2. 部署详情（历史行）「日志」入口 → 下载文件含 task started 已知行；
 *   3. 失败部署通知行内「日志」第二入口 → 下载同链（主动作 agent-fix 不回退）。
 * 1h 窗外语义由 Go 测试锁定（留档落盘后窗外读路是回源落盘或 410 兜底，e2e
 * 侧由 deploy-log-persist.spec 覆盖；本 spec 无法在用例内等待内存过期）；
 * UI 过期提示走同一下载链的就地 blob 解析
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE
const HOST_NAME = 'deploy-log-dl'
const DEAD_PORT = 1
const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-deploy-log-download')

interface HostMeta { id: string; name: string; host: string }

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// 幂等造主机 + 触发死端口部署并等到 failed（拒连秒失败，任务记录与日志照常落）
async function seedFailedDeploy(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<{ hostId: string; taskId: string }> {
  const hosts = await (await request.get(`${BASE}/api/remotehosts`, { headers })).json()
  let host = ((hosts?.data || []) as HostMeta[]).find(h => h.name === HOST_NAME)
  if (!host) {
    const createRes = await fetch(`${BASE}/api/remotehosts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: HOST_NAME, host: '127.0.0.1', port: DEAD_PORT, user: 'e2e', authType: 'password', password: 'e2e' }),
    })
    expect(createRes.ok).toBeTruthy()
    host = ((await createRes.json()) as { data?: HostMeta }).data
  }
  expect(host?.id).toBeTruthy()

  const trigRes = await fetch(`${BASE}/api/deploy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      hostId: host!.id,
      // init_ssh_key 的 email 为必填无默认（服务端 ResolvePlan 前置校验），显式给全
      instances: [{ deployerId: 'init_ssh_key', params: { keyName: 'id_ed25519', email: 'e2e@example.com', gitHost: 'github.com' } }],
    }),
  })
  expect(trigRes.ok).toBeTruthy()
  const taskId = ((await trigRes.json()) as { taskId?: string }).taskId || ''
  expect(taskId).toBeTruthy()

  let status = ''
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/deploy/${taskId}`, { headers })
    status = ((await r.json()) as { data?: { status?: string } }).data?.status || ''
    if (status === 'failed' || status === 'completed' || status === 'cancelled') break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  expect(status).toBe('failed')
  return { hostId: host!.id, taskId }
}

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  await fetch(`${BASE}/api/notifications/clear`, { method: 'POST', headers })
  const hosts = await (await fetch(`${BASE}/api/remotehosts`, { headers })).json()
  for (const h of ((hosts?.data || []) as HostMeta[])) {
    if (h.name === HOST_NAME) {
      await fetch(`${BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
    }
  }
})

test('API 链路：未知任务 404；窗内任务 200 + 附件头 + 已知步骤行', async ({ request }) => {
  const headers = await unlockHeaders(request)

  // 未知任务 404（内存与存库皆无）
  const bad = await request.get(`${BASE}/api/deploy/sc_dt_no-such-task/log`, { headers })
  expect(bad.status()).toBe(404)

  const { taskId } = await seedFailedDeploy(request, headers)

  // 窗内直出：text/plain 附件 + 留档头部 + 已知日志行（任务启动/失败终态）
  const res = await request.get(`${BASE}/api/deploy/${taskId}/log`, { headers })
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('text/plain')
  const disp = res.headers()['content-disposition'] || ''
  expect(disp).toContain('attachment')
  expect(disp).toMatch(/deploy-127\.0\.0\.1-\d{8}\.txt/)
  const body = await res.text()
  // 留档头品牌随 4adaf9da 切换为 codecombo
  expect(body).toContain('codecombo deploy log')
  expect(body).toContain(`task:     ${taskId}`)
  expect(body).toContain('status:   failed')
  expect(body).toContain('start: task started')
  expect(body).toContain('done: task failed')
})

test('UI 链路：部署详情历史行「日志」→ 下载文件含已知步骤行', async ({ page, request }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders(request)
  await seedFailedDeploy(request, headers)

  // 设置 → 远程部署 → 主机行「更多 → 部署」打开部署弹窗（deploy-rerun 同入口）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.home-action-btn[title="设置"]').click()
  await page.locator('.settings-nav .nav-item').filter({ hasText: '远程部署' }).click()
  const row = page.locator('.host-row').filter({ hasText: HOST_NAME }).first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.locator('.host-actions .n-button').last().click()
  await page.locator('.n-dropdown-option').filter({ hasText: '部署' }).first().click()
  await expect(page.locator('.deploy-dialog-content')).toBeVisible({ timeout: 10000 })

  // 历史任务区该主机的行 → 「日志」下载入口
  const historyRow = page.getByTestId('deploy-history-row').filter({ hasText: HOST_NAME }).first()
  await expect(historyRow).toBeVisible({ timeout: 10000 })
  const logBtn = historyRow.getByTestId('deploy-log-btn')
  await expect(logBtn).toBeVisible()

  fs.mkdirSync(DL_DIR, { recursive: true })
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    logBtn.click(),
  ])
  // 下载名客户端合成：deploy-<主机名摘要>-<yyyymmdd>.txt
  expect(download.suggestedFilename()).toMatch(/^deploy-.*-\d{8}\.txt$/)
  const file = path.join(DL_DIR, download.suggestedFilename())
  await download.saveAs(file)
  const content = fs.readFileSync(file, 'utf8')
  // 留档头品牌随 4adaf9da 切换为 codecombo
  expect(content).toContain('codecombo deploy log')
  expect(content).toContain('start: task started')
  expect(content).toContain('done: task failed')
})

test('通知中心：失败部署通知行内「日志」第二入口 → 下载（主动作修复不回退）', async ({ page, request }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders(request)
  // 通知中心是跨用例共享的服务端域：先清空再播种（deploy-agent-fix 同例）
  await fetch(`${BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seedFailedDeploy(request, headers)

  // 进项目页（通知中心按钮挂载面，deploy-agent-fix 同路径）→ 打开通知中心
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })

  // 失败部署通知行：主动作「交给智能体修复」保持（P-20261003-289 不回退），
  // 第二入口「日志」并存 → 点击直接下载
  const row = page.locator('.nc-item').filter({ hasText: '部署失败' }).filter({ hasText: HOST_NAME }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row.locator('.nc-inline-action', { hasText: '交给智能体修复' })).toBeVisible()
  const logBtn = row.locator('.nc-inline-action', { hasText: '日志' })
  await expect(logBtn).toBeVisible()

  fs.mkdirSync(DL_DIR, { recursive: true })
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    logBtn.click(),
  ])
  const file = path.join(DL_DIR, download.suggestedFilename())
  await download.saveAs(file)
  const content = fs.readFileSync(file, 'utf8')
  // 留档头品牌随 4adaf9da 切换为 codecombo
  expect(content).toContain('codecombo deploy log')
  expect(content).toContain('start: task started')
})
