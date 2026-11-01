import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'

/**
 * 长效令牌签发边界警示 E2E（P-20261001-25）：
 *   - API Token expiry 选 ≥90 天/永久 → 创建区 inline 警示出现；短 expiry 隐藏
 *   - 创建永久令牌 → 列表行带「长效」徽标（用后即删，不污染共享实例）
 *   - Agent Token 卡片常显「不随锁定失效」边界说明（不依赖 reveal/rotate 交互）
 * 纯 UI 断言：不改锁定配置，不动既有令牌。
 */

// 打开「设置 → 安全」分区（默认落「凭据」Tab），模式与 credential-management 一致
async function openSecuritySettings(page: Page) {
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
}

// SecuritySettings 内切到指定 Tab
async function switchSecurityTab(page: Page, tabLabel: string) {
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: tabLabel }).click()
}

// 选择 expiry 下拉项（naive-ui 选项挂在 body Portal 上）
async function pickExpiry(page: Page, label: string) {
  await page.locator('.security-settings .token-add-row .n-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: label }).click()
}

test('API Token：长效 expiry（永久/≥90 天）显示签发警示，短 expiry 隐藏', async ({ page }) => {
  await fixedLocale(page)
  await page.goto('/')
  await openSecuritySettings(page)
  await switchSecurityTab(page, '访问令牌')

  const warning = page.getByTestId('token-longlived-warning')
  // 默认选中「永久」→ 警示即显
  await expect(warning).toBeVisible()

  // 7 天 → 隐藏
  await pickExpiry(page, '7 天')
  await expect(warning).toBeHidden()

  // 90 天 / 1 年 → 均为长效，警示显示
  await pickExpiry(page, '90 天')
  await expect(warning).toBeVisible()
  await pickExpiry(page, '1 年')
  await expect(warning).toBeVisible()
})

test('API Token：创建永久令牌列表行带长效徽标，删除需确认（取消不删/确认才删）', async ({ page }) => {
  await fixedLocale(page)
  await page.goto('/')
  await openSecuritySettings(page)
  await switchSecurityTab(page, '访问令牌')

  const name = `e2e-token-${Date.now().toString(36)}`
  await page.getByPlaceholder('用途描述').fill(name)
  await page.locator('.security-settings').getByRole('button', { name: '生成' }).click()

  // 列表行出现：永久令牌无过期日期，仅「长效」徽标（悬浮提示含边界说明）
  const row = page.locator('.security-settings .token-item').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row.getByTestId('token-longlived-badge')).toHaveText('长效')
  await expect(row.locator('.token-expiry')).toHaveCount(0)

  // 删除确认（P-20261005-5）：点删除先出确认弹窗（confirmDialog 渲染 n-modal，非 window.confirm）
  await row.getByRole('button', { name: '删除' }).click()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: `确定删除访问令牌「${name}」？` })
  await expect(confirmDlg).toBeVisible()

  // 取消不删：令牌仍在列表
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(confirmDlg).toBeHidden()
  await expect(page.locator('.security-settings .token-item').filter({ hasText: name })).toHaveCount(1)

  // 确认才删：弹窗确认后行消失（清理，不污染共享实例）
  await row.getByRole('button', { name: '删除' }).click()
  await expect(confirmDlg).toBeVisible()
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '删除' }).click()
  await expect(page.locator('.security-settings .token-item').filter({ hasText: name })).toHaveCount(0)
})

test('Agent Token：卡片常显「不随锁定失效」边界说明', async ({ page }) => {
  await fixedLocale(page)
  await page.goto('/')
  await openSecuritySettings(page)
  await switchSecurityTab(page, 'Agent Token')

  // 常显说明：无需 reveal / rotate 即可见（区别于 rotate 后的瞬时提示）
  const boundary = page.getByTestId('agent-token-boundary')
  await expect(boundary).toBeVisible()
  await expect(boundary).toContainText('不随锁定失效')
})
