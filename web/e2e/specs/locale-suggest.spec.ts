import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 首跑浏览器语言建议 E2E（P-20261002-113）
 *
 * 覆盖：
 * - en 浏览器 + 无 locale 存储（首跑）→ 首页顶部提示条出现 → 点「切换」→
 *   英文文案经既有 setLocale 链路生效，刷新后持久且提示条不再出现
 * - 「保持中文」→ 立即隐藏 + 刷新后不再出现（safeStorage 一次性记忆）
 * - en 浏览器但已有 locale 存储（用户表达过语言选择）→ 不提示
 * - zh 浏览器（全局 playwright locale 默认）→ 中文用户零打扰
 *
 * 模拟英文浏览器：playwright.config 全局 locale: 'zh-CN'（全部既有用例 navigator
 * 为 zh，本特性对既有套件零污染），本文件 use 级覆盖为 en-US。
 * 每用例全新 context（storage 天然为空）即首跑形态，无需手工清存储。
 */

const BAR = '[data-testid="locale-suggest-bar"]'
const BAR_SWITCH = '[data-testid="locale-suggest-switch"]'
const BAR_DISMISS = '[data-testid="locale-suggest-dismiss"]'
const DISMISS_KEY = 'sc.localeSuggestDismissed'

test.use({ locale: 'en-US' })

/** 从首页进入后断言英文已生效（首页「添加项目」按钮是 home.addProject 键文案） */
async function expectEnglishHome(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Add Project' }).first()).toBeVisible({ timeout: 10000 })
}

test.describe('en 浏览器首跑', () => {
  test('提示条出现 → 点「切换」英文生效并持久，提示条不再出现', async ({ page }) => {
    await gotoAndUnlock(page, `${API_BASE}/`)
    await waitForAppReady(page)

    const bar = page.locator(BAR)
    await expect(bar).toBeVisible()
    // 提示条文案（locale 仍为默认 zh-CN，中文渲染）+ 两动作在位
    await expect(bar).toContainText('看起来你偏好 English')
    await expect(page.locator(BAR_SWITCH)).toBeVisible()
    await expect(page.locator(BAR_DISMISS)).toBeVisible()

    // 「切换」→ 既有 setLocale 链路（en 包懒补载）→ 英文文案生效
    await page.locator(BAR_SWITCH).click()
    await expectEnglishHome(page)
    await expect(bar).toBeHidden()

    // 刷新：locale 选择已落盘（storage 非空），仍是英文且提示条不再出现
    await page.reload()
    await waitForAppReady(page)
    await unlockIfNeeded(page)
    await expectEnglishHome(page)
    await expect(page.locator(BAR)).toHaveCount(0)
  })

  test('「保持中文」→ 立即隐藏，刷新后不再出现（一次性记忆持久）', async ({ page }) => {
    await gotoAndUnlock(page, `${API_BASE}/`)
    await waitForAppReady(page)
    await expect(page.locator(BAR)).toBeVisible()

    await page.locator(BAR_DISMISS).click()
    await expect(page.locator(BAR)).toBeHidden()
    // 记忆键确实落在 localStorage（safeStorage）
    expect(await page.evaluate((k) => localStorage.getItem(k), DISMISS_KEY)).toBe('1')

    // 刷新（记忆生效；locale 存储仍为空但 dismissed 命中）→ 不再出现
    await page.reload()
    await waitForAppReady(page)
    await unlockIfNeeded(page)
    await expect(page.locator(BAR)).toHaveCount(0)
  })

  test('已有 locale 存储（用户表达过语言选择）→ 不提示', async ({ page }) => {
    // fixedLocale 注入 zh-CN 存储：非「无存储」首跑，en 浏览器也不打扰
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await waitForAppReady(page)
    await expect(page.locator(BAR)).toHaveCount(0)
  })
})

test.describe('zh 浏览器零打扰', () => {
  // 覆盖文件级 en-US：还原全局配置的中文浏览器（navigator.language=zh-CN）
  test.use({ locale: 'zh-CN' })

  test('zh 浏览器 + 无 locale 存储 → 提示条不出现', async ({ page }) => {
    await gotoAndUnlock(page, `${API_BASE}/`)
    await waitForAppReady(page)
    await expect(page.locator(BAR)).toHaveCount(0)
  })
})
