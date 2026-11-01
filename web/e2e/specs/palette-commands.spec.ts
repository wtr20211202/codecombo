import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 命令面板命令完备性 E2E（配方同 help-center：Ctrl+K → `>` 命令模式）：
 *   - 「任务运行器」命令直达任务面板（不实际运行任务）
 *   - 「终端会话管理」「锁定系统」命令可过滤到（锁定命令不执行——会锁住
 *     共享实例干扰后续用例）
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

test('任务运行器命令直达任务面板', async ({ page }) => {
  const input = await openCommandMode(page)
  await input.fill('>任务运行器')
  const item = page.locator('.palette-item').filter({ hasText: '任务运行器' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  await expect(page.locator('.tr-card')).toBeVisible({ timeout: 3000 })
})

test('终端会话管理与锁定系统命令可过滤到', async ({ page }) => {
  const input = await openCommandMode(page)

  await input.fill('>终端会话管理')
  const agentCmd = page.locator('.palette-item').filter({ hasText: '终端会话管理' }).first()
  await expect(agentCmd).toBeVisible({ timeout: 5000 })

  await input.fill('>锁定系统')
  const lockCmd = page.locator('.palette-item').filter({ hasText: '锁定系统' }).first()
  await expect(lockCmd).toBeVisible({ timeout: 5000 })

  // 不执行锁定（会锁住共享实例干扰后续用例）
  // Esc 双层退出（P-20261004-95）：有查询先清——两连 Esc 才落到关闭
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})
