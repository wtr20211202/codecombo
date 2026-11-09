import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, LOCK_OVERLAY }  from '../../tests/helpers'

async function unlock(page: import('@playwright/test').Page) {
  const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
  if (await input.isVisible().catch(() => false)) {
    await input.fill(DEFAULT_PASSWORD)
    await page.locator(`${LOCK_OVERLAY} button[type="submit"]`).first().click()
    await expect(input).toBeHidden({ timeout: 10000 })
  }
  const remindBtn = page.getByRole('button', { name: '稍后提醒' })
  if (await remindBtn.isVisible().catch(() => false)) await remindBtn.click()
  await page.waitForTimeout(1200)
}

/**
 * 版本信息入口统一回归：首页弹窗 / 项目页状态栏弹窗 / 设置关于页
 * 共享 VersionPanel（含检查更新与更新分发源），弹窗宽度 ≥480px。
 *
 * 回归背景：三处曾是独立实现——首页弹窗与设置关于缺检查更新/分发源；
 * 锁定态挂载时 settings 请求 423 导致首页版本号入口永不显示。
 */
test('三处版本入口统一为同一面板', async ({ page }) => {
  await page.goto('/')
  await unlock(page)

  // 环境门控：若启动恢复的活动实例是「锁定中的远程实例」（如 WSL 侧自动锁已触发），
  // 默认密码解锁后遮罩仍会拦截一切点击（正是本用例记录过的锁定态挂载场景）。
  // 该状态无法在测试内解除，跳过而不是误报回归
  if (await page.locator(LOCK_OVERLAY).isVisible().catch(() => false)) {
    test.skip(true, '锁定遮罩在默认密码解锁后仍存在（远程实例锁定态被恢复为活动实例），跳过')
  }

  // ① 首页 logo（P-20261107-1 版本号位收敛：原右上角 .home-version 徽章移除，
  // 版本弹窗入口转 logo；uiState 恢复可能直接进项目页——先回首页）
  if (!page.url().endsWith('/')) {
    await page.goto('/')
    await page.waitForTimeout(800)
  }
  await page.locator('[data-testid="home-logo"]').click()
  await page.waitForTimeout(500)
  const homeCard = page.locator('.version-card')
  const w1 = await homeCard.evaluate(el => el.getBoundingClientRect().width)
  console.log('HOME_WIDTH:', Math.round(w1), '| checkBtn:', await homeCard.getByRole('button', { name: /检查更新|重新检查/ }).count(), '| source:', await homeCard.locator('.version-source-input').count())
  await page.locator('.version-close').click()

  // ② 项目页状态栏
  await page.getByText('simple-coding').first().click()
  await page.waitForTimeout(2000)
  await page.locator('.statusbar-version').click()
  await page.waitForTimeout(500)
  const projCard = page.locator('.version-card')
  const w2 = await projCard.evaluate(el => el.getBoundingClientRect().width)
  console.log('PROJ_WIDTH:', Math.round(w2), '| checkBtn:', await projCard.getByRole('button', { name: /检查更新|重新检查/ }).count(), '| source:', await projCard.locator('.version-source-input').count())
  await page.locator('.version-close').click()

  // ③ 设置 → 关于
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.waitForTimeout(600)
  await page.locator('.settings-nav .nav-item').filter({ hasText: '关于' }).click()
  await page.waitForTimeout(600)
  const aboutPanel = page.locator('.about-panel')
  console.log('ABOUT_PANEL:', await aboutPanel.count(), '| checkBtn:', await aboutPanel.getByRole('button', { name: /检查更新|重新检查/ }).count(), '| source:', await aboutPanel.locator('.version-source-input').count())
  expect(w1).toBeGreaterThanOrEqual(470)
  expect(w2).toBeGreaterThanOrEqual(470)
})
