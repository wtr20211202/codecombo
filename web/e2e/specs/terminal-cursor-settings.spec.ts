import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端光标形态与闪烁设置 E2E（P-20261005-212）：
 *   ① 缺省 block+闪烁（xterm DOM renderer 光标类 xterm-cursor-block/xterm-cursor-blink，
 *      自动化环境 navigator.webdriver 无 WebGL 恒走 DOM renderer）；设置·终端两直写行
 *      改动即时落 localStorage（font-settings）且运行中会话 watch 直写 term.options
 *      即时生效——同一挂载 pane 光标类跟随切换、无重挂；恢复默认回 block+闪烁
 *   ② 创建期路径：font-settings 预置 underline+不闪 → 新挂载 pane 初装 options 生效
 *      （光标类 xterm-cursor-underline 且无 xterm-cursor-blink）
 * 形态类断言聚焦后进行——失焦光标走 cursorInactiveStyle（outline 缺省）不带形态类。
 */

/** 打开项目终端（底部面板 + 有终端 tab + xterm 就绪），返回可见屏定位器。
 *  cursorSeed 预置光标偏好（font store load 时与默认值合并，只写光标字段即可） */
async function openTerminal(page: import('@playwright/test').Page, cursorSeed?: { cursorStyle?: string; cursorBlink?: boolean }) {
  await fixedLocale(page)
  if (cursorSeed) {
    await page.addInitScript((seed) => {
      localStorage.setItem('font-settings', JSON.stringify(seed))
    }, cursorSeed)
  }
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击，先收起
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }

  // 引导恢复落定拍：uiState 面板开合异步晚到会翻转归零后的首个 rail 点击语义
  await page.waitForTimeout(600)
  // 归一化：底部终端面板可见（rail 钮 toggle 语义覆盖三种恢复态）
  for (let i = 0; i < 4; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 8000 })
  if ((await page.locator('.term-tab').count()) === 0) {
    await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 8000 })
  }
  const screen = page.locator('.xterm-screen:visible').last()
  await expect(screen).toBeVisible({ timeout: 20000 })
  return screen
}

/** 可见终端的 xterm 光标元素（.last() = 当前活跃屏，多 tab 时旧屏 DOM 序在前） */
function visibleCursor(page: import('@playwright/test').Page) {
  return page.locator('.xterm-rows .xterm-cursor:visible').last()
}

/** 打开设置弹窗并切入终端分区（分区语义锚点，不依赖导航序下标） */
async function openTerminalSettingsPane(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-terminal"]').click()
  await expect(page.locator('[data-testid="settings-pane-terminal"]')).toBeVisible({ timeout: 3000 })
}

test('缺省 block+闪烁；改设置即时生效于运行中会话并持久化；恢复默认双向回切', async ({ page }) => {
  const screen = await openTerminal(page)

  // 缺省（block+闪烁）：聚焦后光标元素带两类别
  await screen.click()
  const cursor = visibleCursor(page)
  await expect(cursor).toHaveClass(/xterm-cursor-block/, { timeout: 8000 })
  await expect(cursor).toHaveClass(/xterm-cursor-blink/)

  // 设置·终端：光标形态改「竖条」+ 闪烁关——两直写行即时落 localStorage 并出修改标记
  await openTerminalSettingsPane(page)
  const styleRow = page.locator('[data-testid="settings-terminal-cursor"]')
  const blinkRow = page.locator('[data-testid="settings-terminal-cursor-blink"]')
  await expect(styleRow).toBeVisible({ timeout: 3000 })
  // 出厂默认 → 无已修改标记
  await expect(styleRow.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  await expect(blinkRow.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)

  await styleRow.locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '竖条' }).click()
  await expect(styleRow.locator('[data-testid="settings-modified-mark"]')).toBeVisible()
  await blinkRow.locator('.n-switch').click()
  await expect(blinkRow.locator('[data-testid="settings-modified-mark"]')).toBeVisible()
  let stored = await page.evaluate(() => localStorage.getItem('font-settings'))
  expect(JSON.parse(stored || '{}')?.cursorStyle).toBe('bar')
  expect(JSON.parse(stored || '{}')?.cursorBlink).toBe(false)

  // 直写行不参与 isDirty：Esc 直接关弹窗（脏护栏不误拦），终端 pane 保持挂载
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })

  // 运行中会话即时生效：同一挂载 pane 光标类跟随（bar + 无闪烁），无需重挂/重连
  await screen.click()
  await expect(cursor).toHaveClass(/xterm-cursor-bar/, { timeout: 8000 })
  await expect(cursor).not.toHaveClass(/xterm-cursor-blink/)

  // 单行恢复默认：值与标记同复原，localStorage 回 block+闪烁；光标类跟随回切
  await openTerminalSettingsPane(page)
  await styleRow.locator('[data-testid="settings-restore-default"]').click()
  await expect(styleRow.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  await blinkRow.locator('[data-testid="settings-restore-default"]').click()
  await expect(blinkRow.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  stored = await page.evaluate(() => localStorage.getItem('font-settings'))
  expect(JSON.parse(stored || '{}')?.cursorStyle).toBe('block')
  expect(JSON.parse(stored || '{}')?.cursorBlink).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
  await screen.click()
  await expect(cursor).toHaveClass(/xterm-cursor-block/, { timeout: 8000 })
  await expect(cursor).toHaveClass(/xterm-cursor-blink/)
})

test('创建期路径：预置 underline+不闪，新挂载 pane 初装 options 生效', async ({ page }) => {
  const screen = await openTerminal(page, { cursorStyle: 'underline', cursorBlink: false })
  await screen.click()
  const cursor = visibleCursor(page)
  await expect(cursor).toHaveClass(/xterm-cursor-underline/, { timeout: 8000 })
  await expect(cursor).not.toHaveClass(/xterm-cursor-blink/)
})
