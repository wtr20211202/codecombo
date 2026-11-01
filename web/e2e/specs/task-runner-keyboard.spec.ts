import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 任务面板键盘导航 + 过滤 E2E：
 *   - 打开即聚焦过滤框（输入即过滤、Enter 直开首个匹配——执行路径同
 *     原生 click，不在本 spec 触发真实任务）
 *   - ↑↓ 在任务项间环绕移动焦点（roving focus）
 *   - 过滤框内 ↓ 进列表首项 / ↑ 到末项；Esc 关闭
 */

async function openTaskPanel(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="任务"], .topbar button:has-text("任务")').first().click()
  await expect(page.locator('.tr-card')).toBeVisible({ timeout: 3000 })
  // 后端首扫 manifest（npm/go 等 11 种）可能慢于 3s
  await expect(page.locator('.tr-item').first()).toBeVisible({ timeout: 10000 })
}

test('打开聚焦过滤框，↑↓ 环绕移动焦点', async ({ page }) => {
  await openTaskPanel(page)

  // 打开后过滤框已聚焦
  await expect(page.locator('.tr-filter input')).toBeFocused()

  // 过滤框内 ↓ 进入列表首项
  await page.keyboard.press('ArrowDown')
  const items = page.locator('.tr-item')
  const count = await items.count()
  expect(count).toBeGreaterThan(1)
  await expect(items.nth(0)).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(items.nth(0)).toBeFocused()
  // 从首项 ↑ 环绕到末项
  await page.keyboard.press('ArrowUp')
  await expect(items.nth(count - 1)).toBeFocused()
  // 从末项 ↓ 环绕回首项
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(0)).toBeFocused()
})

test('过滤框输入即过滤，↓ 进过滤后列表首项', async ({ page, request }) => {
  // 清空最近运行（共享实例 uiState 持久化的 recent 会让计数不确定）
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await unlockRes.json()) as { token?: string }).token || ''
  const uiGet = await request.get(`${API_BASE}/api/ui-state`)
  const uiMap = ((await uiGet.json()) as { data?: Record<string, Record<string, unknown>> }).data || {}
  for (const k of Object.keys(uiMap)) {
    await request.put(`${API_BASE}/api/ui-state`, { data: { [k]: { taskRunner: { recent: [] } } } })
  }

  await openTaskPanel(page)

  const filterInput = page.locator('.tr-filter input')
  const total = await page.locator('.tr-item').count()
  // 用不在最近运行里的任务名（type-check 已被真实运行用例持久化进最近运行，
  // 会同时出现在两个分区），保证过滤结果数确定
  await filterInput.fill('lint:fix')
  const filtered = page.locator('.tr-item')
  await expect(filtered).toHaveCount(1)
  expect(total).toBeGreaterThan(1)

  await page.keyboard.press('ArrowDown')
  await expect(filtered.nth(0)).toBeFocused()
  await expect(filtered.nth(0)).toContainText('lint:fix')

  // 清空过滤恢复全量
  await filterInput.fill('')
  await expect(page.locator('.tr-item')).toHaveCount(total)
})

test('Esc 关闭任务面板', async ({ page }) => {
  await openTaskPanel(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.tr-card')).toBeHidden({ timeout: 3000 })
})

test('最近运行置顶：真实运行任务后重开面板置顶直达', async ({ page }) => {
  await openTaskPanel(page)

  // 真实用户路径：点击一个任务运行（点击即记录最近运行并新开终端，任务
  // 在后台终端里执行对断言无影响）→ 面板关闭
  await page.locator('.tr-item').filter({ hasText: 'type-check' }).first().click()
  await expect(page.locator('.tr-card')).toBeHidden({ timeout: 3000 })

  // 重开面板：「最近运行」分区置顶，含刚运行的任务
  await page.locator('button[title="任务"], .topbar button:has-text("任务")').first().click()
  await expect(page.locator('.tr-card')).toBeVisible({ timeout: 3000 })
  const sections = page.locator('.tr-card .tr-section')
  await expect(sections.first()).toContainText('最近运行', { timeout: 5000 })
  await expect(sections.first().locator('.tr-item').filter({ hasText: 'type-check' }).first()).toBeVisible()

  // 收尾：Esc 关闭任务面板（重开时遮罩会拦截点击），再关运行产生的终端 tab。
  // 面板可能被前序 spec 切到 git/控制台 tab（终端 tab 栏隐藏、关闭钮不可见）——
  // 先归一化回终端面板再关（CLAUDE.md 面板 toggle 归一化经验）
  await page.keyboard.press('Escape')
  await expect(page.locator('.tr-card')).toBeHidden({ timeout: 3000 })
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(500)
  }
  const closeBtn = page.locator('.term-tab').last().locator('.term-close-btn')
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click()
    if (await page.locator('.n-modal').isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '确认' }).click()
    }
  }
})
