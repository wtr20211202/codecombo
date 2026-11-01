import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 设置弹窗未保存修改护栏 E2E：
 *   - 无修改时 Esc 直接关闭，不误拦
 *   - 通用设置改动后 Esc / × 弹确认，丢弃后关闭
 *   - Git 设置（子分区 isDirty）改动后点 × 弹确认，取消则留在弹窗
 * 全程只改本地态不点保存，丢弃路径不落盘，不污染共享实例。
 */

async function openGeneralSettings(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
}

async function openGitSettings(page: import('@playwright/test').Page) {
  await openGeneralSettings(page)
  // 分区语义锚点（P-20261002-151）：不再依赖导航序下标
  await page.locator('[data-testid="settings-nav-git"]').click()
  await expect(page.locator('.settings-content .slider-row', { hasText: 'user.name:' })).toBeVisible({ timeout: 3000 })
}

test('未修改时 Esc 直接关闭（护栏不误拦）', async ({ page }) => {
  await openGeneralSettings(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})

test('通用设置改动后 Esc 弹确认：丢弃后关闭', async ({ page }) => {
  await openGeneralSettings(page)

  // 勾选「定期从远程拉取更新」→ 仅本地脏，不保存
  const row = page.locator('.settings-content .setting-row', { hasText: '定期从远程拉取更新' }).first()
  await row.locator('.n-checkbox').click()

  await page.keyboard.press('Escape')
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await expect(dialog).toContainText('未保存的修改')

  await dialog.getByRole('button', { name: '丢弃并关闭' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})

test('Git 设置改动后点 × 弹确认：取消留在弹窗，确认后才关闭', async ({ page }) => {
  await openGitSettings(page)

  // Git 分区：user.name 输入任意脏值（不保存，最后丢弃）
  const nameInput = page.locator('.settings-content .slider-row', { hasText: 'user.name:' }).locator('input')
  await expect(nameInput).toBeVisible({ timeout: 3000 })
  await nameInput.fill('e2e-unsaved-guard')

  await page.locator('.settings-close').click()
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 3000 })

  // 取消 → 弹窗保留，脏值仍在
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible()
  await expect(nameInput).toHaveValue('e2e-unsaved-guard')

  // 再次关闭并确认丢弃
  await page.locator('.settings-close').click()
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await dialog.getByRole('button', { name: '丢弃并关闭' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})
