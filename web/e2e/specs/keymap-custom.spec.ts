import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, waitForAppReady, unlockIfNeeded, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 全局快捷键自定义 E2E（P-20261002-28 + P-20261003-106 保存时冲突警示）：
 *   ① 改 Ctrl+P 为 Ctrl+Alt+P：原键失效、新键生效、刷新后持久、恢复默认回归
 *      （无冲突组合直接保存，不弹警示）
 *   ② 撞键实时标红：后注册动作（大纲）改绑到 Ctrl+P 与先注册动作（快速打开）
 *      撞键 → 保存时警示弹窗（含对方功能名）→ 确认后大纲行标红、
 *      Ctrl+P 仍由快速打开优先生效
 *   ③ 浏览器保留键拦截：录入 Ctrl+N 被拒绝（提示 + 保持捕获 + 键位不变）
 *   ④ 跨域占用键警示：改绑编辑器域注册表动作键 Ctrl+S（P-20261008-14 起
 *      editorSave 入注册表）→ 警示含对方域与功能名（编辑器·保存当前文件）→
 *      取消不落盘、确认后覆盖生效、行标红、
 *      非编辑器焦点下 Ctrl+S 触发布局动作（覆盖如实）
 *   ⑤ 注册序接管警示：先注册动作（快速打开）改绑到后注册动作键位（大纲
 *      Ctrl+Shift+O）→ 警示含对方功能名 → 确认后对方被遮蔽标红、
 *      Ctrl+Shift+O 改由快速打开响应（保存将覆盖如实）
 * 纯前端链路（localStorage 覆盖），用种子项目 simple-coding；测试间 localStorage
 * 随浏览器上下文隔离，无跨用例串扰。
 */

async function openProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

async function openKeymapSettings(page: import('@playwright/test').Page) {
  await page.locator('.rail-btn[title="设置"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '快捷键' }).click()
  await expect(page.locator('[data-testid="keymap-list"]')).toBeVisible()
}

async function closeSettings(page: import('@playwright/test').Page) {
  await page.locator('.settings-close').click()
  await expect(page.locator('.n-modal.settings-modal')).toHaveCount(0)
}

/** 刷新后停留在项目视图（uiState 引导恢复），等 boot 遮罩消失即可继续按键 */
async function reloadIntoProject(page: import('@playwright/test').Page) {
  await page.reload()
  await waitForAppReady(page)
  await unlockIfNeeded(page)
}

/** 键位冲突警示弹窗（P-20261003-106）：确认对话框标题过滤，避免误中其他弹窗 */
function conflictDialog(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog').filter({ hasText: '键位冲突警示' })
}

test('改绑 Ctrl+P → Ctrl+Alt+P：原键失效新键生效，刷新持久，恢复默认回归', async ({ page }) => {
  await openProject(page)
  await openKeymapSettings(page)

  // 默认键位展示
  const combo = page.locator('[data-testid="keymap-combo-quickOpen"]')
  await expect(combo).toContainText('Ctrl')
  await expect(combo).not.toContainText('Alt')

  // 录入新键：无冲突组合直接保存，不弹冲突警示
  await page.locator('[data-testid="keymap-change-quickOpen"]').click()
  await expect(combo).toContainText('按下新组合键')
  await page.keyboard.press('Control+Alt+P')
  await expect(conflictDialog(page)).toHaveCount(0)
  await expect(combo).toContainText('Alt')

  // 原键失效：Ctrl+P 不再唤起快速打开
  await closeSettings(page)
  await page.keyboard.press('Control+p')
  await expect(page.locator('.palette-card')).toHaveCount(0)

  // 新键生效：Ctrl+Alt+P 唤起快速打开（非命令模式徽标）
  await page.keyboard.press('Control+Alt+p')
  await expect(page.locator('.palette-card')).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.palette-mode-badge')).not.toContainText('命令')
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-card')).toHaveCount(0)

  // 刷新后覆盖持久（localStorage）
  await reloadIntoProject(page)
  await page.keyboard.press('Control+p')
  await expect(page.locator('.palette-card')).toHaveCount(0)
  await page.keyboard.press('Control+Alt+p')
  await expect(page.locator('.palette-card')).toBeVisible({ timeout: 3000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-card')).toHaveCount(0)

  // 恢复默认：原键回归、自定义徽标消失
  await openKeymapSettings(page)
  await expect(page.locator('[data-testid="keymap-custom-quickOpen"]')).toContainText('自定义')
  await page.locator('[data-testid="keymap-reset-quickOpen"]').click()
  await expect(page.locator('[data-testid="keymap-combo-quickOpen"]')).not.toContainText('Alt')
  await closeSettings(page)
  await page.keyboard.press('Control+p')
  await expect(page.locator('.palette-card')).toBeVisible({ timeout: 3000 })
})

test('撞键实时标红：大纲改绑 Ctrl+P 警示含对方功能名，确认后被先注册的快速打开遮蔽', async ({ page }) => {
  await openProject(page)
  await openKeymapSettings(page)

  // 大纲（注册序靠后）改绑到 Ctrl+P → 与快速打开撞键：保存时警示含对方功能名
  await page.locator('[data-testid="keymap-change-outline"]').click()
  await page.keyboard.press('Control+p')
  const dlg = conflictDialog(page)
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('按名称打开文件')
  // 确认「仍要保存」后落盘：大纲行标红
  await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要保存' }).click()
  await expect(page.locator('[data-testid="keymap-conflict-outline"]')).toBeVisible()
  await expect(page.locator('[data-testid="keymap-conflict-outline"]')).toContainText('按名称打开文件')
  // 先注册者（快速打开）不标红
  await expect(page.locator('[data-testid="keymap-conflict-quickOpen"]')).toHaveCount(0)

  // 运行时优先序：Ctrl+P 仍由先注册的快速打开生效（大纲改绑被遮蔽不触发）
  await closeSettings(page)
  await page.keyboard.press('Control+p')
  await expect(page.locator('.palette-card')).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.palette-mode-badge')).not.toContainText('命令')
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-card')).toHaveCount(0)

  // 大纲恢复默认后冲突消失
  await openKeymapSettings(page)
  await page.locator('[data-testid="keymap-reset-outline"]').click()
  await expect(page.locator('[data-testid="keymap-conflict-outline"]')).toHaveCount(0)
})

test('浏览器保留键拦截：录入 Ctrl+N 被拒绝且保持捕获态', async ({ page }) => {
  await openProject(page)
  await openKeymapSettings(page)

  const combo = page.locator('[data-testid="keymap-combo-commandPalette"]')
  await expect(combo).toContainText('Ctrl')
  await page.locator('[data-testid="keymap-change-commandPalette"]').click()
  // Ctrl+N 是浏览器保留键：拒绝 + 错误提示 + 继续等待下一次录入
  await page.keyboard.press('Control+n')
  await expect(page.locator('.n-message')).toBeVisible({ timeout: 3000 })
  await expect(combo).toContainText('按下新组合键')
  // Esc 取消捕获，键位保持默认
  await page.keyboard.press('Escape')
  await expect(combo).not.toContainText('按下新组合键')
  await expect(combo).toContainText('Ctrl')
  await expect(page.locator('[data-testid="keymap-custom-commandPalette"]')).not.toContainText('自定义')

  // Ctrl+K 命令面板默认键未受影响
  await closeSettings(page)
  await page.keyboard.press('Control+k')
  await expect(page.locator('.palette-card')).toBeVisible({ timeout: 3000 })
})

test('跨域占用键警示：改绑编辑器 Ctrl+S 警示含对方功能名，取消不落盘、确认后覆盖生效并标红', async ({ page }) => {
  await openProject(page)
  await openKeymapSettings(page)

  // 录入编辑器域注册表动作 editorSave 的默认键 Ctrl+S（P-20261008-14 起编辑器
  // 自定义动作入注册表）：跨域警示含对方域与动作名
  const combo = page.locator('[data-testid="keymap-combo-toggleSidebar"]')
  await page.locator('[data-testid="keymap-change-toggleSidebar"]').click()
  await page.keyboard.press('Control+s')
  const dlg = conflictDialog(page)
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('编辑器')
  await expect(dlg).toContainText('保存当前文件')

  // 取消：不落盘（键位未变）、保持捕获态可继续录入
  await dlg.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(dlg).toHaveCount(0)
  await expect(combo).toContainText('按下新组合键')
  await expect(page.locator('[data-testid="keymap-custom-toggleSidebar"]')).not.toContainText('自定义')

  // 再次录入并确认「仍要保存」：覆盖生效、行标红（跨域焦点域共存提示）
  await page.keyboard.press('Control+s')
  const dlg2 = conflictDialog(page)
  await expect(dlg2).toBeVisible()
  await dlg2.locator('.n-dialog__action button').filter({ hasText: '仍要保存' }).click()
  await expect(combo).toContainText('S')
  await expect(page.locator('[data-testid="keymap-conflict-toggleSidebar"]')).toBeVisible()
  await expect(page.locator('[data-testid="keymap-conflict-toggleSidebar"]')).toContainText('保存当前文件')

  // 覆盖如实：非编辑器焦点下 Ctrl+S 由布局动作接管（侧栏开合翻转），编辑器域
  // 分层共存语义下未开编辑器即全局生效
  await closeSettings(page)
  const sideBefore = await page.locator('#side-panel').isVisible()
  await page.keyboard.press('Control+s')
  if (sideBefore) {
    await expect(page.locator('#side-panel')).toBeHidden()
  } else {
    await expect(page.locator('#side-panel')).toBeVisible()
  }

  // 恢复默认出口保留：重置后 Ctrl+B 回归、冲突标红消失
  await openKeymapSettings(page)
  await page.locator('[data-testid="keymap-reset-toggleSidebar"]').click()
  await expect(page.locator('[data-testid="keymap-conflict-toggleSidebar"]')).toHaveCount(0)
  await expect(combo).toContainText('B')
})

test('注册序接管警示：先注册动作改绑后注册动作键位，确认后对方被遮蔽标红且按键改由本动作响应', async ({ page }) => {
  await openProject(page)
  await openKeymapSettings(page)

  // quickOpen（注册序先于 outline）改绑到 Ctrl+Shift+O：警示含对方功能名（文件大纲）
  await page.locator('[data-testid="keymap-change-quickOpen"]').click()
  await page.keyboard.press('Control+Shift+o')
  const dlg = conflictDialog(page)
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('文件大纲')
  await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要保存' }).click()

  // 被遮蔽方（大纲，注册序靠后）行标红
  await expect(page.locator('[data-testid="keymap-conflict-outline"]')).toBeVisible()
  await closeSettings(page)

  // 覆盖如实：Ctrl+Shift+O 现在唤起快速打开（原大纲动作被接管不再响应）
  await page.keyboard.press('Control+Shift+o')
  await expect(page.locator('.palette-card')).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.palette-mode-badge')).not.toContainText('命令')
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-card')).toHaveCount(0)

  // 恢复默认：接管解除，大纲行冲突标红随之消失
  await openKeymapSettings(page)
  await page.locator('[data-testid="keymap-reset-quickOpen"]').click()
  await expect(page.locator('[data-testid="keymap-conflict-outline"]')).toHaveCount(0)
})
