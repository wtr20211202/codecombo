import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { LOCALE_STORAGE_KEY } from '../../src/stores/locale-constants'

/**
 * 多标签本地设置实时同步（P-20261002-36）E2E：
 * 同一 context 的两个 page 即同一浏览器的两个标签——共享 localStorage，他页写入
 * 会向本页派发 storage 事件（双 context 各持独立存储，反而收不到；故用同 context
 * 双 page 而非双 context）。A 标签改主题/语言/字体/缩放落盘后，B 标签不经刷新
 * 实时跟随。断言载体与 theme-follow-os / ui-zoom 同源：各 store 静默重读后应用到
 * documentElement 的内联 CSS 变量与 i18n 文案。
 * 写入侧（各 store 的 UI 操作 → 落盘）由既有 spec 覆盖（theme-follow-os、ui-zoom、
 * settings 系），此处经 A 页 localStorage 直写模拟另一标签的落盘结果——storage
 * 事件的真实触发源就是「他页对 localStorage 的写入」，专测本提案的读回链路：
 * 监听 → 按 key 分发 → store 静默重读 → 应用。
 */

/** 起 B 标签：同 context 新 page（与 A 共享 localStorage），固定 locale + 过 boot/锁 */
async function openSecondTab(context: Page['context']): Promise<Page> {
  const tabB = await context.newPage()
  await fixedLocale(tabB)
  await gotoAndUnlock(tabB, `${API_BASE}/`)
  return tabB
}

function rootVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n) => document.documentElement.style.getPropertyValue(n).trim(), name,
  )
}

test('A 标签切主题 → B 标签实时跟随（不经刷新）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const tabB = await openSecondTab(page.context())
  // 默认（Playwright colorScheme=light，无存储）两页均 light
  expect(await rootVar(tabB, '--bg-primary')).toBe('#ffffff')

  // A 标签写入 dark → B 页 storage 事件 → theme store 重读并应用
  await page.evaluate(() => localStorage.setItem('theme-settings', 'dark'))
  await expect.poll(() => rootVar(tabB, '--bg-primary')).toBe('#0d1117')

  // A 切回 light → B 同步回浅色（双向跟随）
  await page.evaluate(() => localStorage.setItem('theme-settings', 'light'))
  await expect.poll(() => rootVar(tabB, '--bg-primary')).toBe('#ffffff')
})

test('A 标签切语言 → B 标签实时跟随（目标包补载后文案切换）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const tabB = await openSecondTab(page.context())
  await expect(tabB.locator('a.skip-link')).toHaveText('跳到主内容')

  // A 标签写入 en-US → B 页 locale store 复用 setLocale 链路（en 包懒补载）
  await page.evaluate((k) => localStorage.setItem(k, 'en-US'), LOCALE_STORAGE_KEY)
  await expect(tabB.locator('a.skip-link')).toHaveText('Skip to main content', { timeout: 5000 })
})

test('A 标签改字体 → B 标签 --fs-base 跟随', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const tabB = await openSecondTab(page.context())
  expect(await rootVar(tabB, '--fs-base')).toBe('13px')

  await page.evaluate(() =>
    localStorage.setItem('font-settings', JSON.stringify({ sizes: { base: 16 } })))
  await expect.poll(() => rootVar(tabB, '--fs-base')).toBe('16px')
})

test('A 标签切缩放 → B 标签 --ui-zoom 跟随', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const tabB = await openSecondTab(page.context())
  expect(await rootVar(tabB, '--ui-zoom')).toBe('1')

  await page.evaluate(() =>
    localStorage.setItem('ui-zoom-settings', JSON.stringify({ level: 1.25 })))
  await expect.poll(() => rootVar(tabB, '--ui-zoom')).toBe('1.25')
})
