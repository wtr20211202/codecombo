import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, waitForAppReady, unlockIfNeeded } from './helpers'

/**
 * 凭据管理 / OAuth 应用配置 E2E 测试
 *
 * 覆盖（对应 Plan 3 Task 9）：
 *  - 添加 PAT 凭据 → 列表显示 host + username
 *  - 删除凭据 → 列表移除
 *  - 添加 OAuth 应用 → 列表显示 client_id
 *  - 凭据列表显示平台 tag（github.com → GitHub tag）
 *
 * 前置条件：
 *  - simple-coding 在 :9999 已启动（嵌入构建产物）
 *  - 锁定状态：若启用锁定，先用默认密码 admin 解锁（与 lock.spec.ts 一致策略）
 *
 * 选择器说明：所有用户可见文案来自 i18n（zh-CN），spec 通过 fixedLocale 固定 zh-CN
 */

// 打开「设置 → 安全」分区
async function openSecuritySettings(page: Page) {
  await waitForAppReady(page)
  await unlockIfNeeded(page)

  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })

  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
}

// 切到 SecuritySettings 内的指定 Tab（凭据 / OAuth 应用 / SSH 密钥 / 锁定 / 访问令牌）
async function switchSecurityTab(page: Page, tabLabel: string) {
  // naive-ui NTabs 渲染的 tab 触发器包含 label 文本
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: tabLabel }).click()
}

test.describe('凭据管理 E2E', () => {
  test.beforeEach(async ({ page }) => {
    await fixedLocale(page)
    await page.goto('/')
    await openSecuritySettings(page)
    // 默认进「凭据」Tab
    await switchSecurityTab(page, '凭据')
    // 等待 CredentialList 渲染完成
    await expect(page.locator('.credential-list')).toBeVisible({ timeout: 3000 })
  })

  test('添加 PAT 凭据后列表显示该条目', async ({ page }) => {
    // 点击「添加 PAT / 密码」按钮（settings.security.credentials.addPAT）
    await page.getByRole('button', { name: '添加 PAT / 密码' }).click()

    // 等待弹窗出现（外层 SettingsModal 也带 .n-modal 类，必须排除，否则 strict mode 命中两个）
    const modal = page.locator('.n-modal:not(.settings-modal)').filter({ hasText: '添加 PAT / 密码' })
    await expect(modal).toBeVisible({ timeout: 3000 })

    // 填表：host / username / secret
    // host 字段 placeholder = 'github.com'（CredentialList.vue line 239）
    await modal.getByPlaceholder('github.com').fill('example.com')
    // username 输入框（无 placeholder）——定位 host 之后的下一个 NInput
    await modal.locator('input').nth(1).fill('testuser')
    // secret 是 password 输入框
    await modal.locator('input[type="password"]').fill('test-secret-pat')

    // 点保存（common.save = '保存'）
    await modal.getByRole('button', { name: '保存' }).click()

    // 等弹窗关闭
    await expect(modal).toHaveCount(0, { timeout: 5000 })

    // 列表出现新条目：host 文本 + username 文本
    await expect(page.locator('.credential-list').getByText('example.com')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.credential-list').getByText('testuser')).toBeVisible()
  })

  test('删除凭据后列表移除该条目', async ({ page }) => {
    // 前置：上一个 test 已添加 example.com；为确保独立，本测试先添加一条
    await page.getByRole('button', { name: '添加 PAT / 密码' }).click()
    const addModal = page.locator('.n-modal:not(.settings-modal)').filter({ hasText: '添加 PAT / 密码' })
    await expect(addModal).toBeVisible({ timeout: 3000 })
    await addModal.getByPlaceholder('github.com').fill('delete-test.example')
    await addModal.locator('input').nth(1).fill('deleteuser')
    await addModal.locator('input[type="password"]').fill('delete-secret')
    await addModal.getByRole('button', { name: '保存' }).click()
    await expect(addModal).toHaveCount(0, { timeout: 5000 })
    await expect(page.locator('.credential-list').getByText('delete-test.example')).toBeVisible({ timeout: 5000 })

    // 触发删除（n-list 内对应条目的「删除」按钮）
    // naive-ui NListItem 渲染为 .n-list-item，定位到含 host 的条目
    const item = page.locator('.credential-list .n-list-item').filter({ hasText: 'delete-test.example' })

    // 删除确认是 confirmDialog（n-modal），不是 window.confirm——
    // 点「删除」后需在弹出的确认弹窗里再点一次「删除」
    await item.getByRole('button', { name: '删除' }).click()
    const confirmModal = page.locator('.n-modal').filter({ hasText: 'delete-test.example' }).last()
    await expect(confirmModal).toBeVisible({ timeout: 3000 })
    await confirmModal.getByRole('button', { name: '删除' }).click()

    // 等待条目消失
    await expect(page.locator('.credential-list').getByText('delete-test.example')).toHaveCount(0, { timeout: 5000 })
  })

  test('添加 OAuth 应用后列表显示 client_id', async ({ page }) => {
    // 切到「OAuth 应用」Tab（settings.security.tabs.oauthClients = 'OAuth 应用'）
    await switchSecurityTab(page, 'OAuth 应用')
    await expect(page.locator('.oauth-client-manager')).toBeVisible({ timeout: 3000 })

    // 点「添加 OAuth 应用」
    await page.getByRole('button', { name: '添加 OAuth 应用' }).click()

    // 弹窗：标题为「配置 OAuth 应用」（settings.security.oauthClients.formTitle）
    const modal = page.locator('.n-modal:not(.settings-modal)').filter({ hasText: '配置 OAuth 应用' })
    await expect(modal).toBeVisible({ timeout: 3000 })

    // 平台默认 GitHub（platformOptions[0].value = 'github'），无需手动切换
    // host：placeholder 随 platform 切换为 'github.com'
    await modal.getByPlaceholder('github.com').fill('github.com')
    // Client ID 输入框：form-item label='Client ID'，定位其后的 NInput
    const clientIdInput = modal.locator('.n-form-item').filter({ hasText: 'Client ID' }).locator('input')
    await clientIdInput.fill('ghp_e2e_test_client_id')

    // Client Secret 可选，跳过（Device Flow 不需要）

    // 保存
    await modal.getByRole('button', { name: '保存' }).click()
    await expect(modal).toHaveCount(0, { timeout: 5000 })

    // 列表渲染新条目：含 client_id
    await expect(page.locator('.oauth-client-manager').getByText('ghp_e2e_test_client_id')).toBeVisible({ timeout: 5000 })
  })

  test('github.com 的凭据显示 GitHub 平台 tag', async ({ page }) => {
    // 在「凭据」Tab 添加一条 github.com 的 PAT
    await page.getByRole('button', { name: '添加 PAT / 密码' }).click()
    const modal = page.locator('.n-modal:not(.settings-modal)').filter({ hasText: '添加 PAT / 密码' })
    await expect(modal).toBeVisible({ timeout: 3000 })
    await modal.getByPlaceholder('github.com').fill('github.com')
    await modal.locator('input').nth(1).fill('githubuser')
    await modal.locator('input[type="password"]').fill('ghp_token')
    await modal.getByRole('button', { name: '保存' }).click()
    await expect(modal).toHaveCount(0, { timeout: 5000 })

    // 后端 platform 字段识别为 'github'，前端渲染 t('credential.platform.github') = 'GitHub'
    // 验证列表中出现 GitHub tag
    await expect(page.locator('.credential-list .n-tag').filter({ hasText: 'GitHub' }).first()).toBeVisible({ timeout: 5000 })
  })
})
