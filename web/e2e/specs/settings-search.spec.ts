import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 设置弹窗分区搜索 E2E（P-20261001-9）：
 *   - 输入关键词 → 非匹配分区隐藏、自动落到首个命中分区
 *   - 清空 → 恢复全部分区；无命中 → 左栏空态提示
 *   - 命令面板「打开设置：<分区>」直达对应分区（settings:<key> 锚点）
 * 全程不改动任何设置值，不点保存，不污染共享实例。
 */

async function openSettings(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
}

// n-input 的 data-testid 落在包裹层 div，真正的输入框在其内部
function searchBox(page: import('@playwright/test').Page) {
  return page.getByTestId('settings-search').locator('input')
}

test('输入关键词隐藏非匹配分区并自动落位，清空恢复全部', async ({ page }) => {
  await openSettings(page)

  const nav = page.locator('.settings-nav')
  // 15 = 分区总数（P-20261003-147 新增迁移分区；总数断言随扩容同步）
  await expect(nav.locator('.nav-item')).toHaveCount(15)

  // 输入 scrollback（终端分区关键词）：非匹配分区隐藏，仅剩「终端」；
  // 原 active 的「通用」被过滤，自动落到首个命中分区
  await searchBox(page).fill('scrollback')
  await expect(nav.locator('.nav-item')).toHaveCount(1)
  await expect(nav.locator('.nav-item').first()).toContainText('终端')
  await expect(nav.locator('.nav-item').first()).toHaveClass(/active/)
  await expect(page.locator('.settings-modal .content-pane:visible .pane-title')).toHaveText('终端')

  // 清空恢复全部分区
  await searchBox(page).fill('')
  await expect(nav.locator('.nav-item')).toHaveCount(15)
})

test('中文关键词多分区命中，无命中显示空态', async ({ page }) => {
  await openSettings(page)

  const nav = page.locator('.settings-nav')
  // 「凭据」同时命中 Git 与 安全 两个分区的关键词表
  await searchBox(page).fill('凭据')
  await expect(nav.locator('.nav-item')).toHaveCount(2)
  // 非 active 的命中分区带 hit 高亮态
  await expect(nav.locator('.nav-item.hit')).toHaveCount(1)

  // 无命中分区：导航空态提示
  await searchBox(page).fill('zzz不存在词条')
  await expect(nav.locator('.nav-item')).toHaveCount(0)
  await expect(nav.locator('.nav-empty')).toHaveText('无匹配分区')

  await searchBox(page).fill('')
  await expect(nav.locator('.nav-item')).toHaveCount(15)
})

test('拼音首字母检索：tz 命中通知分区，大小写不敏感，中文全称仍可搜（P-20261003-220）', async ({ page }) => {
  await openSettings(page)

  const nav = page.locator('.settings-nav')
  // 首字母走与既有 haystack 相同的 includes 子串语义（查询→分区映射守卫见
  // __tests__/utils/settingsSearch.test.ts，词条演进打破该映射先红单测）
  // tz 命中通知+输出哨兵两分区（哨兵关键词表本就含「通知」），按 tab 序通知在前
  await searchBox(page).fill('tz')
  await expect(nav.locator('.nav-item')).toHaveCount(2)
  await expect(nav.locator('.nav-item').first()).toContainText('通知')
  await expect(nav.locator('.nav-item').first()).toHaveClass(/active/)
  await expect(page.locator('.settings-modal .content-pane:visible .pane-title')).toHaveText('通知偏好')

  // 大小写不敏感：查询统一小写后匹配
  await searchBox(page).fill('TZ')
  await expect(nav.locator('.nav-item')).toHaveCount(2)

  // 中文全称（原分子串路径）不受拼音索引影响：通知仍命中同两分区
  await searchBox(page).fill('通知')
  await expect(nav.locator('.nav-item')).toHaveCount(2)
  await expect(nav.locator('.nav-item').first()).toContainText('通知')

  await searchBox(page).fill('')
  await expect(nav.locator('.nav-item')).toHaveCount(15)
})

test('多音字按词取音：hs 命中终端分区（行数 háng，不误读 xíng）', async ({ page }) => {
  await openSettings(page)

  const nav = page.locator('.settings-nav')
  await searchBox(page).fill('hs')
  await expect(nav.locator('.nav-item')).toHaveCount(1)
  await expect(nav.locator('.nav-item').first()).toContainText('终端')
})

test('命令面板「打开设置：终端」直达终端分区', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')

  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>打开设置：终端')
  const item = page.locator('.palette-item').filter({ hasText: '打开设置：终端' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.settings-modal .content-pane:visible .pane-title')).toHaveText('终端')
})
