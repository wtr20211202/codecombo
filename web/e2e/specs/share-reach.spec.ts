import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import {
  DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, mockRelayAddressContext, projectCardByName, RELAY_FIXTURE_LAN,
} from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享链接可达性与稳定 URL（P-20261020-2）E2E：
 *   1. 公网分享基址 → 结果卡绿徽标；结果卡复制值 = 管理器二维码内容（逐字节同源）
 *   2. 回环入口 + 局域网候选 → 红态「本机回环」+ 需同网提示，复制/二维码都用候选 origin
 *   3. 局域网分享基址 → 黄徽标「需同一网络」，复制值用配置基址
 *   4. 阶段 B 同源入口：主应用 origin 下 /s/<token>、/s/<token>/meta 与访客页
 *      vendored 资产可达（反代/SSH 隧道只转发主端口即成立）；主应用自身
 *      /assets/ 产物不被分享代理吞掉
 *
 * 地址上下文（settings.sharePublicBaseUrl / externalAccessUrl / network 候选）
 * 全在页面层 mock（helpers.mockRelayAddressContext），不写服务端设置、不依赖
 * 机器真实网卡；分享列表是全局状态，beforeEach/afterEach 清空保证确定性。
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const FILE_TARGET = 'docs/design/polish-rounds.md'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
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

/** API 建一条确定性分享（避免 UI 创建路径的额外分支） */
async function createShare(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const res = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: FILE_TARGET } })
  expect(res.ok()).toBeTruthy()
  const token = ((await res.json()) as { data?: { token: string } }).data?.token || ''
  expect(token).toMatch(/^[0-9a-z]{16}$/)
  return token
}

async function openManager(page: Page): Promise<void> {
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request, page }) => {
  await cleanupShares(request)
  // 页面层 settings/network 路由在用例结束时可能仍有在途请求（后台首拉/弹窗拉取）；
  // 卸载路由时忽略回调错误，避免 teardown 竞态把已通过用例标 flaky
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('公网分享基址：结果卡绿徽标，结果卡复制值与管理器二维码逐字节同源', async ({ page }) => {
  await fixedLocale(page)
  await mockRelayAddressContext(page, {
    addresses: [],
    externalAccessUrl: '',
    sharePublicBaseUrl: 'https://share.example.com',
  })
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  // 侧栏面板可能被前序用例留在 TODO/笔记等视图，甚至整栏收起（uiState 持久）；
  // 文件树按钮是开关——循环点到可见为止（share-snippet 同款守卫）
  const tree = page.locator('.tree-list')
  for (let i = 0; i < 3; i++) {
    if (await tree.isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await expect(tree).toBeVisible({ timeout: 10000 })
  await tree.click({ button: 'right', position: { x: 60, y: 120 } })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()
  const createModal = page.locator('.share-create-modal')
  await expect(createModal).toBeVisible()
  await createModal.locator('[data-testid="share-create-confirm"]').click()

  // 结果卡：短链固定为 <分享基址>/s/<token> + 绿色「分享基址」徽标
  const modal = page.locator('.share-result-modal')
  await expect(modal).toBeVisible()
  const box = modal.locator('[data-testid="share-result-qr-url"] input')
  const value = await box.inputValue()
  expect(value).toMatch(/^https:\/\/share\.example\.com\/s\/[0-9a-z]{16}$/)
  const badge = modal.locator('[data-testid="share-reach-badge"]')
  await expect(badge).toHaveAttribute('data-tone', 'green')
  await expect(badge).toContainText('分享基址')
  await expect(modal.locator('[data-testid="share-reach-hint"]')).toContainText('任意网络可访问')

  // 结果卡复制 = 输入框值（同一地址计划；复制按钮由 QR 面板承载）
  await page.context().grantPermissions(['clipboard-read'])
  await modal.locator('[data-testid="share-result-qr-copy"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value)

  // 去管理：全局徽标同色，行内二维码内容与结果卡逐字节一致
  await modal.getByRole('button', { name: '管理全部分享' }).click()
  await expect(modal).toBeHidden()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })
  const managerBadge = page.locator('[data-testid="sm-share-reach"] [data-testid="share-reach-badge"]')
  await expect(managerBadge).toHaveAttribute('data-tone', 'green')
  await page.locator('.sm-card tbody tr').first().locator('button[aria-label="二维码"]').click()
  const qrModal = page.locator('.n-modal.sm-qr-modal')
  await expect(qrModal).toBeVisible({ timeout: 5000 })
  await expect(qrModal.locator('[data-testid="sm-qr-url"] input')).toHaveValue(value)
})

test('回环入口 + 局域网候选：红态「本机回环」提示需同网，复制与二维码都用候选 origin', async ({ page, request }) => {
  const token = await createShare(request)
  await fixedLocale(page)
  await mockRelayAddressContext(page, {
    addresses: [RELAY_FIXTURE_LAN],
    externalAccessUrl: '',
    sharePublicBaseUrl: '',
  })
  await openManager(page)

  // 回环入口且无外部基址 = 红态（与二维码接力同一语义：地址虽自动改到候选，
  // 但不能保证对端与服务器同一网络）；hint 说明已改址与同网前提
  const managerBadge = page.locator('[data-testid="sm-share-reach"] [data-testid="share-reach-badge"]')
  await expect(managerBadge).toHaveAttribute('data-tone', 'red')
  await expect(managerBadge).toHaveAttribute('data-source', 'candidate')
  await expect(managerBadge).toContainText('本机回环')
  await expect(managerBadge.locator('.share-reach-pill')).toHaveAttribute('title', /已自动改用局域网地址/)

  // 候选 origin 沿用当前页面协议/端口（utils/networkAddress.candidateOrigin）
  const u = new URL(page.url())
  const expected = `${u.protocol}//${RELAY_FIXTURE_LAN.ip}${u.port ? `:${u.port}` : ''}/s/${token}`

  // 行内复制 = 二维码输入框 = 同一地址计划（不再各算各的）
  await page.context().grantPermissions(['clipboard-read'])
  const row = page.locator('.sm-card tbody tr').first()
  await row.locator('button[aria-label="复制链接"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected)

  await row.locator('button[aria-label="二维码"]').click()
  const qrModal = page.locator('.n-modal.sm-qr-modal')
  await expect(qrModal).toBeVisible({ timeout: 5000 })
  await expect(qrModal.locator('[data-testid="sm-qr-url"] input')).toHaveValue(expected)
})

test('局域网分享基址：黄徽标「需同一网络」，复制值用配置的基址', async ({ page, request }) => {
  const token = await createShare(request)
  await fixedLocale(page)
  await mockRelayAddressContext(page, {
    addresses: [],
    externalAccessUrl: '',
    sharePublicBaseUrl: 'http://192.168.1.50:9999',
  })
  await openManager(page)

  const managerBadge = page.locator('[data-testid="sm-share-reach"] [data-testid="share-reach-badge"]')
  await expect(managerBadge).toHaveAttribute('data-tone', 'yellow')
  await expect(managerBadge).toContainText('局域网')

  await page.context().grantPermissions(['clipboard-read'])
  await page.locator('.sm-card tbody tr').first().locator('button[aria-label="复制链接"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://192.168.1.50:9999/s/${token}`)
})

test('同源入口：主应用 origin 下 /s/ 与访客资产可达，主应用 /assets/ 产物不被吞掉', async ({ page, request }) => {
  const token = await createShare(request)

  // 访客页、meta 子资源、vendored 资产都经主端口（阶段 B 同源直通）
  const visitor = await request.get(`${BASE}/s/${token}`)
  expect(visitor.status()).toBe(200)
  expect((await visitor.text()).toLowerCase()).toContain('<!doctype html')

  const meta = await request.get(`${BASE}/s/${token}/meta`)
  expect(meta.ok()).toBeTruthy()
  const metaBody = (await meta.json()) as { entry?: { name: string } }
  expect(metaBody.entry?.name).toBe('polish-rounds.md')

  const asset = await request.get(`${BASE}/assets/xterm.js`)
  expect(asset.status()).toBe(200)
  expect((asset.headers()['content-type'] || '')).toContain('javascript')

  // 主应用自身 Vite 产物同住 /assets/：页面引用的哈希资产仍由静态服务提供
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  const scriptSrc = await page.locator('script[src^="/assets/"]').first().getAttribute('src')
  expect(scriptSrc).toBeTruthy()
  const mainAsset = await request.get(`${BASE}${scriptSrc}`)
  expect(mainAsset.status()).toBe(200)
  expect((await mainAsset.text()).length).toBeGreaterThan(0)
})
