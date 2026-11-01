import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端 Ctrl+滚轮字号手势（P-20261002-87，对标编辑器 Monaco 的 Ctrl+滚轮缩放）：
 *   ① 终端上 Ctrl+滚轮上/下：全局终端字号 ±1（.term-font-value 跟随；改的是
 *      font store 的持久化值，与设置页滑条/Ctrl+=、- 快捷键同源）
 *   ② 字号变化联动 xterm fit：字形度量变化后行列重算（同高度可容行数减少）
 *   ③ 无修饰滚轮不拦截：字号不变、页面不缩放，xterm 原生滚动照常
 * 字号经 addInitScript 预置为 16（远离 10–32 上下限，步进方向恒可用）；
 * wheel 事件用 page.mouse.wheel 合成，Ctrl 修饰经 keyboard.down 注入。
 */

/** 终端字号基座：面板打开 + 有终端 tab + xterm 就绪，返回可见屏定位器。
 *  seedSize 预置持久化字号（font store load 时与默认值合并，只写 terminal 字段即可） */
async function openTerminal(page: import('@playwright/test').Page, seedSize = 16) {
  await fixedLocale(page)
  await page.addInitScript((size) => {
    localStorage.setItem('font-settings', JSON.stringify({ sizes: { terminal: size } }))
  }, seedSize)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续滚轮/点击，先收起
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

/** 工具栏字号读数（font store 全局值的展示面，含滚动动画 class 不影响文本） */
function fontValue(page: import('@playwright/test').Page) {
  return page.locator('.term-font-value')
}

/** 可见终端的行数（.xterm-rows 直接子行数 = fit 后的 rows；多 pane 取 DOM 序最后） */
function readVisibleRows(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.xterm-rows'))
      .filter(el => (el as HTMLElement).offsetParent !== null)
    return rows.length ? (rows[rows.length - 1] as HTMLElement).childElementCount : -1
  })
}

/** 可见终端滚动区的可见文本（无修饰滚轮翻页后内容变化的观察面，渲染器无关） */
function readVisibleTerminalText(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.xterm-rows'))
      .filter(el => (el as HTMLElement).offsetParent !== null)
    return rows.length ? (rows[rows.length - 1] as HTMLElement).textContent : ''
  })
}

test('Ctrl+滚轮步进全局终端字号并触发 fit；无修饰滚轮不拦截', async ({ page }) => {
  const screen = await openTerminal(page)
  await expect(fontValue(page)).toHaveText('16')
  const widthBefore = await page.evaluate(() => window.innerWidth)
  const rowsBefore = await readVisibleRows(page)
  expect(rowsBefore).toBeGreaterThan(0)

  // Ctrl+滚轮上 ×2：字号 +2（滚轮一格 ±1）
  await screen.hover()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(200)
  await page.mouse.wheel(0, -240)
  await page.keyboard.up('Control')
  await expect(fontValue(page)).toHaveText('18')

  // 浏览器页面未被缩放（手势 preventDefault 生效）：布局视口宽度不变
  expect(await page.evaluate(() => window.innerWidth)).toBe(widthBefore)

  // fit 生效：字形变大 → 同高度可容行数减少（字号 watch → safeFit 链路）
  await expect.poll(() => readVisibleRows(page), { timeout: 8000 }).toBeLessThan(rowsBefore)

  // 无修饰滚轮不拦截：先打印多行造出 scrollback，再滚轮上翻
  await screen.click()
  await page.keyboard.type('1..60 | ForEach-Object { "wheel-pad-$_" }')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const textBefore = await readVisibleTerminalText(page)
  await screen.hover()
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(300)
  // 原生滚动未被手势影响：可见内容翻动
  expect(await readVisibleTerminalText(page)).not.toBe(textBefore)
  // 字号不被无修饰滚轮撼动；页面同样不缩放
  await expect(fontValue(page)).toHaveText('18')
  expect(await page.evaluate(() => window.innerWidth)).toBe(widthBefore)
})

test('Ctrl+滚轮步进在下限处钳制（沿用设置页滑条 min）', async ({ page }) => {
  const screen = await openTerminal(page, 11)
  // 预置到下限 +1：一步到 10，再滚不越界
  await expect(fontValue(page)).toHaveText('11')

  await screen.hover()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, 240)
  await page.waitForTimeout(200)
  await page.mouse.wheel(0, 240)
  await page.keyboard.up('Control')
  // 第二步越界被钳制：停在滑条下限 10
  await expect(fontValue(page)).toHaveText('10')
})
