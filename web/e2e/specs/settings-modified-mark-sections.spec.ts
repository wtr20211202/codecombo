import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 设置行修改标记分区补全 E2E（P-20261006-49，组件与语义沿用 P-20261003-171）：
 *   - 安全分区（即时操作面）：TLS 实例间校验开关改后出标记，恢复钮 tooltip 注明
 *     「降低防护」方向性；恢复默认后标记消失——全程只动本地 pending，不点保存，
 *     不污染共享实例的服务端设置
 *   - 安全分区·锁定：自动锁定开关改后出标记，方向性 tooltip 为「升高防护」
 *     （锁定族出厂默认=开，恢复即升防护）
 *   - 通知分区（暂存面）：等待音效关后出标记，恢复后与已存值一致，Esc 直接关
 *     弹窗（isDirty 护栏不误拦）
 *   - Git 分区：user.name 输入后出标记，恢复=清空跟随全局（默认空）
 */

type PaneKey = 'general' | 'appearance' | 'terminal' | 'git' | 'security' | 'notifications'

async function openSettingsPane(page: import('@playwright/test').Page, tab: PaneKey) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  // 分区语义锚点（P-20261002-151）：不依赖导航序下标
  await page.locator(`[data-testid="settings-nav-${tab}"]`).click()
  await expect(page.locator(`[data-testid="settings-pane-${tab}"]`)).toBeVisible({ timeout: 3000 })
}

test('安全·TLS：实例间校验改后出标记，恢复钮注明降低防护，恢复后标记消失', async ({ page }) => {
  await openSettingsPane(page, 'security')

  // 安全分区是 n-tabs 子页签（非左栏分区）：切到 TLS 页签
  await page.locator('[data-testid="settings-pane-security"] .n-tabs-tab', { hasText: 'TLS' }).click()
  const row = page.locator('[data-testid="settings-tls-verify-peer"]')
  await expect(row).toBeVisible({ timeout: 3000 })

  // 出厂默认（TOFU 弱校验，关）→ 无标记
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)

  // 开启强校验（本地 pending，不点保存）→ 行尾出标记+恢复钮
  await row.locator('.n-switch').click()
  const mark = row.locator('[data-testid="settings-modified-mark"]')
  await expect(mark).toBeVisible()
  await expect(mark.locator('[data-testid="settings-restore-default"]')).toBeVisible()
  // 方向性 tooltip（提案②）：该行恢复默认=回到 TOFU 弱校验=降低防护
  await expect(mark.locator('[data-testid="settings-restore-default"]')).toHaveAttribute('title', /降低防护/)

  // 恢复默认：开关回 TOFU、标记消失；安全分区无 isDirty（不在护栏链），Esc 直接关
  await mark.locator('[data-testid="settings-restore-default"]').click()
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})

test('安全·锁定：自动锁定已改即出标记，恢复钮注明升高防护，恢复后标记消失', async ({ page }) => {
  await openSettingsPane(page, 'security')

  await page.locator('[data-testid="settings-pane-security"] .n-tabs-tab', { hasText: '锁定' }).click()
  const row = page.locator('[data-testid="settings-lock-autolock"]')
  await expect(row).toBeVisible({ timeout: 3000 })

  // e2e 播种显式关闭自动锁定（scripts/e2e-seed.sh「autoLock 一并关闭防长套件
  // 中途自动回锁」），而锁定族出厂默认=开——该行因此稳定处于「已修改」态，
  // 标记+升高防护方向性 tooltip 常显（本地 pending，不点保存不落盘）
  const mark = row.locator('[data-testid="settings-modified-mark"]')
  await expect(mark).toBeVisible({ timeout: 3000 })
  await expect(mark.locator('[data-testid="settings-restore-default"]')).toHaveAttribute('title', /升高防护/)

  // 恢复默认：开关回到开启（升高防护方向），标记消失
  await mark.locator('[data-testid="settings-restore-default"]').click()
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  await expect(row.locator('.n-switch')).toHaveAttribute('aria-checked', 'true')
})

test('安全·审计：保留期改后出标记，恢复默认回到 30 天', async ({ page }) => {
  await openSettingsPane(page, 'security')

  await page.locator('[data-testid="settings-pane-security"] .n-tabs-tab', { hasText: '审计' }).click()
  const row = page.locator('[data-testid="settings-retention"] .cred-row').first()
  await expect(row).toBeVisible({ timeout: 3000 })
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)

  // 审计保留 30 → 45（本地 pending，不点保存）→ 出标记
  await row.locator('input').fill('45')
  await row.locator('input').blur()
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toBeVisible()

  await row.locator('[data-testid="settings-restore-default"]').click()
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  await expect(row.locator('input')).toHaveValue('30')
})

test('通知：等待音效关后出标记，恢复后 Esc 直接关（脏护栏不误拦）', async ({ page }) => {
  await openSettingsPane(page, 'notifications')

  const row = page.locator('[data-testid="settings-notification-sound"] .setting-row')
  await expect(row).toBeVisible({ timeout: 3000 })
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)

  // 关闭等待音效（本地编辑副本，默认开）→ 出标记
  await row.locator('.n-checkbox').click()
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toBeVisible()

  // 恢复默认：与已存值一致 → 无未保存修改，Esc 直接关弹窗而非弹护栏
  await row.locator('[data-testid="settings-restore-default"]').click()
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})

test('Git：用户名输入后出标记，恢复默认清空跟随全局', async ({ page }) => {
  await openSettingsPane(page, 'git')

  const row = page.locator('[data-testid="settings-git-user-name"]')
  await expect(row).toBeVisible({ timeout: 3000 })

  // 输入项目级用户名 → 出标记（出厂默认=空=跟随全局）
  await row.locator('input').fill('sc-e2e-mark-check')
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toBeVisible()

  // 恢复默认：清空输入回到「跟随全局」；不点保存、不断言 Esc（项目既有 git
  // 配置可能非空，恢复后相对快照为脏属预期语义，护栏弹窗已由 P-171 spec 守护）
  await row.locator('[data-testid="settings-restore-default"]').click()
  await expect(row.locator('input')).toHaveValue('')
  await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
})
