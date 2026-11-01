import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端主题跟随应用明暗 E2E（P-20261002-144）：
 *   - 默认跟随（无 terminal-theme-follow 存储）：应用明暗档位翻转 → 终端主题按
 *     映射表实时切换（light→classic-light / dark→classic-dark）
 *   - 设置页终端主题分区解绑：跟随开关关闭（含点选主题卡自动解绑）→ 锁手工选择，
 *     应用明暗再切不变；重新绑定立即回映射
 *   - 跨标签（settingsSync 读回链路）：A 标签落盘解绑 → B 标签不经刷新跟随
 * 断言载体：App.vue 全局 useTerminalTheme 写入 body 的 data-terminal-theme
 * （applyThemeToDocument 副作用，与 xterm options.theme 同源），不依赖 UI 截图。
 * 注意两层跟随的分工：本 spec 的 emulateMedia 只翻转「应用主题」档位（P-1 的
 * OS 跟随路径，无 theme-settings 存储 → 未手动选择 → 实时跟随），终端主题是
 * 本次级跟随的被测对象。
 */

/** 读取当前生效终端主题名（body data 属性，App.vue 全局应用链写入） */
function bodyTerminalTheme(page: Page): Promise<string> {
  return page.evaluate(() => document.body.dataset.terminalTheme ?? '')
}

/** 进入项目页并打开设置弹窗的外观分区（与 settings-remember-tab 同款开法） */
async function openAppearanceSettings(page: Page) {
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 3000 })
  await modal.locator('.settings-nav .nav-item').filter({ hasText: '外观' }).click()
  await expect(page.locator('[data-testid="terminal-theme-follow"]')).toBeVisible()
}

/** 跟随开关（n-checkbox 的勾选态走 n-checkbox--checked class，比隐藏 input 稳） */
function followCheckbox(page: Page) {
  return page.locator('[data-testid="terminal-theme-follow"] .n-checkbox')
}

async function expectFollowChecked(page: Page, checked: boolean) {
  if (checked) await expect(followCheckbox(page)).toHaveClass(/n-checkbox--checked/)
  else await expect(followCheckbox(page)).not.toHaveClass(/n-checkbox--checked/)
}

test.describe('默认跟随应用明暗（无存储）', () => {
  test.use({ colorScheme: 'light' })

  test('应用浅色 → classic-light；运行期切深色 → 实时跟随 classic-dark', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    expect(await bodyTerminalTheme(page)).toBe('classic-light')

    // 应用主题层（P-1 OS 跟随路径）翻到深色 → 终端主题次级跟随切深档映射
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => bodyTerminalTheme(page)).toBe('classic-dark')

    // 切回浅色 → 映射回 classic-light（跟随是双向实时的）
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => bodyTerminalTheme(page)).toBe('classic-light')
  })
})

test.describe('设置页解绑/重绑', () => {
  test.use({ colorScheme: 'light' })

  test('点选主题卡自动解绑 + 保存 → 锁手工主题，应用明暗再切不变；重绑立即回映射', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    expect(await bodyTerminalTheme(page)).toBe('classic-light')

    await openAppearanceSettings(page)
    const modal = page.locator('.n-modal.settings-modal')

    // 点选 Dracula 卡 = 手工接管手势：跟随开关就地自动解绑（否则点选被映射盖住、无可见效果）
    await modal.locator('.terminal-theme-card').filter({ hasText: 'Dracula' }).click()
    await expectFollowChecked(page, false)

    // 保存：handleSave 等全部分区落盘后自动关弹窗（SettingsModal saved→update:show false），
    // 不能再补 Esc——在途保存窗口内脏态未清会误触「未保存」护栏弹窗
    await modal.locator('.settings-footer button').filter({ hasText: '保存' }).click()
    await expect(modal).toBeHidden({ timeout: 10000 })

    // 解绑后生效主题 = 手工选择
    expect(await bodyTerminalTheme(page)).toBe('dracula')
    expect(await page.evaluate(() => localStorage.getItem('terminal-theme-follow'))).toBe('off')

    // 关跟随 → 切应用明暗：终端主题锁死不变（本提案核心断言）
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(300)
    expect(await bodyTerminalTheme(page)).toBe('dracula')
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForTimeout(300)
    expect(await bodyTerminalTheme(page)).toBe('dracula')

    // 重新绑定：立即回档位映射（当前应用浅色 → classic-light），手工选择保留为解绑基线
    await page.locator('[data-testid="rail-settings"]').click()
    await expect(modal).toBeVisible({ timeout: 3000 })
    await modal.locator('.settings-nav .nav-item').filter({ hasText: '外观' }).click()
    await expectFollowChecked(page, false)
    await followCheckbox(page).click()
    await expectFollowChecked(page, true)
    await modal.locator('.settings-footer button').filter({ hasText: '保存' }).click()
    await expect(modal).toBeHidden({ timeout: 10000 })
    await expect.poll(() => bodyTerminalTheme(page)).toBe('classic-light')
  })
})

test.describe('跨标签跟随开关同步（settingsSync 读回链路）', () => {
  test.use({ colorScheme: 'light' })

  test('A 标签落盘解绑 → B 标签不经刷新切到手工主题；A 自身 store 不受本页直写影响', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    // 同 context 第二标签 = 共享 localStorage 的另一个标签页
    const tabB = await page.context().newPage()
    await fixedLocale(tabB)
    await gotoAndUnlock(tabB, `${API_BASE}/`)
    expect(await bodyTerminalTheme(tabB)).toBe('classic-light')

    // A 标签直写落盘（settings-sync 同款口径：storage 事件真实触发源就是他页写入）
    await page.evaluate(() => localStorage.setItem('terminal-theme-follow', 'off'))

    // B 标签 storage 事件 → terminal-theme store 静默重读 → 生效主题回手工基线
    await expect.poll(() => bodyTerminalTheme(tabB)).toBe('classic-dark')
    // A 本页 store 不经直写变更（浏览器语义：本页写入不向本页派发 storage 事件）
    expect(await bodyTerminalTheme(page)).toBe('classic-light')
  })
})
