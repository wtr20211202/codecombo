import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 分享链接轮换（P-20261002-72，泄露应对一步化）E2E：
 *   1. API 链路：创建 → 轮换 → 旧链访客 404 / 新链访客 200、旧 token 再轮换
 *      404、幂等创建跟随当前代际、snippet 同构、撤销后轮换 404
 *   2. UI 链路：文件树右键创建 → 管理视图「轮换」→ 确认弹窗（文案讲清旧链
 *      即刻作废）→ toast 引导复制新链 → 旧链失效、新链可开、剪贴板即新链
 * 子服务端口经 /api/share/status 动态获取（默认主端口+2）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const SHARE_TARGET = 'docs/design/polish-rounds.md'

// 剪贴板读写权限：Chromium 下 navigator.clipboard 需显式授予——toast「新链接
// 已复制」与剪贴板断言依赖主路径（execCommand 降级读不回内容）
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

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

test('轮换 API：旧链访客 404 / 新链可开 + 幂等跟随新链 + snippet 同构 + 撤销后轮换 404', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const shareBase = await getShareBase(request, headers)

  // 创建 → 访客页可开
  const r1 = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: SHARE_TARGET } })
  expect(r1.ok()).toBeTruthy()
  const s1 = ((await r1.json()) as { data?: { token: string } }).data
  expect(s1?.token).toBeTruthy()
  expect((await request.get(`${shareBase}/s/${s1!.token}/meta`)).status()).toBe(200)

  // 轮换：全新 token（代际参与派生，非同链复用）
  const rot = await request.post(`${BASE}/api/share/${s1!.token}/rotate`, { headers })
  expect(rot.ok()).toBeTruthy()
  const s2 = ((await rot.json()) as { data?: { token: string } }).data
  expect(s2?.token).toBeTruthy()
  expect(s2!.token).not.toBe(s1!.token)

  // 旧链访客立即 404，新链 200 且指向同一目标
  expect((await request.get(`${shareBase}/s/${s1!.token}/meta`)).status()).toBe(404)
  const meta2 = await request.get(`${shareBase}/s/${s2!.token}/meta`)
  expect(meta2.ok()).toBeTruthy()
  expect(((await meta2.json()) as { entry?: { name: string } }).entry?.name).toBe('polish-rounds.md')

  // 旧 token 再轮换 → 404；同目标幂等创建跟随当前代际（不复活旧链）
  expect((await request.post(`${BASE}/api/share/${s1!.token}/rotate`, { headers })).status()).toBe(404)
  const again = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: SHARE_TARGET } })
  expect(((await again.json()) as { data?: { token: string } }).data?.token).toBe(s2!.token)

  // snippet 同构：内容派生的短链同样可轮换（否则同内容会回到已泄露旧链）
  const sn = await request.post(`${BASE}/api/share/snippet`, {
    headers, data: { content: 'rotate-e2e-snippet-body' },
  })
  expect(sn.ok()).toBeTruthy()
  const snOld = ((await sn.json()) as { data?: { token: string } }).data!.token!
  const snRot = await request.post(`${BASE}/api/share/${snOld}/rotate`, { headers })
  expect(snRot.ok()).toBeTruthy()
  const snNew = ((await snRot.json()) as { data?: { token: string } }).data!.token!
  expect(snNew).not.toBe(snOld)
  expect((await request.get(`${shareBase}/s/${snOld}/meta`)).status()).toBe(404)
  expect((await request.get(`${shareBase}/s/${snNew}/meta`)).status()).toBe(200)

  // 撤销后轮换 → 404
  expect((await request.delete(`${BASE}/api/share/${s2!.token}`, { headers })).ok()).toBeTruthy()
  expect((await request.post(`${BASE}/api/share/${s2!.token}/rotate`, { headers })).status()).toBe(404)
})

test('UI：创建 → 管理视图轮换 → 确认弹窗 → toast 复制新链 → 旧链失效新链可开', async ({ page, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const shareBase = await getShareBase(request, headers)

  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, PROJECT_NAME).first()
  await projectCard.click()
  await page.waitForURL('**/project')

  // 创建：背景右键 → 生成分享链接（项目根分享）→ 创建弹层确认（live 默认），
  // 结果卡记录旧 token
  const tree = page.locator('.tree-list')
  await expect(tree).toBeVisible()
  await tree.click({ button: 'right', position: { x: 60, y: 120 } })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()
  const createModal = page.locator('.share-create-modal')
  await expect(createModal).toBeVisible()
  await createModal.locator('[data-testid="share-create-confirm"]').click()
  const modal = page.locator('.share-result-modal')
  await expect(modal).toBeVisible()
  const oldLink = await modal.locator('input').inputValue()
  expect(oldLink).toMatch(/\/s\/[0-9a-z]{16}$/)
  const oldToken = oldLink.split('/').pop()!

  // 去管理视图
  await modal.getByRole('button', { name: '管理全部分享' }).click()
  await expect(modal).toBeHidden()
  await expect(page.locator('.sm-toolbar-text h2')).toHaveText('文件分享')
  await expect(page.locator('.sm-card table')).toBeVisible()

  // 行尾「更多」→「轮换」（P-20261020-9 收口后入口在菜单内）→ 确认弹窗文案讲清旧链即刻作废
  await page.getByTestId('sm-more-btn').first().click()
  await page.locator('.n-dropdown-menu').last().getByText('轮换', { exact: true }).click()
  const dlg = page.locator('.n-dialog')
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('旧链接立即作废')
  await dlg.getByRole('button', { name: '轮换并复制新链接' }).click()

  // toast 引导复制新链 + 剪贴板即新链
  await expect(page.locator('.n-message').filter({ hasText: '新链接已复制' })).toBeVisible({ timeout: 10_000 })

  // 列表已刷新为当前代际：唯一一条 = 新链 ≠ 旧链
  const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as { data?: { token: string }[] }).data || []
  expect(list).toHaveLength(1)
  const newToken = list[0]!.token
  expect(newToken).not.toBe(oldToken)

  // 剪贴板里是新短链（结果 toast「已复制」背后的真实落盘内容）
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain(`/s/${newToken}`)
  expect(clip).not.toContain(oldToken)

  // 访客面：旧链 404、新链可开
  expect((await request.get(`${shareBase}/s/${oldToken}/meta`)).status()).toBe(404)
  expect((await request.get(`${shareBase}/s/${newToken}/meta`)).status()).toBe(200)
})
