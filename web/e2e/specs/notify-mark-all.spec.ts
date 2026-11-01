import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知中心 Shift+A 全部已读 E2E（P-20261002-119）：
 *   - 多条未读 → 焦点在面板（键盘导航根承接，列表区）→ Shift+A → 全部置已读
 *     （徽标消失、行未读标识清除、行保留）+ 轻 toast 确认，且服务端同步
 *     （markAllRead 走 readAll 落库，刷新口径一致）
 *   - 焦点在筛选页签上让位（现有 .nc-filters closest 判定）：Shift+A 不触发
 *     批量已读——页签自身键盘语义不被抢键（项目下拉同一分支，路径共享）
 *   - 零未读时 Shift+A 无动作无 toast（与头部「全部标记已读」按钮 disabled 等价）
 * 通知经 POST /api/notifications 播种（共享实例先清空、结束后再清空，
 * 不残留测试数据）
 */

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function seed(headers: Record<string, string>, titles: string[]): Promise<void> {
  for (const title of titles) {
    const res = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'info', category: 'system', title, body: '' }),
    })
    expect(res.ok).toBeTruthy()
  }
}

async function openPanel(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  // 焦点显式归位面板根（打开时 watch 已自动聚焦，显式 focus 固化「焦点在列表区」前提，
  // 不依赖自动聚焦时序）
  await page.locator('.nc-card').focus()
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('多条未读：焦点在列表区 Shift+A → 全部已读 + toast + 服务端同步', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, ['e2e-mark-all-甲', 'e2e-mark-all-乙', 'e2e-mark-all-丙'])

  await openPanel(page)
  const jia = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-mark-all-甲' })
  const bing = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-mark-all-丙' })
  await expect(jia).toHaveClass(/unread/, { timeout: 3000 })
  await expect(page.locator('.notify-badge')).toHaveText('3')

  // Shift+A：批量置已读——行保留（非清除）、未读标识与头部徽标清零、toast 确认
  await page.keyboard.press('Shift+A')
  await expect(page.locator('.n-message')).toHaveText('已全部标记为已读（3 条）')
  await expect(jia).not.toHaveClass(/unread/)
  await expect(bing).not.toHaveClass(/unread/)
  await expect(jia).toBeVisible()
  await expect(bing).toBeVisible()
  await expect(page.locator('.notify-badge')).toHaveCount(0)

  // 服务端同步：readAll 落库（非仅前端本地置位），拉取列表全部已读
  const listRes = await fetch(`${API_BASE}/api/notifications`, { headers })
  const list = ((await listRes.json()) as { data?: Array<{ title?: string; read?: boolean }> }).data || []
  expect(list.length).toBe(3)
  expect(list.every(n => n.read)).toBe(true)
})

test('焦点在筛选页签上让位：Shift+A 不触发批量已读', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, ['e2e-mark-all-yield-甲', 'e2e-mark-all-yield-乙'])

  await openPanel(page)
  await expect(page.locator('.notify-badge')).toHaveText('2', { timeout: 3000 })

  // 点击「未读」页签：焦点落在页签按钮上（.nc-filters closest 命中 → 让位）
  await page.locator('.nc-filter-btn').filter({ hasText: '未读' }).click()
  await page.keyboard.press('Shift+A')

  // 无 toast、无批量已读：两条保持未读、徽标不变
  await expect(page.locator('.n-message')).toHaveCount(0)
  await expect(page.locator('.notify-badge')).toHaveText('2')
  await expect(page.locator('.nc-item:not(.nc-sub)')).toHaveCount(2)
  await expect(page.locator('.nc-item:not(.nc-sub)').first()).toHaveClass(/unread/)
})

test('零未读：Shift+A 无动作无 toast（与头部按钮 disabled 等价）', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })

  await openPanel(page)
  await expect(page.locator('.nc-empty')).toBeVisible({ timeout: 3000 })

  await page.keyboard.press('Shift+A')
  await expect(page.locator('.n-message')).toHaveCount(0)
  await expect(page.locator('.notify-badge')).toHaveCount(0)
})
