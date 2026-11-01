import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享管理器健康与重分享（P-20261020-10）E2E：
 *   1. live 目标删除 → 行显「目标已丢失」徽标 → 状态筛选「异常」→ 撤销清理
 *   2. 过期分享 → 状态筛选「已过期」→「重新分享」重建 → 行回到活跃（无倒计时）
 * 共享实例的全局分享列表（workers=1 串行），beforeEach/afterEach 清空保证确定性。
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const PROBE = 'e2e-share-health-probe.txt'
const PROBE2 = 'e2e-share-health-probe2.txt'
const PROBE3 = 'e2e-share-health-probe3.txt'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

async function removeFile(request: APIRequestContext, headers: Record<string, string>, projectId: string, path: string): Promise<void> {
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path } })
}

/** 造真实探针文件（分享创建要对目标 stat + 敏感扫描） */
async function seedFile(request: APIRequestContext, headers: Record<string, string>, projectId: string, path: string): Promise<void> {
  await removeFile(request, headers, projectId, path)
  const res = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path, content: `share health probe ${path}\n` },
  })
  expect(res.ok()).toBeTruthy()
}

async function seedProbe(request: APIRequestContext, headers: Record<string, string>, projectId: string): Promise<void> {
  await seedFile(request, headers, projectId, PROBE)
}

/** 造一条 live 探针分享，返回 token；expiry 可选（用于过期筛选/重分享） */
async function seedShare(
  request: APIRequestContext, headers: Record<string, string>, projectId: string, path = PROBE, expiry?: string,
): Promise<string> {
  const res = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path } })
  expect(res.ok()).toBeTruthy()
  const token = ((await res.json()) as { data?: { token: string } }).data?.token
  expect(token).toBeTruthy()
  if (expiry) {
    const upd = await request.post(`${BASE}/api/share/${token}/expiry`, { headers, data: { expiresAt: expiry } })
    expect(upd.ok()).toBeTruthy()
  }
  return token!
}

async function openManager(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request }) => {
  await cleanupShares(request)
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers).catch(() => '')
  if (projectId) {
    await removeFile(request, headers, projectId, PROBE)
    await removeFile(request, headers, projectId, PROBE2)
    await removeFile(request, headers, projectId, PROBE3)
  }
})

test('目标删除：行显异常徽标 → 异常筛选 → 行内撤销清理', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  await seedProbe(request, headers, projectId)
  await seedShare(request, headers, projectId)
  // 目标删除后健康投影变 target_missing（列表每次请求现算）
  await removeFile(request, headers, projectId, PROBE)

  await openManager(page)
  const rows = page.locator('.sm-card tbody tr')
  await expect(rows).toHaveCount(1)
  const row = rows.filter({ hasText: PROBE })
  await expect(row).toHaveAttribute('data-health', 'target_missing')
  await expect(row.getByTestId('sm-health-badge')).toHaveText('目标已丢失')
  // 异常行没有可定位/可重建的目标
  await expect(row.getByTestId('sm-locate-btn')).toHaveCount(0)
  await expect(row.getByTestId('sm-reshare-btn')).toHaveCount(0)

  // 工具栏异常计数 + 状态筛选「异常」
  await expect(page.getByTestId('sm-health-warn')).toHaveText('1 条异常')
  await page.getByTestId('sm-status-abnormal').click()
  await expect(rows).toHaveCount(1)
  await expect(page.getByTestId('sm-filter-count')).toHaveText('1/1')

  // 撤销：异常行的主处置
  await row.getByTestId('sm-more-btn').click()
  await page.locator('.n-dropdown-menu').last().getByText('撤销', { exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.sm-card .n-empty')).toBeVisible({ timeout: 10000 })
})

test('定位目标：文件分享经既有打开链回到编辑器', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  await seedProbe(request, headers, projectId)
  await seedShare(request, headers, projectId)

  await openManager(page)
  const row = page.locator('.sm-card tbody tr').filter({ hasText: PROBE })
  await expect(row).toHaveCount(1)
  await row.getByTestId('sm-more-btn').click()
  await page.locator('.n-dropdown-menu').last().getByText('定位目标', { exact: true }).click()
  // OPS_OPEN_FILE_AT 既有消费链：切回编辑器主区并按项目相对路径开文件
  await expect(page.locator('.breadcrumb-scroll .crumb', { hasText: PROBE })).toBeVisible({ timeout: 10000 })
})

test('有效期排序：升/降序切换，无有效期行恒排最后', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  await seedFile(request, headers, projectId, PROBE)
  await seedFile(request, headers, projectId, PROBE2)
  await seedFile(request, headers, projectId, PROBE3)
  await seedShare(request, headers, projectId, PROBE, new Date(Date.now() + 60 * 60_000).toISOString())
  await seedShare(request, headers, projectId, PROBE2, new Date(Date.now() + 2 * 60 * 60_000).toISOString())
  // 永久分享（无 expiresAt）作为「恒末位」对照
  await seedShare(request, headers, projectId, PROBE3)

  await openManager(page)
  const rows = page.locator('.sm-card tbody tr')
  await expect(rows).toHaveCount(3)
  const header = page.locator('.sm-card thead th').filter({ hasText: '有效期' })

  // 首击 = 降序（Naive 默认循环 descend → ascend → false）：2h 在 1h 前，无有效期仍最后
  await header.click()
  await expect(rows.nth(0)).toContainText(PROBE2)
  await expect(rows.nth(1)).toContainText(PROBE)
  await expect(rows.nth(2)).toContainText(PROBE3)

  // 再击 = 升序：1h 在 2h 前，无有效期仍最后（预分页排序的缺省末位纪律）
  await header.click()
  await expect(rows.nth(0)).toContainText(PROBE)
  await expect(rows.nth(1)).toContainText(PROBE2)
  await expect(rows.nth(2)).toContainText(PROBE3)
})

test('过期分享：状态筛选 → 重新分享 → 行回到活跃且旧倒计时消失', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  await seedProbe(request, headers, projectId)
  const past = new Date(Date.now() - 60_000).toISOString()
  await seedShare(request, headers, projectId, PROBE, past)

  await openManager(page)
  const row = page.locator('.sm-card tbody tr').filter({ hasText: PROBE })
  await expect(row).toHaveCount(1)
  await expect(row.locator('[data-testid="sm-countdown"]')).toHaveText('已过期')
  // 重新分享入口在「更多」菜单（P-20261020-9 收口）
  await row.getByTestId('sm-more-btn').click()
  await expect(page.locator('.n-dropdown-menu').last().getByText('重新分享', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  // 状态筛选「已过期」命中
  await page.getByTestId('sm-status-expired').click()
  await expect(page.getByTestId('sm-filter-count')).toHaveText('1/1')

  // 重新分享：确认 → 撤销旧记录 + 按原目标重建（同 token，新周期）
  await row.getByTestId('sm-more-btn').click()
  await page.locator('.n-dropdown-menu').last().getByText('重新分享', { exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '重新分享' }).click()
  // 刷新后行不再带 expiresAt → 仍在「已过期」筛选下自然不命中
  await expect(page.locator('.sm-no-match')).toBeVisible({ timeout: 10000 })

  // 取消状态筛选：行回到活跃态（无倒计时、健康 ok、重分享入口消失）
  await page.getByTestId('sm-status-expired').click()
  await expect(row).toHaveCount(1)
  await expect(row.locator('[data-testid="sm-countdown"]')).toHaveCount(0)
  await expect(row).toHaveAttribute('data-health', 'ok')
  await expect(row.getByTestId('sm-reshare-btn')).toHaveCount(0)

  // 新记录仍可撤销（清理闭环）
  await row.getByTestId('sm-more-btn').click()
  await page.locator('.n-dropdown-menu').last().getByText('撤销', { exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.sm-card .n-empty')).toBeVisible({ timeout: 10000 })
})
