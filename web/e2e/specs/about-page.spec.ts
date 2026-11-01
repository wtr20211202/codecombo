import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 关于页版本单写 + unknown 元数据显示 E2E
test('关于页：版本只在 VersionPanel 徽章出现一次，unknown 构建时间显示 —', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="设置"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-about"]').click()

  // 头部卡片不再重复版本号（版本唯一出现在 VersionPanel 徽章）
  await expect(page.locator('.about-version')).toHaveCount(0)
  const badge = page.locator('.version-badge')
  await expect(badge).toHaveCount(1)
  await expect(badge).toContainText(/^v/)

  // dev 构建无注入元数据：unknown → —
  const buildTime = page.locator('.version-row', { hasText: '构建时间' }).locator('.version-value')
  await expect(buildTime).not.toHaveText(/unknown/)
})
