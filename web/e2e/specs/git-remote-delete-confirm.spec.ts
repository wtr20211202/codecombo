import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * git 远端删除确认 E2E（P-20261005-5）：
 *   - 设置 → 远程仓库分区，删除按钮单击先出确认弹窗（confirmDialog 渲染 n-modal）
 *   - 取消不删：远端仍在列表
 *   - 确认才删：远端行消失
 * 自清理：用例自建远端，走确认删除收尾，不污染共享实例。
 */

async function openRemoteSettings(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-remote"]').click()
  await expect(page.locator('[data-testid="settings-pane-remote"]')).toBeVisible()
  await expect(page.locator('.remote-settings .remote-add-row')).toBeVisible({ timeout: 3000 })
}

test('git 远端删除需确认：取消不删，确认才删', async ({ page }) => {
  await openRemoteSettings(page)

  // 先自建一条远端（token 承载形态 URL，正是误删后难重建的场景）
  const name = `e2e-remote-${Date.now().toString(36)}`
  const addRow = page.locator('.remote-settings .remote-add-row')
  await addRow.getByPlaceholder('名称 (如 origin)').fill(name)
  await addRow.getByPlaceholder('URL (如 git@github.com:user/repo.git)').fill(`https://oauth2:tok-${name}@example.com/repo.git`)
  await addRow.getByRole('button', { name: '添加' }).click()

  const row = page.locator('.remote-settings .remote-item').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 5000 })

  // 点删除先出确认弹窗（标题含远端名），正文说明仅移除本地配置
  await row.getByRole('button', { name: '删除' }).click()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: `确定删除远端「${name}」？` })
  await expect(confirmDlg).toBeVisible()
  await expect(confirmDlg).toContainText('仅移除本地远端配置')

  // 取消不删
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(confirmDlg).toBeHidden()
  await expect(row).toBeVisible()

  // 确认才删
  await row.getByRole('button', { name: '删除' }).click()
  await expect(confirmDlg).toBeVisible()
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '删除' }).click()
  await expect(row).toHaveCount(0)
})
