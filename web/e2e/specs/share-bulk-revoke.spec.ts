import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享管理器批量撤销（P-20261005-226）E2E：
 *   1. 多选整批撤销：进入批量管理 → 表头全选 → 单次确认（列计数与所选名）→
 *      一次确认替代 N 次弹窗，整批撤空
 *   2. 筛选共存：筛选后全选=选可见集（不可见行不入选），清筛选勾选保持
 *   3. 失败隔离逐项报告：单项撤销失败（route 模拟 500）不中断整批——成功行
 *      落库摘除、失败行原位保留，warning toast 报 ok/fail 计数
 * 共享实例的全局分享列表（workers=1 串行），beforeEach/afterEach 清空保证确定性
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const FILE_TARGET = 'docs/design/polish-rounds.md'
const FILE_NAME = 'polish-rounds.md'
const SNIPPET_A = 'SCBULK panic: quota exceeded\nbulk-spec snippet A'
const SNIPPET_B = 'SCBULK retry: backoff engaged\nbulk-spec snippet B'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性） */
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

/** 造三条分享：1 文件 + 2 片段（名称 = 内容首行），返回列表终态 */
async function seedThreeShares(request: APIRequestContext): Promise<{ data?: { token: string; name: string }[] }> {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const file = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: FILE_TARGET } })
  expect(file.ok()).toBeTruthy()
  const a = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: SNIPPET_A } })
  expect(a.ok()).toBeTruthy()
  const b = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: SNIPPET_B } })
  expect(b.ok()).toBeTruthy()
  const res = await request.get(`${BASE}/api/share`, { headers })
  return (await res.json()) as { data?: { token: string; name: string }[] }
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
})

test('多选整批撤销：全选 → 单次确认（列计数与所选名）→ 整批撤空', async ({ page, request }) => {
  const list = await seedThreeShares(request)
  expect(list.data?.length).toBe(3)
  await openManager(page)

  const rows = page.locator('.sm-card tbody tr')
  await expect(rows).toHaveCount(3)

  // 非批量态无勾选列；工具条「批量管理」进入多选态
  await expect(page.locator('.sm-card thead .n-checkbox')).toHaveCount(0)
  await page.getByTestId('sm-bulk-enter').click()
  await expect(page.getByTestId('sm-bulk-bar')).toBeVisible()
  await expect(page.getByTestId('sm-bulk-count')).toHaveText('已选 0 条')

  // 撤销钮零选中禁用；表头全选后计数 3
  await expect(page.getByTestId('sm-bulk-revoke')).toBeDisabled()
  await page.locator('.sm-card thead .n-checkbox').click()
  await expect(page.getByTestId('sm-bulk-count')).toHaveText('已选 3 条')
  await expect(page.getByTestId('sm-bulk-revoke')).toBeEnabled()

  // 单次确认弹窗：列出计数与全部所选名（一次确认替代 N 次逐条弹窗）
  await page.getByTestId('sm-bulk-revoke').click()
  const dlg = page.locator('.n-dialog')
  await expect(dlg).toContainText('将撤销 3 条分享')
  for (const name of [FILE_NAME, SNIPPET_A.split('\n')[0], SNIPPET_B.split('\n')[0]]) {
    await expect(dlg).toContainText(`「${name}」`)
  }

  // 确认 → 整批撤空：成功 toast + 列表转空态 + 服务端清零
  await dlg.getByRole('button', { name: '撤销所选' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已撤销 3 条分享' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.sm-card .n-empty')).toBeVisible({ timeout: 10000 })
  const headers = await unlockHeaders(request)
  const after = await request.get(`${BASE}/api/share`, { headers })
  expect((((await after.json()) as { data?: unknown[] }).data) || []).toHaveLength(0)
})

test('筛选共存：筛选后全选=选可见集，清筛选勾选保持', async ({ page, request }) => {
  await seedThreeShares(request)
  await openManager(page)

  const rows = page.locator('.sm-card tbody tr')
  await page.getByTestId('sm-bulk-enter').click()

  // 筛选「片段」：表内只剩 snippet 行，表头全选只吃到可见集（文件行不入选）
  const kinds = page.getByTestId('sm-filter-kinds')
  await kinds.locator('.n-tag').filter({ hasText: '片段' }).click()
  await expect(rows).toHaveCount(2)
  await page.locator('.sm-card thead .n-checkbox').click()
  await expect(page.getByTestId('sm-bulk-count')).toHaveText('已选 2 条')

  // 清筛选回到全量：勾选保持（文件行仍未选），计数不变
  await kinds.locator('.n-tag').filter({ hasText: '全部' }).click()
  await expect(rows).toHaveCount(3)
  await expect(page.getByTestId('sm-bulk-count')).toHaveText('已选 2 条')

  // 只撤可见集里选中的两条：文件行原位保留
  await page.getByTestId('sm-bulk-revoke').click()
  const dlg = page.locator('.n-dialog')
  await expect(dlg).toContainText('将撤销 2 条分享')
  await dlg.getByRole('button', { name: '撤销所选' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已撤销 2 条分享' })).toBeVisible({ timeout: 10000 })
  await expect(rows).toHaveCount(1)
  await expect(rows.filter({ hasText: FILE_NAME })).toHaveCount(1)
})

test('失败隔离：单项失败不中断整批，成功行摘除失败行保留', async ({ page, request }) => {
  const list = await seedThreeShares(request)
  const fileToken = list.data?.find(s => s.name === FILE_NAME)?.token
  expect(fileToken, 'file share token present').toBeTruthy()
  await openManager(page)

  const rows = page.locator('.sm-card tbody tr')

  // 拦文件分享那条 DELETE 返 500（其余路径照常透传）——模拟单项撤销失败
  await page.route(`**/api/share/${fileToken}`, async (route) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'bulk-spec mock failure' }) })
    }
    return route.fallback()
  })

  await page.getByTestId('sm-bulk-enter').click()
  await page.locator('.sm-card thead .n-checkbox').click()
  await expect(page.getByTestId('sm-bulk-count')).toHaveText('已选 3 条')
  await page.getByTestId('sm-bulk-revoke').click()
  const dlg = page.locator('.n-dialog')
  await expect(dlg).toContainText('将撤销 3 条分享')
  await dlg.getByRole('button', { name: '撤销所选' }).click()

  // 部分失败：warning toast 报 ok/fail 计数（拦截器 silent 不逐条弹错）
  await expect(page.locator('.n-message').filter({ hasText: '已撤销 2 条' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.n-message').filter({ hasText: '1 条失败' })).toBeVisible()

  // 失败行原位保留（整批未中断），成功行摘除
  await expect(rows).toHaveCount(1)
  await expect(rows.filter({ hasText: FILE_NAME })).toHaveCount(1)
})
