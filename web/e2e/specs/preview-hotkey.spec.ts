import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 预览面板直达键（P-20261002-69）：Ctrl/Cmd+Shift+V 切换端口预览面板，
 * toggle 语义与 Ctrl+` 终端键对齐（未开或非 preview tab → 开面板落 preview；
 * 已是 preview 态 → 收起）。键位注册进 keymap 默认表（P-28）可改键：
 *   ① 直达键开面板且 preview tab 激活 → 再按收起 → 再按重开（循环完整）
 *   ② 注册表驱动：设置→快捷键出现 previewToggle 行（默认键展示）；
 *      改绑 Ctrl+Alt+V 后新键生效、旧键失效；恢复默认后默认键回归
 * 纯前端链路，用种子项目 simple-coding；键位覆盖随浏览器上下文隔离，
 * 面板开合经服务端 uiState 恢复可能跨用例残留——用例开头先幂等归零。
 */

async function openProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击，先收起
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 幂等归零：引导恢复可能带着上次会话的面板开合态，先收起底部面板。
 *  归零前等一拍引导恢复落定——uiState 面板态异步晚到会翻转首个 toggle 的语义 */
async function closeBottomPanelIfOpen(page: import('@playwright/test').Page) {
  await page.waitForTimeout(600)
  if (await page.locator('.bottom-panel').isVisible().catch(() => false)) {
    await page.locator('.bottom-header button[title="关闭"]').click()
    await expect(page.locator('.bottom-panel')).toBeHidden()
  }
}

test('Ctrl+Shift+V 直达预览面板：开面板落 preview tab，再按收起，可循环', async ({ page }) => {
  await openProject(page)
  await closeBottomPanelIfOpen(page)

  // 直达键开面板：.preview-panel 仅在 preview tab 下渲染（BottomPanel v-if），
  // 其可见即「面板开且 preview tab 激活」
  await page.keyboard.press('Control+Shift+V')
  await expect(page.locator('.bottom-panel')).toBeVisible()
  await expect(page.locator('.preview-panel')).toBeVisible()

  // toggle 语义：已是 preview 态再按收起（面板 v-show 隐藏，preview 内容随之不可见）
  await page.keyboard.press('Control+Shift+V')
  await expect(page.locator('.bottom-panel')).toBeHidden()
  await expect(page.locator('.preview-panel')).toBeHidden()

  // 再按重开：循环完整，且仍落 preview tab
  await page.keyboard.press('Control+Shift+V')
  await expect(page.locator('.preview-panel')).toBeVisible()
})

test('keymap 注册表驱动：默认键展示，改绑后新键生效旧键失效，恢复默认回归', async ({ page }) => {
  await openProject(page)
  await closeBottomPanelIfOpen(page)

  // 注册表自动出现 previewToggle 行，默认键 Ctrl+Shift+V
  await page.locator('.rail-btn[title="设置"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '快捷键' }).click()
  await expect(page.locator('[data-testid="keymap-list"]')).toBeVisible()
  const combo = page.locator('[data-testid="keymap-combo-previewToggle"]')
  await expect(page.locator('[data-testid="keymap-row-previewToggle"]')).toBeVisible()
  await expect(combo).toContainText('Ctrl')
  await expect(combo).toContainText('Shift')
  await expect(combo).toContainText('V')

  // 改绑 Ctrl+Shift+V → Ctrl+Alt+V（撞 clipHistoryPaste 既有键位 → 保存时冲突
  // 警示，P-20261003-106；确认「仍要保存」后接管生效）
  await page.locator('[data-testid="keymap-change-previewToggle"]').click()
  await expect(combo).toContainText('按下新组合键')
  await page.keyboard.press('Control+Alt+V')
  const dlg = page.locator('.n-dialog').filter({ hasText: '键位冲突警示' })
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('多剪贴板粘贴')
  await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要保存' }).click()
  await expect(combo).toContainText('Alt')
  await page.locator('.settings-close').click()
  await expect(page.locator('.n-modal.settings-modal')).toHaveCount(0)

  // 新键生效：开面板落 preview tab
  await page.keyboard.press('Control+Alt+V')
  await expect(page.locator('.preview-panel')).toBeVisible()
  // 旧键失效：Ctrl+Shift+V 不再触发 toggle，面板保持打开
  await page.keyboard.press('Control+Shift+V')
  await expect(page.locator('.bottom-panel')).toBeVisible()

  // 恢复默认：默认键回归并立即可用（当前 preview 态 → 再按应收起）
  await page.locator('.rail-btn[title="设置"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '快捷键' }).click()
  await page.locator('[data-testid="keymap-reset-previewToggle"]').click()
  await expect(combo).not.toContainText('Alt')
  await page.locator('.settings-close').click()
  await expect(page.locator('.n-modal.settings-modal')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+V')
  await expect(page.locator('.bottom-panel')).toBeHidden()
})
