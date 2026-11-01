import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享访问计数与最近访问（P-20261002-14）E2E：
 *   1. 新建分享初始「未访问」弱化态 → 匿名打开页面两次 → 管理列表计数 2 +
 *      最近访问相对时间（3s 定时批量落盘，断言前轮询 API 至 hits 就绪）
 *   2. 下载直链与 snippet 页面访问同样计数（计数口径 = 页面打开 + 下载启动）
 * 共享实例的全局分享列表（workers=1 串行），beforeEach/afterEach 清空保证确定性
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const FILE_TARGET = 'docs/design/polish-rounds.md'
const SNIPPET_CONTENT = 'SCHITS panic: counter overflow\nat share-hits-spec'

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

/** 分享子服务基址（访客短链端口 = 主端口 + 2，经 status 端点取实际值） */
async function shareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  expect(status?.running, 'share sub-service must be running').toBeTruthy()
  return `${status!.scheme || 'http'}://127.0.0.1:${status!.port}`
}

/** 轮询管理列表直至该分享 hits ≥ want（计数 3s 批量落盘，不整页忙等） */
async function waitHits(
  request: APIRequestContext,
  headers: Record<string, string>,
  token: string,
  want: number,
): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const res = await request.get(`${BASE}/api/share`, { headers })
    const list = ((await res.json()) as { data?: { token: string; hits?: number }[] }).data || []
    const s = list.find(x => x.token === token)
    if (s && (s.hits ?? 0) >= want) return
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`share ${token} hits never reached ${want} within 15s`)
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

test('匿名访问两次 → 管理列表计数 2 + 最近访问（初始「未访问」弱化）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const created = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: FILE_TARGET } })
  expect(created.ok()).toBeTruthy()
  const share = (((await created.json()) as { data?: { token: string } }).data)
  expect(share?.token, 'file share created').toBeTruthy()

  // 初始态：未访问弱化样式（弱化 class 挂在计数单元格上）
  await openManager(page)
  const row = page.locator('.sm-card tbody tr').filter({ hasText: 'polish-rounds.md' })
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('sm-hits')).toHaveText('未访问')

  // 匿名访客打开两次（访客子服务独立端口）
  const visitor = await shareBase(request, headers)
  for (let i = 0; i < 2; i++) {
    const resp = await request.get(`${visitor}/s/${share!.token}`)
    expect(resp.status(), 'visitor page open must succeed').toBe(200)
  }

  // 计数落盘后管理列表可见：刷新 → 计数 2 + 最近访问相对时间（非「—」）
  await waitHits(request, headers, share!.token, 2)
  // 工具栏多钮（P-20261005-226 批量撤销入口入列）——按 testid 精确定位刷新钮
  await page.locator('[data-testid="sm-toolbar-refresh-btn"]').click()
  await expect(row.getByTestId('sm-hits')).toHaveText('2')
  const lastCell = row.locator('td').nth(6) // 列序：名称/项目/路径/类型/创建/次数/最近访问/操作
  await expect(lastCell).not.toHaveText('—')
})

test('下载直链与 snippet 页面访问同样计数', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const file = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: FILE_TARGET } })
  expect(file.ok()).toBeTruthy()
  const fileShare = (((await file.json()) as { data?: { token: string } }).data)
  const snippet = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: SNIPPET_CONTENT } })
  expect(snippet.ok()).toBeTruthy()
  const snippetShare = (((await snippet.json()) as { data?: { token: string } }).data)
  expect(fileShare?.token && snippetShare?.token).toBeTruthy()

  const visitor = await shareBase(request, headers)
  // 下载直链（跳过页面直接取文件；file 分享根 = 文件本身，空 path 即该文件）+1；
  // snippet 无下载，页面打开 +1
  const dl = await request.get(`${visitor}/s/${fileShare!.token}/download`)
  expect(dl.status(), 'download must succeed').toBe(200)
  const page1 = await request.get(`${visitor}/s/${snippetShare!.token}`)
  expect(page1.status()).toBe(200)

  await waitHits(request, headers, fileShare!.token, 1)
  await waitHits(request, headers, snippetShare!.token, 1)

  // UI 侧佐证：两条行都脱离「未访问」弱化态
  await openManager(page)
  const fileRow = page.locator('.sm-card tbody tr').filter({ hasText: 'polish-rounds.md' })
  const snippetRow = page.locator('.sm-card tbody tr').filter({ hasText: 'counter overflow' })
  await expect(fileRow.getByTestId('sm-hits')).toHaveText('1')
  await expect(snippetRow.getByTestId('sm-hits')).toHaveText('1')
})
