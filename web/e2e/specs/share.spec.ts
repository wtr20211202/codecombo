import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 文件分享（独立端口子服务）E2E：
 *   1. 管理 API：创建幂等（同目标恒同 token）/列表/撤销 + 子服务状态
 *   2. 访客面：分享页 200 HTML、meta 元信息、未知短链友好 404、撤销后失效
 *   3. UI 链路：文件树右键生成分享 → 结果卡 → 管理视图列表 → 撤销
 * 子服务端口经 /api/share/status 动态获取（默认主端口+2）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const SHARE_TARGET = 'docs/design/polish-rounds.md'

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

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test('分享 API：幂等创建/列表/状态 + 访客页与撤销失效', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)

  // 创建 + 幂等：同目标第二次创建得到同一 token
  const r1 = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: SHARE_TARGET } })
  expect(r1.ok()).toBeTruthy()
  const s1 = ((await r1.json()) as { data?: { token: string; name: string; isDir: boolean } }).data
  expect(s1?.token).toBeTruthy()
  expect(s1?.name).toBe('polish-rounds.md')
  expect(s1?.isDir).toBe(false)

  const r2 = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: SHARE_TARGET } })
  const s2 = ((await r2.json()) as { data?: { token: string } }).data
  expect(s2?.token).toBe(s1?.token)

  // 同名隔离：不同层级同名文件 token 不同
  const r3 = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: 'web/src/utils/monaco-nls.ts' } })
  const s3 = ((await r3.json()) as { data?: { token: string } }).data
  expect(s3?.token).not.toBe(s1?.token)

  // 列表包含两条
  const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as { data?: unknown[] }).data
  expect(list?.length).toBe(2)

  // 访客面：分享页 200 + meta 正常
  const shareBase = await getShareBase(request, headers)
  const page1 = await request.get(`${shareBase}/s/${s1!.token}`)
  expect(page1.status()).toBe(200)
  expect((await page1.text()).toLowerCase()).toContain('<!doctype html')

  const meta = await request.get(`${shareBase}/s/${s1!.token}/meta`)
  expect(meta.ok()).toBeTruthy()
  const metaBody = (await meta.json()) as { entry?: { name: string; kind: string } }
  expect(metaBody.entry?.name).toBe('polish-rounds.md')
  expect(metaBody.entry?.kind).toBe('markdown')

  // 未知短链：友好 404（HTML 而非 JSON 堆栈）
  const nf = await request.get(`${shareBase}/s/zzzzzzzzzzzzzzzz`)
  expect(nf.status()).toBe(404)
  expect(await nf.text()).toContain('404')

  // 撤销后：管理列表移除 + 访客 meta 立即失效
  const del = await request.delete(`${BASE}/api/share/${s1!.token}`, { headers })
  expect(del.ok()).toBeTruthy()
  const list2 = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as { data?: { token: string }[] }).data
  expect(list2?.length).toBe(1)
  const meta2 = await request.get(`${shareBase}/s/${s1!.token}/meta`)
  expect(meta2.status()).toBe(404)
})

test('分享访客面：raw 内容与原文件一致 + download 头正确 + 未知路径 404', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)

  // 建一个临时文件做内容精确比对（先删后建幂等：残留会让 create 409）
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: 'e2e-share-raw.txt' } })
  const res = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path: 'e2e-share-raw.txt', content: 'share-raw-content-7777' },
  })
  expect(res.ok()).toBeTruthy()
  const created = await request.post(`${BASE}/api/share`, {
    headers, data: { projectId, path: 'e2e-share-raw.txt' },
  })
  const s = ((await created.json()) as { data?: { token: string } }).data
  expect(s?.token).toBeTruthy()

  const shareBase = await getShareBase(request, headers)

  // raw：内容与原文件一致
  const raw = await request.get(`${shareBase}/s/${s!.token}/raw`)
  expect(raw.status()).toBe(200)
  expect(await raw.text()).toBe('share-raw-content-7777')

  // download：Content-Disposition 附件头
  const dl = await request.get(`${shareBase}/s/${s!.token}/download`)
  expect(dl.status()).toBe(200)
  expect(dl.headers()['content-disposition'] || '').toContain('attachment')
  expect(await dl.text()).toBe('share-raw-content-7777')

  // 撤销后 raw 立即失效
  const del = await request.delete(`${BASE}/api/share/${s!.token}`, { headers })
  expect(del.ok()).toBeTruthy()
  const raw2 = await request.get(`${shareBase}/s/${s!.token}/raw`)
  expect(raw2.status()).toBe(404)

  // 清理探针文件（此 spec 用真实项目仓库，不得残留）
  const cleanup = await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: 'e2e-share-raw.txt' } })
  expect(cleanup.ok()).toBeTruthy()
})

test('UI：文件树右键生成分享 → 结果卡 → 管理视图撤销', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, PROJECT_NAME).first()
  await projectCard.click()
  await page.waitForURL('**/project')

  // 背景右键 = 分享项目根（目录分享）；P-20261003-320 起先弹创建弹层选模式
  //（live 默认直接确认），确认后才创建出结果卡
  const tree = page.locator('.tree-list')
  await expect(tree).toBeVisible()
  await tree.click({ button: 'right', position: { x: 60, y: 120 } })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()
  const createModal = page.locator('.share-create-modal')
  await expect(createModal).toBeVisible()
  await createModal.locator('[data-testid="share-create-confirm"]').click()

  // 结果卡：链接指向子服务 /s/ 短链
  const modal = page.locator('.share-result-modal')
  await expect(modal).toBeVisible()
  const link = await modal.locator('input').inputValue()
  expect(link).toMatch(/\/s\/[0-9a-z]{16}$/)

  // 去管理：主区切换到分享管理视图，列表含该分享
  await modal.getByRole('button', { name: '管理全部分享' }).click()
  await expect(modal).toBeHidden()
  await expect(page.locator('.sm-toolbar-text h2')).toHaveText('文件分享')
  await expect(page.locator('.sm-card table')).toBeVisible()

  // 撤销：低频动作收在行尾「更多」菜单里（P-20261020-9），确认弹窗语义不变
  await page.getByTestId('sm-more-btn').first().click()
  await page.locator('.n-dropdown-menu').last().getByText('撤销', { exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.sm-card .n-empty')).toBeVisible({ timeout: 10_000 })
})
