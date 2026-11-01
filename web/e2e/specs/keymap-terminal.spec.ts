import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, waitForAppReady, unlockIfNeeded, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端域键位自定义 E2E（P-20261003-111 键位自定义扩展全域·终端域先行）：
 *   ① 改绑终端域键（历史面板 Ctrl+Shift+H → Ctrl+Shift+U）：新键生效、旧键失效、
 *      备忘单跟随展示自定义值、刷新持久、恢复默认回归（无冲突组合直接保存）
 *   ② 跨域冲突警示 + takeover 运行时语义：全局动作（侧栏）改绑到 doc 级终端键
 *      Ctrl+Shift+H → 保存时警示（终端域优先接管）→ 确认后全局行标红、
 *      Ctrl+Shift+H 由终端域接管（历史面板翻转、侧栏不动）→ 恢复默认回归
 * 设置→快捷键按域分组（全局布局 / 终端）随两用例断言。
 * 键位自定义本体在 localStorage（随浏览器上下文隔离，无跨用例串扰）；但 doc 级
 * 终端键的宿主（底部面板）开合经服务端 uiState 持久——openProject 前先播种
 * 终端分区打开（seedTerminalPanelOpen），防前序 spec 残留布局在恢复流翻面。
 */

/** 播种底部终端面板开合（uiState 服务端持久，跨 spec 残留不定态；CLAUDE.md
 *  「uiState 播种时机：种子须在无项目页存活时写入」惯例）：本文件头注的
 *  「测试间 localStorage 隔离」只覆盖键位自定义（真 localStorage），布局开合
 *  走服务端 uiState——前序 spec 留下的收起/他分区态会在 boot 恢复时把本文件
 *  ensureTerminalSection 归一化后的面板翻走（实测新键按压时 .history-panel
 *  挂载但不可见、终端分区单击落空）。页面加载前 PATCH 成终端分区打开，恢复
 *  即落在目标态。GET+合并整键 PATCH：layout 是顶层键整体替换，裸发两字段会
 *  把面板宽高等既有布局抹成默认 */
async function seedTerminalPanelOpen(): Promise<void> {
  const unlock = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await unlock.json()) as { token?: string }).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  const stateRes = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await stateRes.json().catch(() => null)) as { data?: Record<string, { layout?: Record<string, unknown> }> } | null
  const layout = { ...(body?.data?.local?.layout || {}), showBottomPanel: true, bottomTab: 'terminal' }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PATCH', headers, body: JSON.stringify({ local: { layout } }),
  }).catch(() => { /* 尽力播种：失败回退到 ensureTerminalSection 归一化 */ })
}

async function openProject(page: import('@playwright/test').Page) {
  await seedTerminalPanelOpen()
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await ensureTerminalSection(page)
}

/** doc 级终端键的宿主是 TerminalView（底部面板终端分区 v-if 挂载）：uiState 可能
 *  记忆为收起/他分区，先归一化到终端分区再按键（同 snippet-shortcut 前置口径）。
 *  归一化后留稳定窗复验：迟到的 uiState 恢复/联动流会把刚点开的底部面板再翻走
 *  （实测 toBeVisible 后单击可能落空为收起/翻面）——翻转时重新点开并复验，
 *  稳定窗内保持「面板开 + 终端分区激活」才算就位（regression-probe
 *  openBottomGitStable 同款惯例；激活标记 = naive-ui primary-type 按钮） */
async function ensureTerminalSection(page: import('@playwright/test').Page) {
  const panel = page.locator('.bottom-panel')
  const termSection = page.locator('.bottom-tabs button[data-testid="bottom-tab-terminal"]')
  for (let round = 0; round < 3; round++) {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端"]').click()
    }
    // 等开（含本轮点击落空形态）：本轮点击若恰好落在 boot 布局恢复应用之后的
    // 开态上（isVisible 探测为隐藏 → 点击落地时恢复已把面板打开 → toggle 语义
    // 如实收起），此处超时不再抛错——expect 红在循环内会让下方的三轮复驱
    // 策略失效（fulle2e run8 串行负载下恢复迟到实测形态），交给下一轮复驱
    const opened = await panel.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true).catch(() => false)
    if (!opened) continue
    if (await termSection.isVisible().catch(() => false)) {
      await termSection.click().catch(() => { /* 翻转瞬断：下一轮复驱 */ })
    }
    try {
      await expect(termSection).toHaveClass(/primary-type/, { timeout: 1500 })
      await page.waitForTimeout(600)
      await expect(termSection).toHaveClass(/primary-type/, { timeout: 1000 })
      return
    } catch { /* 稳定窗内被翻走：下一轮复驱 */ }
  }
  await expect(termSection).toHaveClass(/primary-type/, { timeout: 5000 })
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
  await ensureTerminalSection(page)
}

/** 键位冲突警示弹窗：标题过滤，避免误中其他弹窗 */
function conflictDialog(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog').filter({ hasText: '键位冲突警示' })
}

test('改绑终端域键 Ctrl+Shift+H → Ctrl+Shift+U：新键生效旧键失效，备忘单跟随，刷新持久，恢复默认回归', async ({ page }) => {
  await openProject(page)

  // 基线：默认键 Ctrl+Shift+H 开历史面板
  await page.keyboard.press('Control+Shift+h')
  await expect(page.locator('.history-panel')).toBeVisible()
  await page.keyboard.press('Control+Shift+h')
  await expect(page.locator('.history-panel')).toHaveCount(0)

  await openKeymapSettings(page)

  // 域分组（P-20261003-111）：全局布局 / 终端两组在列
  await expect(page.locator('[data-testid="keymap-group-global"]')).toContainText('全局布局')
  await expect(page.locator('[data-testid="keymap-group-terminal"]')).toContainText('终端')
  // 终端域默认键位展示
  const combo = page.locator('[data-testid="keymap-combo-terminalHistory"]')
  await expect(combo).toContainText('H')

  // 录入新键：无冲突组合直接保存，不弹冲突警示
  await page.locator('[data-testid="keymap-change-terminalHistory"]').click()
  await expect(combo).toContainText('按下新组合键')
  await page.keyboard.press('Control+Shift+u')
  await expect(conflictDialog(page)).toHaveCount(0)
  await expect(combo).toContainText('U')
  await expect(page.locator('[data-testid="keymap-custom-terminalHistory"]')).toContainText('自定义')

  // 旧键失效：Ctrl+Shift+H 不再开历史面板；新键生效（再按关闭，开关语义）
  await closeSettings(page)
  // 键盘驱动的面板翻转断言前先归一化宿主分区（设置弹窗开合期间迟到的
  // 恢复/联动可能已把底部面板翻走——面板开关是 toggle 语义，盲按会空翻）
  await ensureTerminalSection(page)
  await page.keyboard.press('Control+Shift+h')
  await expect(page.locator('.history-panel')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+u')
  await expect(page.locator('.history-panel')).toBeVisible()
  await page.keyboard.press('Control+Shift+u')
  await expect(page.locator('.history-panel')).toHaveCount(0)

  // 备忘单（?）跟随展示自定义值：终端组历史行键位为 U
  await page.keyboard.press('?')
  const help = page.locator('.sc-help')
  await expect(help).toBeVisible({ timeout: 3000 })
  await page.locator('.sc-help-filter input').fill('命令历史')
  const helpRow = page.locator('.sc-help-row').filter({ hasText: '命令历史面板' }).first()
  await expect(helpRow).toBeVisible()
  await expect(helpRow).toContainText('U')
  await expect(helpRow).not.toContainText('H')
  // 关闭走关闭按钮（Esc 两段式首段清过滤，按键流不确定性高）
  await help.locator('.sc-help-close').click()
  await expect(help).toHaveCount(0)

  // 刷新后覆盖持久（localStorage）
  await reloadIntoProject(page)
  await page.keyboard.press('Control+Shift+h')
  await expect(page.locator('.history-panel')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+u')
  await expect(page.locator('.history-panel')).toBeVisible()
  await page.keyboard.press('Control+Shift+u')
  await expect(page.locator('.history-panel')).toHaveCount(0)

  // 恢复默认：原键回归、自定义徽标消失
  await openKeymapSettings(page)
  await page.locator('[data-testid="keymap-reset-terminalHistory"]').click()
  await expect(combo).toContainText('H')
  await expect(page.locator('[data-testid="keymap-custom-terminalHistory"]')).not.toContainText('自定义')
  await closeSettings(page)
  await ensureTerminalSection(page)
  await page.keyboard.press('Control+Shift+u')
  await expect(page.locator('.history-panel')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+h')
  await expect(page.locator('.history-panel')).toBeVisible()
})

test('跨域冲突警示与 takeover 运行时：全局侧栏改绑 Ctrl+Shift+H，终端域优先接管，确认后全局行标红', async ({ page }) => {
  await openProject(page)
  await openKeymapSettings(page)

  // 全局动作（侧栏）改绑到 doc 级终端键 Ctrl+Shift+H → 跨域警示：终端域优先接管
  await page.locator('[data-testid="keymap-change-toggleSidebar"]').click()
  await page.keyboard.press('Control+Shift+h')
  const dlg = conflictDialog(page)
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('终端域')
  await expect(dlg).toContainText('开关命令历史面板')

  // 确认「仍要保存」后落盘：全局行标红（被终端域动作接管），终端侧行不标红
  await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要保存' }).click()
  await expect(page.locator('[data-testid="keymap-conflict-toggleSidebar"]')).toBeVisible()
  await expect(page.locator('[data-testid="keymap-conflict-toggleSidebar"]')).toContainText('开关命令历史面板')
  await expect(page.locator('[data-testid="keymap-conflict-terminalHistory"]')).toHaveCount(0)

  // 运行时 takeover 如实：Ctrl+Shift+H 由终端域接管（历史面板翻转），侧栏不动
  await closeSettings(page)
  const sideBefore = await page.locator('#side-panel').isVisible()
  await page.keyboard.press('Control+Shift+h')
  await expect(page.locator('.history-panel')).toBeVisible()
  if (sideBefore) {
    await expect(page.locator('#side-panel')).toBeVisible()
  } else {
    await expect(page.locator('#side-panel')).toBeHidden()
  }
  // 再按关闭历史面板（开关语义）
  await page.keyboard.press('Control+Shift+h')
  await expect(page.locator('.history-panel')).toHaveCount(0)

  // 旧键 Ctrl+B 已无动作绑定：侧栏不动（改绑离场即失效）
  await page.keyboard.press('Control+b')
  if (sideBefore) {
    await expect(page.locator('#side-panel')).toBeVisible()
  } else {
    await expect(page.locator('#side-panel')).toBeHidden()
  }

  // 恢复默认出口：重置后 Ctrl+B 回归、冲突标红消失
  await openKeymapSettings(page)
  await page.locator('[data-testid="keymap-reset-toggleSidebar"]').click()
  await expect(page.locator('[data-testid="keymap-conflict-toggleSidebar"]')).toHaveCount(0)
  await closeSettings(page)
  await page.keyboard.press('Control+b')
  if (sideBefore) {
    await expect(page.locator('#side-panel')).toBeHidden()
  } else {
    await expect(page.locator('#side-panel')).toBeVisible()
  }
})
