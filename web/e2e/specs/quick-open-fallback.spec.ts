import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * Quick Open 空结果搜索降级引导（P-20261002-86）：
 *   - 文件模式输不存在的词 → 空态出现「搜索文件内容（Ctrl+Shift+F）」动作行
 *   - Enter / 点动作行 → 关 Quick Open，打开项目搜索并带入查询词（打开即自动搜索）
 *   - 命令模式空态保持现状（纯 noResults 文案，无动作行）
 */

const MISSING = 'zzq-no-such-file-xyz'

async function openQuickOpen(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+p')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test('文件模式空结果：Enter 降级打开项目搜索并带入查询词', async ({ page }) => {
  const input = await openQuickOpen(page)
  await input.fill(MISSING)

  // 空态动作行出现（引导文本 + 动作按钮）
  const empty = page.locator('.palette-empty-fallback')
  await expect(empty).toBeVisible()
  await expect(empty.locator('.palette-fallback-action')).toHaveText('搜索文件内容（Ctrl+Shift+F）')

  // Enter：关 Quick Open → 项目搜索面板打开且查询词带入
  await page.keyboard.press('Enter')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await expect(card.locator('.ps-input-row input').first()).toHaveValue(MISSING)
  await expect(page.locator('.palette-card')).toHaveCount(0)
})

test('点动作行同样降级；命令模式空态不显示动作行', async ({ page }) => {
  const input = await openQuickOpen(page)

  // 命令模式空态：保持纯文案，无降级动作行
  await input.fill('>zzq-no-such-command')
  await expect(page.locator('.palette-empty')).toBeVisible()
  await expect(page.locator('.palette-empty-fallback')).toHaveCount(0)

  // 文件模式空结果：点动作行降级，查询词同样带入
  await input.fill(MISSING)
  const empty = page.locator('.palette-empty-fallback')
  await expect(empty).toBeVisible()
  await empty.locator('.palette-fallback-action').click()
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await expect(card.locator('.ps-input-row input').first()).toHaveValue(MISSING)
})
