import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'

/**
 * SSH 密钥删除确认 E2E（P-20261005-5）：
 *   - 设置 → 安全 → SSH 密钥，删除按钮单击先出确认弹窗（confirmDialog 渲染 n-modal）
 *   - 取消不删：密钥仍在列表
 *   - 确认才删：密钥行消失
 * 自清理：用例自生成 ed25519 密钥，走确认删除收尾，不污染共享实例。
 */

async function openSshKeysSettings(page: Page) {
  await fixedLocale(page)
  await page.goto('/')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: 'SSH 密钥' }).click()
  await expect(page.locator('.security-settings .cred-add-row')).toBeVisible({ timeout: 3000 })
}

test('SSH 密钥删除需确认：取消不删，确认才删', async ({ page }) => {
  await openSshKeysSettings(page)

  // 自生成一把 ed25519 密钥（Go crypto，不依赖外部 ssh-keygen）
  const name = `e2e-sshkey-${Date.now().toString(36)}`
  const addRow = page.locator('.security-settings .cred-add-row')
  await addRow.getByPlaceholder('密钥名称').fill(name)
  await addRow.getByRole('button', { name: '生成', exact: true }).click()

  const row = page.locator('.security-settings .token-item').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 5000 })

  // 点删除先出确认弹窗（标题含密钥名），正文说明依赖主机连接即断
  await row.getByRole('button', { name: '删除' }).click()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: `确定删除 SSH 密钥「${name}」？` })
  await expect(confirmDlg).toBeVisible()
  await expect(confirmDlg).toContainText('authorized_keys')

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
