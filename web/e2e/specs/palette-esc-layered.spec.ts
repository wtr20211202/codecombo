import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 命令面板 Esc 双层退出（P-20261004-95，VS Code「先清后关」惯例）：
 *   - 有查询：Esc 只清空查询（文件模式清到空、命令模式清到 '>' 保模式前缀），
 *     面板保持打开——长查询误按 Esc 不再连查询带面板同失重来
 *   - 空查询：Esc 关闭面板
 *   - 裸 '>'（命令模式原生态）视同空查询：Esc 直接关闭不空转
 *   - 底部键位提示随态切换（有查询=清空查询 / 空=关闭）
 * 配方同 palette-commands（Ctrl+K 开面板，文件模式默认态）
 */

async function openProjectAndPalette(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test('文件模式：有查询 Esc 先清空（面板仍在），再 Esc 关闭', async ({ page }) => {
  const input = await openProjectAndPalette(page)
  await input.fill('CommandPalette')
  await expect(page.locator('.palette-item').first()).toBeVisible({ timeout: 5000 })

  // Esc #1：查询清空、面板仍在（列表回到全量）
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('')
  await expect(page.locator('.palette-card')).toBeVisible()
  await expect(page.locator('.palette-item').first()).toBeVisible()

  // Esc #2：空查询才关
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-card')).toHaveCount(0)
})

test('命令模式：有查询 Esc 清到 \'>\'（模式保留），再 Esc 关闭', async ({ page }) => {
  const input = await openProjectAndPalette(page)
  await input.fill('>任务运行器')
  await expect(
    page.locator('.palette-item').filter({ hasText: '任务运行器' }).first(),
  ).toBeVisible({ timeout: 5000 })

  // Esc #1：清到 '>' 而非全空——命令模式徽标仍在，命令列表（空查询全量）可见
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('>')
  await expect(page.locator('.palette-mode-badge')).toContainText('命令')
  await expect(page.locator('.palette-card')).toBeVisible()

  // Esc #2：裸 '>' 视同空查询，关闭
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-card')).toHaveCount(0)
})

test('底部键位提示随态切换：有查询显「清空查询」，清空后回「关闭」', async ({ page }) => {
  const input = await openProjectAndPalette(page)
  const hint = page.locator('.palette-hint')

  await input.fill('CommandPalette')
  await expect(page.locator('.palette-item').first()).toBeVisible({ timeout: 5000 })
  await expect(hint).toContainText('清空查询')

  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('')
  await expect(hint).toContainText('关闭')
  await expect(hint).not.toContainText('清空查询')

  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-card')).toHaveCount(0)
})
