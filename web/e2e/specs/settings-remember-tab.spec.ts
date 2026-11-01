import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 设置弹窗记住上次分区 E2E（P-20261002-35）：
 *   - 切到安全分区 → 关弹窗 → 整页刷新 → 再开：仍停在上次的安全分区
 *   - 命令面板「打开设置：通用」直达优先于记忆的分区
 *   - localStorage 残留非法分区值（分区改名/删除）时回落通用
 * 全程不改动任何设置值，不点保存，不污染共享实例（localStorage 每用例独立上下文）。
 */

// 与 SettingsModal.vue 的 LAST_TAB_KEY 对应（存储契约键）
const LAST_TAB_KEY = 'sc.settings.lastTab'

async function openSettings(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
}

function visibleTitle(page: import('@playwright/test').Page) {
  return page.locator('.settings-modal .content-pane:visible .pane-title')
}

test('切到安全分区关闭后整页重进，仍停在上次的安全分区', async ({ page }) => {
  await openSettings(page)

  const nav = page.locator('.settings-nav')
  await nav.locator('.nav-item').filter({ hasText: '安全' }).click()
  await expect(visibleTitle(page)).toHaveText('安全')

  // 安全为即时操作分区（无保存按钮、无未保存护栏），Esc 直接关闭
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })

  // gotoAndUnlock 重新 page.goto = 整页刷新：组件重新挂载，localStorage（同一浏览器上下文）保留
  await openSettings(page)
  await expect(nav.locator('.nav-item').filter({ hasText: '安全' })).toHaveClass(/active/)
  await expect(visibleTitle(page)).toHaveText('安全')
})

test('命令面板「打开设置：通用」直达优先于记忆的安全分区', async ({ page }) => {
  await openSettings(page)

  const nav = page.locator('.settings-nav')
  // 先制造记忆：切到安全分区再关闭
  await nav.locator('.nav-item').filter({ hasText: '安全' }).click()
  await expect(visibleTitle(page)).toHaveText('安全')
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })

  // 弹窗关闭状态下命令面板直达「通用」：外部直达必须压过记忆的「安全」
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>打开设置：通用')
  const item = page.locator('.palette-item').filter({ hasText: '打开设置：通用' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await expect(visibleTitle(page)).toHaveText('通用')
})

test('localStorage 残留非法分区值时回落通用', async ({ page }) => {
  // 模拟分区改名/删除后存储残留旧键：恢复时对分区表校验，不认识就回 general
  await page.addInitScript(([key]) => {
    localStorage.setItem(key, 'no-such-tab')
  }, [LAST_TAB_KEY])

  await openSettings(page)

  const nav = page.locator('.settings-nav')
  await expect(nav.locator('.nav-item').first()).toHaveClass(/active/)
  await expect(visibleTitle(page)).toHaveText('通用')
})
