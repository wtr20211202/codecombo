import { test, expect, type Page, type Route } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 更新进度离开可见 E2E（P-20261109-10）：真实更新链外呼 GitHub 不可控（版本
 * 漂移/速率限制/会真换包），/api/updates/status 走 page.route 注入状态机各态
 * （version-uptodate-feedback 同款先例），机器化钉住：
 *   1. 全局徽标常驻可见——版本面板关闭后，下载中/校验各阶段文案与下载百分比
 *      在页面角落实时可见（离开面板不失明）；
 *   2. F5/关面板重开进度恢复——面板挂载即同步，服务端在途即接管（「立即更新」
 *      不误可点，服务端 409 前端静默的双洞）；
 *   3. 面板内进度块同源消费——阶段文案（不再直出键名原文）+ 字节明细；
 *   4. 失败通知「查看详情」回面板——服务端通知（titleKey 模板 + update-panel
 *      动作）点击后设置弹窗定位「关于」，原因原文在面板结局块可见；「知道了」
 *      确认已读（DELETE /updates/status）；
 *   5. 长 changelog 限高内滚，「立即更新」首屏可达。
 * /api/updates/apply 也拦下（本套件不真触发受理），通知 POST 拦截本地应答；
 * 结尾 API 清通知域，不残留测试数据。
 */

const STATUS_ROUTE = '**/api/updates/status*'

type StatusPayload = Record<string, unknown>

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 可切换响应的 status 路由；DELETE（确认已读）同服务端语义：清结果与失败态回空闲 */
async function routeStatus(page: Page, initial: StatusPayload) {
  const state = { payload: initial, deletes: 0 }
  await page.route(STATUS_ROUTE, async (route: Route) => {
    if (route.request().method() === 'DELETE') {
      state.deletes++
      state.payload = { status: 'idle', progress: 0, total: 0, version: '' }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ message: 'update status cleared' }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: state.payload }) })
  })
  return state
}

/** 打开版本面板（设置弹窗「关于」分区） */
async function openVersionPanelViaSettings(page: Page) {
  await page.locator('.rail-btn[title="设置"]').first().click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="settings-nav-about"]').click()
  return modal
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('下载中：面板内进度块与全局徽标同源可见；关闭面板后徽标仍在且实时', async ({ page }) => {
  const status = await routeStatus(page, {
    status: 'downloading', progress: 40 * 1024 * 1024, total: 100 * 1024 * 1024, version: '9.9.9',
  })
  const posted: string[] = []
  await page.route('**/api/notifications', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posted.push(route.request().postData() ?? '')
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {} }) })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 面板尚未打开：全局徽标已可见（启动同步接管在途更新）
  const badge = page.locator('[data-testid="update-progress-badge-text"]')
  await expect(badge).toContainText('下载中')
  await expect(badge).toContainText('40%')

  // 打开面板：进度块同源（阶段文案不是键名原文）
  const modal = await openVersionPanelViaSettings(page)
  await expect(page.locator('[data-testid="version-update-phase"]')).toHaveText('下载中')
  await expect(page.locator('[data-testid="version-update-bytes"]')).toContainText('40.0 MB')
  await expect(page.locator('[data-testid="version-update-now"]')).toHaveCount(0)
  await page.locator('.n-modal.settings-modal .settings-close').click()
  await expect(modal).not.toBeVisible({ timeout: 5000 })

  // 关闭面板后徽标仍在；推进状态（校验 → 100%）实时反映
  await expect(badge).toBeVisible()
  status.payload = { status: 'verifying', progress: 100 * 1024 * 1024, total: 100 * 1024 * 1024, version: '9.9.9' }
  await expect(badge).toContainText('校验中', { timeout: 10000 })
  // 百分比只在下载阶段透出（校验无字节分母，徽标底边改流动条）
  await expect(badge).not.toContainText('%')
  // 更新链不重复入账通知（服务端单一发射）：面板/store 零 POST
  expect(posted.filter(b => b.includes('更新') || b.includes('update')).length).toBe(0)
})

test('换包重启窗：受理后失联推断态「安装并重启中」；恢复后成功结局带刷新引导', async ({ page }) => {
  let failStatus = true
  await page.route(STATUS_ROUTE, async (route) => {
    if (failStatus) {
      await route.abort('connectionrefused')
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { status: 'idle', progress: 0, total: 0, version: '9.9.9', result: 'success', resultAt: '2026-11-09T00:00:00Z' } }) })
  })
  const posted: string[] = []
  await page.route('**/api/notifications', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posted.push(route.request().postData() ?? '')
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {} }) })
  })
  await page.route('**/api/updates/apply', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ message: 'update started', version: '9.9.9' }) })
  })
  await page.route('**/api/updates/check*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { currentVersion: '0.0.1', latestVersion: '9.9.9', hasUpdate: true, changelog: '- fix' } }) })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  // 首页版本弹窗（首页同样有宿主入口）发起更新：受理即失联 → 推断态
  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  await card.locator('.version-update-section > button.panel-btn').first().click()
  await card.getByRole('button', { name: '立即更新' }).click()
  const badge = page.locator('[data-testid="update-progress-badge-text"]')
  await expect(badge).toContainText('安装并重启中', { timeout: 10000 })

  // 服务恢复且结果已落盘：成功结局 + 刷新引导 toast；开始通知不由前端入账
  failStatus = false
  await expect(badge).toContainText('已更新到 v9.9.9', { timeout: 10000 })
  await expect(page.locator('.n-message').first()).toContainText('已更新到 v9.9.9', { timeout: 5000 })
  expect(posted.filter(b => b.includes('更新') || b.includes('update')).length).toBe(0)
})

test('失败通知「查看详情」：回面板结局块带原因；「知道了」确认已读', async ({ page }) => {
  const status = await routeStatus(page, {
    status: 'idle', progress: 0, total: 0, version: '9.9.9',
    result: 'failed', resultError: 'update verification failed: checksum mismatch', resultAt: '2026-11-09T01:02:03Z',
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 服务端通知（titleKey 模板 + update-panel 动作）入通知中心
  const headers = await unlockHeaders()
  const res = await page.request.post(`${API_BASE}/api/notifications`, {
    headers,
    data: {
      type: 'error',
      category: 'system',
      titleKey: 'update.notify.failedTitle',
      bodyKey: 'update.notify.failedBody',
      title: '更新到 v9.9.9 失败',
      body: 'update verification failed: checksum mismatch',
      msgParams: { version: '9.9.9' },
      action: 'update-panel',
    },
  })
  expect(res.ok()).toBeTruthy()

  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })
  // 模板按界面语言渲染（不是键名原文）
  await expect(page.locator('.nc-card').getByText('更新到 v9.9.9 失败').first()).toBeVisible()
  await page.locator('.nc-card').getByRole('button', { name: '查看详情' }).first().click()

  // 回跳：设置弹窗定位「关于」，结局块带原因原文
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('[data-testid="settings-pane-about"]')).toBeVisible()
  await expect(modal.locator('[data-testid="version-update-outcome-phase"]')).toHaveText('更新失败')
  await expect(modal.locator('[data-testid="version-update-outcome-reason"]')).toContainText('checksum mismatch')

  // 确认已读：DELETE status 清结果文件与失败态（路由按服务端语义回空闲），结局块消隐
  await modal.locator('[data-testid="version-update-ack"]').click()
  await expect(modal.locator('[data-testid="version-update-outcome"]')).toHaveCount(0, { timeout: 5000 })
  expect(status.deletes).toBe(1)
})

test('长 changelog：限高内滚，「立即更新」首屏可达', async ({ page }) => {
  await routeStatus(page, { status: 'idle', progress: 0, total: 0, version: '' })
  await page.route('**/api/updates/check*', async (route) => {
    const changelog = Array.from({ length: 120 }, (_, i) => `- 变更条目 ${i}`).join('\n')
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { currentVersion: '0.0.1', latestVersion: '9.9.9', hasUpdate: true, changelog } }) })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  await card.locator('.version-update-section > button.panel-btn').first().click()

  const body = card.locator('[data-testid="version-changelog-body"]')
  await expect(body).toBeVisible()
  // 限高（不随内容无限增高）
  const height = await body.evaluate(el => el.getBoundingClientRect().height)
  expect(height).toBeLessThanOrEqual(200)
  // 「立即更新」在视口内（首屏可达）
  await expect(card.getByRole('button', { name: '立即更新' })).toBeVisible()
})
