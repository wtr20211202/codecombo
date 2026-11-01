import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 命令面板「通知中心」命令 E2E（配方同 palette-commands：Ctrl+K → `>` 命令模式）：
 *   - 输「通知」过滤出通知中心命令，回车直达通知面板（顶栏铃铛的键盘等价入口）
 *   - 英文关键词「notifications」同样可过滤到（keywords 双语可发现性）
 * 仅打开面板不改动通知数据，无需播种/清理。
 */

async function openCommandMode(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test('通知中心命令：输「通知」回车直达通知面板', async ({ page }) => {
  const input = await openCommandMode(page)
  await input.fill('>通知')

  // 断言首项即通知中心命令（标题命中分高于「打开设置：通知」），再回车执行
  const item = page.locator('.palette-item').first()
  await expect(item).toContainText('通知中心', { timeout: 5000 })
  await page.keyboard.press('Enter')

  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  // 面板打开即收起命令面板
  await expect(page.locator('.palette-mask')).toHaveCount(0)
})

test('英文关键词 notifications 可过滤到通知中心命令', async ({ page }) => {
  const input = await openCommandMode(page)
  await input.fill('>notifications')

  const item = page.locator('.palette-item').filter({ hasText: '通知中心' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
})
