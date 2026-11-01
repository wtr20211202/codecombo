import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知中心键盘导航 + 单条已读语义 E2E：
 *   - ↑↓ 在扁平行序列环绕移动（is-active 高亮）
 *   - Enter 激活：无动作单条标记已读（此前点击无动作项毫无反馈，
 *     单条永远无法已读、只能整批「全部已读」）；组行展开组员
 *   - 点击无动作单条 → 标记已读
 * 通知经 POST /api/notifications 播种（共享实例先清空、结束后再清空，
 * 不残留测试数据）；打开项目页取 TopBar 铃铛入口。
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

async function seed(headers: Record<string, string>, notes: Array<{ title: string; type?: string; category?: string; body?: string }>) {
  for (const n of notes) {
    const res = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: n.type ?? 'info', category: n.category ?? 'system', title: n.title, body: n.body ?? '' }),
    })
    expect(res.ok).toBeTruthy()
  }
}

async function openPanel(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 本 spec 的跳转/标题断言锚定 simple-coding：git-test 夹具存在时首卡轮不到它
  //（服务端列表序），必须按名整词进入
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('清空按钮带确认：取消保留，确认后清空', async ({ page }) => {
  const headers = await unlockHeaders()
  await seed(headers, [{ title: 'e2e-清空确认-甲' }, { title: 'e2e-清空确认-乙' }])

  await openPanel(page)
  const rows = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-清空确认' })
  await expect(rows).toHaveCount(2, { timeout: 3000 })

  // 点清空 → 确认弹窗 → 取消：通知保留
  await page.locator('.nc-action-btn.danger').click()
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await expect(dialog).toContainText('清空 2 条通知')
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  await expect(rows).toHaveCount(2)

  // 再点清空 → 确认：全部清掉，空态出现
  await page.locator('.nc-action-btn.danger').click()
  await expect(page.locator('.n-dialog')).toBeVisible({ timeout: 3000 })
  await page.locator('.n-dialog').getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.nc-empty')).toBeVisible({ timeout: 3000 })
})

test('浏览器标签标题未读徽标：(n) 前缀随未读增减', async ({ page }) => {
  const headers = await unlockHeaders()
  await seed(headers, [{ title: 'e2e-标题徽标-甲' }, { title: 'e2e-标题徽标-乙' }])

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 2 条未读 → 标题 (2) 前缀；全部已读 → 恢复默认标题。
  // 项目内 title 信息架构（P-20261002-21）：品牌名 — 项目名，徽标为前缀
  await expect(page).toHaveTitle(/\(2\) Codecombo/)
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  // 「全部已读」（头部第一个动作按钮现为通知偏好齿轮，按 title 定位）
  await page.locator('.nc-action-btn[title="全部标记已读"]').click()
  await expect(page).toHaveTitle('Codecombo — simple-coding')
})

test('通知偏好快捷入口：直达设置通知页签', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

  await page.locator('.nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.settings-modal .content-pane:visible .pane-title')).toHaveText('通知偏好')
  await expect(page.locator('[data-testid="settings-nav-notifications"]')).toHaveClass(/active/)
})

test('↑↓ 环绕移动高亮，越界回绕', async ({ page }) => {
  const headers = await unlockHeaders()
  // 行序需确定：先清空（文件内先前用例遗留的通知会加入 flatRows，箭头环绕
  // 作用在全量行上，遗留行会让过滤定位与实际焦点错位），再播种 3 条
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, [{ title: 'e2e-导航通知-甲' }, { title: 'e2e-导航通知-乙' }, { title: 'e2e-导航通知-丙' }])

  await openPanel(page)
  const rows = page.locator('.nc-item:not(.nc-sub)')
  await expect(rows).toHaveCount(3, { timeout: 3000 })

  await expect(rows.nth(0)).toHaveClass(/is-active/)
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toHaveClass(/is-active/)
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(2)).toHaveClass(/is-active/)
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(0)).toHaveClass(/is-active/)
  await page.keyboard.press('ArrowUp')
  await expect(rows.nth(2)).toHaveClass(/is-active/)
})

test('Enter 激活无动作单条：标记已读，徽标清零', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, [{ title: 'e2e-已读通知-甲' }])

  await openPanel(page)
  const row = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-已读通知-甲' })
  await expect(row).toHaveClass(/unread/, { timeout: 3000 })
  await expect(page.locator('.notify-badge')).toBeVisible()

  await page.keyboard.press('Enter')
  await expect(row).not.toHaveClass(/unread/)
  await expect(page.locator('.notify-badge')).toHaveCount(0)
})

test('点击无动作单条：标记已读（此前点击毫无反馈）', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, [{ title: 'e2e-已读通知-乙' }])

  await openPanel(page)
  const row = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-已读通知-乙' })
  await expect(row).toHaveClass(/unread/, { timeout: 3000 })

  await row.click()
  await expect(row).not.toHaveClass(/unread/)
  await expect(page.locator('.notify-badge')).toHaveCount(0)
})

test('Enter 展开分组，↓ 进入组员后 Enter 单条已读', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, [{ title: 'e2e-分组通知', body: 'same-body' }, { title: 'e2e-分组通知', body: 'same-body' }])

  await openPanel(page)
  const group = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-分组通知' })
  await expect(group).toContainText('×2', { timeout: 3000 })
  await expect(page.locator('.nc-sub')).toHaveCount(0)

  await page.keyboard.press('Enter')
  const members = page.locator('.nc-sub')
  await expect(members).toHaveCount(2)

  await page.keyboard.press('ArrowDown')
  await expect(members.nth(0)).toHaveClass(/is-active/)
  await page.keyboard.press('Enter')
  await expect(members.nth(0)).not.toHaveClass(/unread/)
  // 另一条仍未读：组行保持未读标识
  await expect(members.nth(1)).toHaveClass(/unread/)
})


test('分组行「标记本组已读」：一键清零组内未读', async ({ page }) => {
  const headers = await unlockHeaders()
  // 清空（前序用例遗留的未读会让徽标计数不确定）后播种：
  // 同 title+body+category 甲×2 → 折叠为一组；乙为独立单条
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, [
    { title: 'e2e-组已读-甲' },
    { title: 'e2e-组已读-甲' },
    { title: 'e2e-组已读-乙' },
  ])

  await gotoAndUnlock(page, `${API_BASE}/`)

  // 解锁后延迟出现的默认密码提醒先收起（遮罩会拦项目卡片点击）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'test-results/debug-home.png', fullPage: true })
  console.log('[DEBUG-HOME] project-cards:', await page.locator('.project-card').count(),
    '| url:', page.url(),
    '| title:', await page.title())
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

  const group = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-组已读-甲' }).first()
  await expect(group).toContainText('×2', { timeout: 3000 })

  // hover 分组行 → 「标记本组已读」按钮出现 → 点击
  await group.hover()
  const markBtn = group.locator('.nc-dismiss[title="标记本组已读"]')
  await expect(markBtn).toBeVisible({ timeout: 3000 })
  await markBtn.click()

  // 组内未读清零：未读样式消失、组行保持；乙为独立单条仍未读 → 徽标 1
  await expect(group).not.toHaveClass(/unread/)
  await expect(page.locator('.notify-badge')).toHaveText('1')
  await expect(group).toContainText('×2')
})
