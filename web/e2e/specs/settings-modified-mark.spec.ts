import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 设置行修改标记与单行恢复默认 E2E（P-20261003-171）：
 *   - 出厂默认行无「已修改」标记（未改行无标记）
 *   - 直写行（外观·minimap）：改动 → 行尾出标记+恢复钮；恢复默认 → 勾选态复原且
 *     直写 localStorage 即时持久化（font-settings）
 *   - 暂存行（终端·历史行数 / 通用·定期拉取）：改动 → 出标记；恢复默认 → 标记消失，
 *     与已存值一致后 Esc 直接关弹窗（isDirty 关闭护栏不误拦）
 * 全程只动直写/本地暂存态，不点「保存」，不污染共享实例的服务端设置。
 */

async function openSettingsPane(
  page: import('@playwright/test').Page,
  tab: 'general' | 'appearance' | 'terminal',
) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  // 分区语义锚点（P-20261002-151）：不依赖导航序下标
  await page.locator(`[data-testid="settings-nav-${tab}"]`).click()
  await expect(page.locator(`[data-testid="settings-pane-${tab}"]`)).toBeVisible({ timeout: 3000 })
}

test('外观：未改行无标记，改 minimap 出标记，恢复默认复原并即时持久化', async ({ page }) => {
  await openSettingsPane(page, 'appearance')

  const minimapRow = page.locator('[data-testid="settings-minimap"]')
  await expect(minimapRow).toBeVisible({ timeout: 3000 })
  // 出厂默认（开）→ 无标记
  await expect(minimapRow.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  // 相邻未改行（固定滚动，默认开）同样无标记
  const stickyRow = minimapRow.locator('xpath=following-sibling::label[1]')
  await expect(stickyRow.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)

  // 关闭小地图（直写行：即时写 store + localStorage，不走「保存」）
  await minimapRow.locator('.n-checkbox').click()
  await expect(minimapRow.locator('[data-testid="settings-modified-mark"]')).toBeVisible()
  await expect(minimapRow.locator('[data-testid="settings-restore-default"]')).toBeVisible()
  let stored = await page.evaluate(() => localStorage.getItem('font-settings'))
  expect(JSON.parse(stored || '{}')?.editor?.minimap).toBe(false)

  // 单行恢复默认：勾选态复原、标记消失、直写持久化回 true
  await minimapRow.locator('[data-testid="settings-restore-default"]').click()
  await expect(minimapRow.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  await expect(minimapRow.locator('.n-checkbox')).toHaveClass(/n-checkbox--checked/)
  stored = await page.evaluate(() => localStorage.getItem('font-settings'))
  expect(JSON.parse(stored || '{}')?.editor?.minimap).toBe(true)
})

test('终端：历史行数改后出标记，恢复默认后 Esc 直接关（脏护栏不误拦）', async ({ page }) => {
  await openSettingsPane(page, 'terminal')

  const row = page.locator('[data-testid="settings-pane-terminal"] .form-group', { hasText: '终端历史行数' })
    .locator('.slider-row')
  await expect(row).toBeVisible({ timeout: 3000 })
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)

  // 改动（只动本地暂存，不保存）：20000 → 50000，行出标记
  await row.locator('input').fill('50000')
  await row.locator('input').blur()
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toBeVisible()

  // 恢复默认：值回到与已存值一致 → 无未保存修改，Esc 直接关弹窗而非弹护栏
  await row.locator('[data-testid="settings-restore-default"]').click()
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  await expect(row.locator('input')).toHaveValue('20000')
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})

test('通用：定期拉取改后出标记，恢复默认后 Esc 直接关', async ({ page }) => {
  await openSettingsPane(page, 'general')

  const row = page.locator('[data-testid="settings-pane-general"] .setting-row', { hasText: '定期从远程拉取更新' }).first()
  await expect(row).toBeVisible({ timeout: 3000 })
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)

  await row.locator('.n-checkbox').click()
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toBeVisible()

  await row.locator('[data-testid="settings-restore-default"]').click()
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})
