import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 首跑跟随 OS 深浅色偏好 E2E（P-20261002-1）：
 *   - 无 theme-settings 存储 → 按 Playwright colorScheme 仿真的 OS 偏好取 light/dark
 *   - 有存储（用户已手动选择）→ 存储值优先，OS 偏好变化不跟随
 *   - 无存储时运行期 OS 偏好变化 → 实时跟随，且不落盘（跟随不冒充用户选择）
 * 断言载体：applyThemeEarly（Vue mount 前）与 theme store 写入 documentElement
 * 的内联 CSS 变量与 color-scheme——light --bg-primary=#ffffff / dark=#0d1117
 * （与 src/themes/light.ts:69、dark.ts:70 对应），不依赖任何 UI 交互。
 */

/** 读取首屏主题主背景色（documentElement 内联变量） */
async function bootBgPrimary(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.style.getPropertyValue('--bg-primary'))
}

/** 读取首屏 color-scheme 声明 */
async function bootColorScheme(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.style.colorScheme)
}

test.describe('浅色 OS', () => {
  test.use({ colorScheme: 'light' })

  test('无存储首跑 → 渲染 light 主题变量与 color-scheme', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    expect(await bootBgPrimary(page)).toBe('#ffffff')
    expect(await bootColorScheme(page)).toBe('light')
  })

  test('无存储运行期 OS 偏好变化 → 实时跟随且不落盘', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    expect(await bootBgPrimary(page)).toBe('#ffffff')

    // 模拟用户在系统层面切到深色：从未手动选过 → 实时跟随
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(async () => bootBgPrimary(page)).toBe('#0d1117')
    // 跟随产生的变更不写存储，清除存储即恢复跟随
    expect(await page.evaluate(() => localStorage.getItem('theme-settings'))).toBeNull()
  })
})

test.describe('深色 OS', () => {
  test.use({ colorScheme: 'dark' })

  test('无存储首跑 → 渲染 dark 主题变量', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    expect(await bootBgPrimary(page)).toBe('#0d1117')
  })

  test('有存储（用户已选 light）→ 存储优先，OS 偏好变化不跟随', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme-settings', 'light'))
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    // OS 深色，但用户显式选过浅色 → 尊重用户
    expect(await bootBgPrimary(page)).toBe('#ffffff')

    // 运行期 OS 偏好变化 → 不跟随，存储值原样保留
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForTimeout(300)
    expect(await bootBgPrimary(page)).toBe('#ffffff')
    expect(await page.evaluate(() => localStorage.getItem('theme-settings'))).toBe('light')
  })
})
