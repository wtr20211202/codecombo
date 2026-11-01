import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享访客访问审计（P-20261003-257）E2E：
 *   1. 匿名访客打开分享页 → GET /api/audit 出现 share.view 事件（Detail 含
 *      链接 id 与 UA 简要，3s 定时批量入账，断言前轮询）
 *   2. 下载直链取件（跳过页面）同样留痕；子资源取数（meta/raw）不留痕
 *      （口径 = 访问计数同款）
 *   3. 审计面板可见（P-131 过滤族）：动作下拉从实际事件派生、缺 i18n 键回退
 *      原文动作名——面板行含链接 id 即可检索
 * 共享实例的全局分享列表与审计台账（workers=1 串行），beforeEach 清分享。
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const FILE_TARGET = 'docs/design/polish-rounds.md'

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

type AuditEvent = { action: string; detail?: string; ip?: string; result: string }

/** 轮询审计台账直至出现该 token 的 share.view 事件（3s 定时批量入账，不整页忙等） */
async function waitViewAudit(
  request: APIRequestContext,
  headers: Record<string, string>,
  token: string,
  want: number,
): Promise<AuditEvent[]> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const res = await request.get(`${BASE}/api/audit?limit=500`, { headers })
    const events = ((await res.json()) as { data?: AuditEvent[] }).data || []
    const hits = events.filter(e => e.action === 'share.view' && (e.detail || '').includes(token))
    if (hits.length >= want) return hits
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`share.view audit for ${token} never reached ${want} within 15s`)
}

async function openAuditTab(page: Page): Promise<void> {
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
  await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request }) => {
  await cleanupShares(request)
})

test('匿名访客访问 → 审计台账 share.view 条目（Detail 含链接 id/UA）+ 面板可见', async ({ page, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const created = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: FILE_TARGET } })
  expect(created.ok()).toBeTruthy()
  const share = (((await created.json()) as { data?: { token: string } }).data)
  expect(share?.token, 'file share created').toBeTruthy()

  // 匿名访客打开分享页（访客子服务独立端口；UA 不自定义——request 上下文
  // 以自身 Playwright UA 发出，捕获值断言交给 Go 单测，这里只验「有 UA 简要」）
  const visitor = await shareBase(request, headers)
  const resp = await request.get(`${visitor}/s/${share!.token}`)
  expect(resp.status(), 'visitor page open must succeed').toBe(200)

  // 审计台账：share.view 事件入账，Detail 含链接 id + 展示名 + UA 简要 + IP
  const hits = await waitViewAudit(request, headers, share!.token, 1)
  expect(hits[0].detail).toContain('polish-rounds.md')
  expect(hits[0].detail).toContain('ua: ')
  expect(hits[0].ip, 'visitor ip recorded').toBeTruthy()
  expect(hits[0].result).toBe('success')

  // 审计面板可见：进项目 → 设置·安全·审计日志，动作行含链接 id
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await openAuditTab(page)
  const row = page.locator('[data-testid="audit-pane"] .n-data-table-tr').filter({ hasText: share!.token })
  await expect(row.first()).toBeVisible({ timeout: 5000 })
})

test('下载直链取件同样留痕；子资源取数不留痕（口径 = 计数同款）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const created = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: FILE_TARGET } })
  expect(created.ok()).toBeTruthy()
  const share = (((await created.json()) as { data?: { token: string } }).data)
  expect(share?.token).toBeTruthy()

  // 台账匹配计数器：share.view 且 Detail 含该 token。审计台账 append-only、
  // 不随 cleanupShares 清理，而同目标 token 确定性派生（前序用例/重试尝试的
  // 同 token 留痕全在账）——断言用增量口径，不锚绝对条数
  const countMatching = async (): Promise<number> => {
    const res = await request.get(`${BASE}/api/audit?limit=500`, { headers })
    const events = ((await res.json()) as { data?: AuditEvent[] }).data || []
    return events.filter(e => e.action === 'share.view' && (e.detail || '').includes(share!.token)).length
  }
  const before = await countMatching()

  const visitor = await shareBase(request, headers)
  // 子资源取数：meta/raw 各一次（页面浏览的内部取数，不留痕）
  const meta = await request.get(`${visitor}/s/${share!.token}/meta`)
  expect(meta.status()).toBe(200)
  const raw = await request.get(`${visitor}/s/${share!.token}/raw?path=`)
  expect(raw.status()).toBe(200)
  // 下载直链（跳过页面直接取文件）+1 留痕
  const dl = await request.get(`${visitor}/s/${share!.token}/download`)
  expect(dl.status(), 'download must succeed').toBe(200)

  // 轮询至匹配数推进（3s 批量入账）：恰好 +1 = 下载留痕、meta/raw 不留痕
  const deadline = Date.now() + 15_000
  let after = before
  while (Date.now() < deadline) {
    after = await countMatching()
    if (after > before) break
    await new Promise(r => setTimeout(r, 400))
  }
  expect(after, 'exactly the download is audited; meta/raw contribute none').toBe(before + 1)
})
