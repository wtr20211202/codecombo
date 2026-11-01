import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 帮助中心回归（97e194e 引入）：顶栏入口与命令面板两条路径都能打开抽屉，
 * 内容按分类渲染、搜索可过滤、答案展开为 markdown 渲染结果。
 *
 * 回归背景：帮助内容前后端单一事实源（GET /api/help），前端抽屉折叠问答；
 * be297b9 把帮助中心纳入全局快捷键门控（打开时 B/`/K/P 不再穿透）。
 */

async function openViaTopBar(page: import('@playwright/test').Page) {
  await page.locator('button[title="帮助中心"]').first().click()
  const drawer = page.locator('.n-drawer').filter({ hasText: '帮助中心' })
  await expect(drawer).toBeVisible({ timeout: 5000 })
  return drawer
}

/** TopBar（含帮助入口）在 /project 的 Layout 里——首页是项目卡片视图无此按钮 */
async function enterProject(page: import('@playwright/test').Page) {
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

test('顶栏入口：内容分区渲染 + 搜索过滤 + 答案展开', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await enterProject(page)

  const drawer = await openViaTopBar(page)

  // 搜索框与智能体提示渲染
  await expect(drawer.locator('input')).toBeVisible()
  await expect(drawer.locator('.help-agent-tip')).toBeVisible()

  // 内容加载完成：至少一个分类分组，分组内至少一条问答
  await expect(drawer.locator('.help-group').first()).toBeVisible({ timeout: 5000 })
  const entryCount = await drawer.locator('.help-entry').count()
  expect(entryCount).toBeGreaterThanOrEqual(3)

  // 展开首条：答案为 marked 渲染后的 html（含 p 等块级元素，而非纯文本）
  await drawer.locator('.help-q').first().click()
  await expect(drawer.locator('.help-a').first()).toBeVisible()
  await expect(drawer.locator('.help-a p').first()).toBeVisible()

  // 搜索过滤：「快捷键」命中快捷键相关问答，其余被滤掉
  await drawer.locator('input').first().fill('快捷键')
  await expect(drawer.locator('.help-entry', { hasText: '快捷键' }).first()).toBeVisible()
  const filteredCount = await drawer.locator('.help-entry').count()
  expect(filteredCount).toBeLessThan(entryCount)
  expect(filteredCount).toBeGreaterThanOrEqual(1)

  // 模糊搜索：跨字段子序列（「快捷键设置」作为连续子串在任何单条里都不存在，
  // 旧 includes 引擎必空手；fuzzy 跨标题+正文命中「全部快捷键」条目）
  await drawer.locator('input').first().fill('快捷键设置')
  await expect(drawer.locator('.help-entry', { hasText: '快捷键' }).first()).toBeVisible()

  // 无匹配关键词显示空态（非失败态文案）
  await drawer.locator('input').first().fill('zzz-无匹配-xyz')
  await expect(drawer.locator('.help-empty')).toHaveText(/没有匹配的问题/)

  // 清空恢复全量 + 收起抽屉
  await drawer.locator('input').first().fill('')
  await expect(drawer.locator('.help-entry')).toHaveCount(entryCount)
  await drawer.locator('.n-base-close').click()
  await expect(drawer).toBeHidden({ timeout: 5000 })
})

test('命令面板入口可达 + 打开时全局快捷键被门控', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await enterProject(page)

  // Ctrl+K 打开命令面板，`>` 进入命令模式，点「帮助中心」命令项
  await page.keyboard.press('Control+k')
  const paletteInput = page.locator('.palette-input input')
  await expect(paletteInput).toBeVisible({ timeout: 5000 })
  await paletteInput.fill('>帮助中心')
  const helpCmd = page.locator('.palette-item').filter({ hasText: '帮助中心' }).first()
  await expect(helpCmd).toBeVisible({ timeout: 5000 })
  await helpCmd.click()
  await page.waitForTimeout(400)

  const drawer = page.locator('.n-drawer').filter({ hasText: '帮助中心' })
  await expect(drawer).toBeVisible({ timeout: 5000 })

  // 抽屉打开时再按 Ctrl+K：帮助中心在 isDialogOpen 门控链里，命令面板不得穿透打开
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(400)
  await expect(page.locator('.palette-input input')).toHaveCount(0)

  await drawer.locator('.n-base-close').click()
  await expect(drawer).toBeHidden({ timeout: 5000 })
})
