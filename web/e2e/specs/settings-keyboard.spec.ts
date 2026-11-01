import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 设置弹窗键盘细节 E2E：
 *   - 左侧导航 ↑↓ 直接切换分区（环绕），焦点跟随
 *   - Esc 关闭（无修改不误拦，护栏见 settings-unsaved）后焦点归还触发按钮
 * 全程不改动任何设置值，不点保存，不污染共享实例。
 */

async function openSettings(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
}

test('导航 ↑↓ 切换分区并环绕，焦点跟随', async ({ page }) => {
  await openSettings(page)

  const nav = page.locator('.settings-nav')
  const firstItem = nav.locator('.nav-item').first()
  await firstItem.focus()
  await expect(nav.locator('.nav-item').first()).toHaveClass(/active/)

  // ↓ 到「外观」，再 ↓ 到「终端」（pane 均 v-show 常驻 DOM，取可见pane标题）
  const visibleTitle = page.locator('.settings-modal .content-pane:visible .pane-title')
  await page.keyboard.press('ArrowDown')
  await expect(nav.locator('[data-testid="settings-nav-appearance"]')).toHaveClass(/active/)
  await expect(visibleTitle).toHaveText('外观')
  await page.keyboard.press('ArrowDown')
  await expect(nav.locator('[data-testid="settings-nav-terminal"]')).toHaveClass(/active/)

  // 焦点跟随：当前聚焦的是「终端」按钮，继续 ↑ 回「外观」（焦点原地，分区切换）
  await expect(nav.locator('[data-testid="settings-nav-terminal"]')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(nav.locator('[data-testid="settings-nav-appearance"]')).toHaveClass(/active/)

  // 回到首项「通用」（点击同步 activeTab），↑ 环绕到末项「关于」
  await nav.locator('.nav-item').first().click()
  await expect(nav.locator('.nav-item').first()).toHaveClass(/active/)
  await page.keyboard.press('ArrowUp')
  await expect(nav.locator('.nav-item').last()).toHaveClass(/active/)
})

test('Ctrl+, 打开设置（VS Code 惯例）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+,')
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
})

test('首页 Ctrl+, 同样打开设置（与项目页对齐）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await expect(page.locator('.home-root')).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Control+,')
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
})

test('设置内 Ctrl+S 触发保存：Esc 不再弹未保存确认', async ({ page }) => {
  await openSettings(page)

  // 勾选「定期从远程拉取更新」产生改动
  const row = page.locator('.settings-content .setting-row', { hasText: '定期从远程拉取更新' }).first()
  await row.locator('.n-checkbox').click()

  // Esc 会弹未保存确认（护栏）——改用 Ctrl+S 保存
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(800)

  // 保存后改动落盘，Esc 直接关闭不再弹确认
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
  await expect(page.locator('.n-dialog')).toHaveCount(0)

  // 还原：再勾选回原状态并 Ctrl+S 保存（不污染共享实例）
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await row.locator('.n-checkbox').click()
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})

test('首页 ? 呼出快捷键备忘单', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await expect(page.locator('.home-root')).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Shift+Slash')
  await expect(page.locator('.sc-help').filter({ hasText: '快捷键' }).first()).toBeVisible({ timeout: 3000 })
})

test('Esc 关闭后焦点归还触发按钮', async ({ page }) => {
  await openSettings(page)

  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
  await expect(page.locator('[data-testid="rail-settings"]')).toBeFocused()
})
