import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 应用内 What's New（P-20261007-17）：升级后首启一次性轻弹层 + 帮助中心
 * 「更新内容」节回归。
 *
 * 数据面 = GET /api/whats-new（docs/whatsnew.md 嵌入文档，e2e 实例为 dev 构建
 * 亦有内容段落）；「mock 版本差」经 localStorage 播种上次已读版本实现——seed
 * `0.0.0` 必然旧于文档现有段落，delta = 全部段落（刷新后基线已更新为最新段，
 * 不再弹 =「一次性+可关+不再弹」打扰度纪律的回归钉）。
 */

const SEEN_KEY = 'whatsNewSeenVersion'

/** 播种上次已读版本（addInitScript 在应用脚本之前写 localStorage；仅空缺时写——
 *  init 脚本随每次导航重放，无守卫会把关闭弹层后推进的基线在 reload 时冲回） */
async function seedSeen(page: import('@playwright/test').Page, version: string) {
  await page.addInitScript(([key, v]) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, v as string)
  }, [SEEN_KEY, version])
}

const popup = (page: import('@playwright/test').Page) =>
  page.locator('.n-modal').filter({ hasText: '更新内容' })

async function readSeen(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), SEEN_KEY)
}

test('版本差播种：首启弹层显示新版段落 → 关闭 → 刷新不再弹', async ({ page }) => {
  await fixedLocale(page)
  await seedSeen(page, '0.0.0')
  await gotoAndUnlock(page, '/')

  // 弹层亮起且 delta 含文档现有段落（v0.0.1）：版本徽标 + 段落要点可见
  const modal = popup(page)
  await expect(modal).toBeVisible({ timeout: 10000 })
  await expect(modal.locator('.wn-badge', { hasText: 'v0.0.1' })).toBeVisible()
  await expect(modal.locator('.wn-body').first()).toBeVisible()

  // 关闭即记已读：基线推进到最新段版本
  await modal.locator('[data-test="whats-new-dismiss"]').click()
  await expect(modal).toBeHidden({ timeout: 5000 })
  await expect.poll(() => readSeen(page), { timeout: 5000 }).toBe('0.0.1')

  // 刷新后不再弹（弹层一次性）；基线保持
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)
  expect(await readSeen(page)).toBe('0.0.1')
  await expect(popup(page)).toHaveCount(0)
})

test('无已读记录的首启：不弹（静默记基线），打扰度纪律', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // 无记录 → 静默把当前最新段记为已读，不弹层
  await expect.poll(() => readSeen(page), { timeout: 10000 }).toBe('0.0.1')
  await expect(popup(page)).toHaveCount(0)
})

test('帮助中心「更新内容」节：历史版本可回看', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)

  // 无已读记录不弹：帮助抽屉不被弹层遮挡
  await expect(popup(page)).toHaveCount(0)

  await page.locator('button[title="帮助中心"]').first().click()
  const drawer = page.locator('.n-drawer').filter({ hasText: '帮助中心' })
  await expect(drawer).toBeVisible({ timeout: 5000 })

  // 「更新内容」分组出现（后端 help.Get 并入 whatsnew 段落），展开可见历史段落
  const group = drawer.locator('.help-group').filter({ hasText: '更新内容' })
  await expect(group).toBeVisible({ timeout: 5000 })
  await group.locator('.help-q').first().click()
  const answer = drawer.locator('.help-a').first()
  await expect(answer).toBeVisible()
  await expect(answer.locator('h2', { hasText: 'v0.0.1' })).toBeVisible()
})
