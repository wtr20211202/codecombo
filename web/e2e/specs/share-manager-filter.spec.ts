import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享管理搜索与过滤（P-20261002-85）E2E：
 *   1. 列表头搜索框：名称/项目/路径子串即时过滤（snippet 名称缺省 = 内容首行摘要），
 *      清空恢复全量；无命中显示提示
 *   2. 类别徽标点选：file|snippet 单选过滤，再点已选徽标回到全部；与搜索叠加
 *   3. 过滤态计数：过滤行 n/总数
 * 共享实例的全局分享列表（workers=1 串行），beforeEach/afterEach 清空保证确定性
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const FILE_TARGET = 'docs/design/polish-rounds.md'
const SNIPPET_CONTENT = 'SCFILTER panic: quota exceeded\nat share-manager-filter-spec'

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

/** 造两分享：文件分享（名称 polish-rounds.md）+ 文本片段（名称 = 内容首行摘要） */
async function seedTwoShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const file = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: FILE_TARGET } })
  expect(file.ok()).toBeTruthy()
  const snippet = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: SNIPPET_CONTENT } })
  expect(snippet.ok()).toBeTruthy()
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

test('搜索：名称/项目/内容首行即时过滤、清空恢复、无命中提示', async ({ page, request }) => {
  await seedTwoShares(request)
  await openManager(page)

  const rows = page.locator('.sm-card tbody tr')
  await expect(rows).toHaveCount(2)
  const input = page.locator('[data-testid="sm-filter-search"] input')

  // 名称子串命中：只剩文件分享，计数 1/2
  await input.fill('polish')
  await expect(rows.filter({ hasText: 'polish-rounds.md' })).toHaveCount(1)
  await expect(page.getByTestId('sm-filter-count')).toHaveText('1/2')

  // 清空恢复全量
  await input.fill('')
  await expect(rows).toHaveCount(2)

  // snippet 名称缺省 = 内容首行摘要：按首行内容命中
  await input.fill('quota exceeded')
  await expect(rows.filter({ hasText: 'quota exceeded' })).toHaveCount(1)

  // 项目名命中
  await input.fill('simple-coding')
  await expect(rows.filter({ hasText: 'polish-rounds.md' })).toHaveCount(1)

  // 无命中：列表让位给提示（过滤行仍在，可清空恢复）
  await input.fill('no-such-share-keyword')
  await expect(rows).toHaveCount(0)
  await expect(page.locator('.sm-no-match')).toBeVisible()

  await input.fill('')
  await expect(rows).toHaveCount(2)
  await expect(page.getByTestId('sm-filter-count')).toHaveCount(0)
})

test('类别徽标点选：file|snippet 过滤、再点已选回全部、与搜索叠加', async ({ page, request }) => {
  await seedTwoShares(request)
  await openManager(page)

  const rows = page.locator('.sm-card tbody tr')
  await expect(rows).toHaveCount(2)
  const kinds = page.getByTestId('sm-filter-kinds')

  // 点「片段」徽标：只剩 snippet 行
  await kinds.locator('.n-tag').filter({ hasText: '片段' }).click()
  await expect(rows.filter({ hasText: 'quota exceeded' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'polish-rounds.md' })).toHaveCount(0)
  await expect(page.getByTestId('sm-filter-count')).toHaveText('1/2')

  // 切「文件」徽标：只剩 file 行（单选互斥）
  await kinds.locator('.n-tag').filter({ hasText: '文件' }).click()
  await expect(rows.filter({ hasText: 'polish-rounds.md' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'quota exceeded' })).toHaveCount(0)

  // 再点已选徽标：回到全部
  await kinds.locator('.n-tag').filter({ hasText: '文件' }).click()
  await expect(rows).toHaveCount(2)

  // 与搜索叠加：polish 只命中文件 + 片段徽标 → 无命中提示
  const input = page.locator('[data-testid="sm-filter-search"] input')
  await input.fill('polish')
  await kinds.locator('.n-tag').filter({ hasText: '片段' }).click()
  await expect(rows).toHaveCount(0)
  await expect(page.locator('.sm-no-match')).toBeVisible()
  await expect(page.getByTestId('sm-filter-count')).toHaveText('0/2')

  // 清搜索 → 只剩片段；点「全部」恢复
  await input.fill('')
  await expect(rows.filter({ hasText: 'quota exceeded' })).toHaveCount(1)
  await kinds.locator('.n-tag').filter({ hasText: '全部' }).click()
  await expect(rows).toHaveCount(2)
  await expect(page.getByTestId('sm-filter-count')).toHaveCount(0)
})
