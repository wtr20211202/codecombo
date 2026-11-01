import { test, expect } from '@playwright/test'
import { TERMINAL_THEME_FOLLOW_KEY } from '../src/stores/terminal-theme'
import {
  fixedLocale,
  waitForAppReady,
  unlockIfNeeded,
} from './helpers'

// 全量并发负载下主题卡片点击偶发时序失败（单跑恒绿）：本文件内自动重试 2 次，
// 重试后仍失败才计入 failed（Playwright 记为 flaky）
test.describe.configure({ retries: 2 })

/**
 * 终端主题切换 E2E 测试
 *
 * 前置：simple-coding 已在 :9999 运行（嵌入构建产物）。
 *
 * 选择器说明（实际 UI 与 plan 假设的 [data-test="..."] 不同，已对齐当前代码）：
 *   - 打开设置按钮：ActivityBar.vue 的 .rail-btn[aria-label="设置"]
 *   - 外观 tab：SettingsModal.vue 的 .nav-item，文本 = settingsTabs.appearance（zh-CN = "外观"）
 *   - 保存按钮：.settings-footer 内 n-button，文本 = common.save（zh-CN = "保存"）
 *   - 终端主题卡片：.terminal-theme-card（AppearanceSettings.vue），名称来自 i18n key
 *   - 终端字体卡片：.terminal-font-card
 *
 * 持久化断言：useTerminalTheme 已上移 App.vue 全局应用（启动即生效，
 * 不再依赖 TerminalView 挂载），主题属性在页面就绪后即可断言。
 */
test.describe('终端主题切换', () => {
  test.beforeEach(async ({ page }) => {
    await fixedLocale(page)
    // 直达项目页：.rail-btn（ActivityBar）只存在于项目页布局，首页没有
    await page.goto('/project')
    await waitForAppReady(page)
    await unlockIfNeeded(page)
  })

  test('切换终端主题后 body data-terminal-theme 属性变化', async ({ page }) => {
    // 打开设置弹窗（ActivityBar 底部齿轮按钮，aria-label = "设置"）
    await page.locator('.rail-btn[aria-label="设置"]').click()

    // 切到「外观」tab
    await page.locator('.settings-nav .nav-item', { hasText: '外观' }).click()

    // 等「终端主题」分区出现
    await expect(page.locator('.appearance-settings .terminal-theme-grid')).toBeVisible()

    // 点击 Dracula 卡片（卡片名 = i18n settings.terminalTheme.dracula = "Dracula"）
    await page.locator('.terminal-theme-card', { hasText: 'Dracula' }).click()

    // 点底部「保存」按钮
    await page.locator('.settings-footer button', { hasText: '保存' }).click()

    // 等弹窗关闭
    await expect(page.locator('.settings-modal')).toHaveCount(0, { timeout: 5000 })

    // 终端主题由 useTerminalTheme composable 应用到 <body>（监听 store.currentThemeDef 变化）
    await expect(page.locator('body')).toHaveAttribute('data-terminal-theme', 'dracula', { timeout: 10000 })
  })

  test('reload 后终端主题持久化', async ({ page }) => {
    // 前置对齐（P-20261002-144）：跟随应用明暗默认开且存浏览器本地（每个用例
    // 全新 context 不继承上一步的解绑手势），服务端 terminalTheme 只在跟随关时
    // 生效——本用例验证的就是服务端持久化，先关跟随再 reload
    await page.addInitScript(([key]) => {
      localStorage.setItem(key, 'off')
    }, [TERMINAL_THEME_FOLLOW_KEY])
    await page.reload()
    await waitForAppReady(page)
    await unlockIfNeeded(page)

    // 终端主题在 store.load() 完成后由 useTerminalTheme watcher 写入 body
    // （TerminalView setup 阶段调 useTerminalTheme + onMounted 调 store.load()）
    await expect(page.locator('body')).toHaveAttribute('data-terminal-theme', 'dracula', { timeout: 10000 })

    // 复位回 classic-dark，避免污染其他测试
    await page.locator('.rail-btn[aria-label="设置"]').click()
    await page.locator('.settings-nav .nav-item', { hasText: '外观' }).click()
    await page.locator('.terminal-theme-card', { hasText: 'Classic Dark' }).click()
    await page.locator('.settings-footer button', { hasText: '保存' }).click()
  })

  test('切换字体后 <html> 加 terminal-font-xxx class', async ({ page }) => {
    await page.locator('.rail-btn[aria-label="设置"]').click()
    await page.locator('.settings-nav .nav-item', { hasText: '外观' }).click()

    await page.locator('.terminal-font-card', { hasText: 'Cascadia Code' }).click()
    await page.locator('.settings-footer button', { hasText: '保存' }).click()

    // useTerminalTheme composable 把字体 class 写到 <html>
    await expect(page.locator('html')).toHaveClass(/terminal-font-cascadia/, { timeout: 10000 })
  })

  test('7 张终端主题卡片全部可点击切换', async ({ page }) => {
    await page.locator('.rail-btn[aria-label="设置"]').click()
    await page.locator('.settings-nav .nav-item', { hasText: '外观' }).click()

    // 等「终端主题」分区出现，断言 7 张卡片
    const grid = page.locator('.appearance-settings .terminal-theme-grid')
    await expect(grid).toBeVisible()
    await expect(grid.locator('.terminal-theme-card')).toHaveCount(7)

    // 逐个点击 + 保存 + 验证 body data-terminal-theme 同步
    // 顺序必须与 terminal-themes/index.ts 的 registry 导出顺序一致
    const themes = [
      'classic-dark', 'classic-light', 'one-dark', 'dracula',
      'cyber-hud', 'industrial', 'deep-space',
    ]
    for (let i = 0; i < themes.length; i++) {
      const theme = themes[i]!
      await grid.locator('.terminal-theme-card').nth(i).click()
      await page.locator('.settings-footer button', { hasText: '保存' }).click()
      await expect(page.locator('body')).toHaveAttribute('data-terminal-theme', theme, { timeout: 10000 })
      // 重新打开设置切下一个
      if (i < themes.length - 1) {
        await page.locator('.rail-btn[aria-label="设置"]').click()
        await page.locator('.settings-nav .nav-item', { hasText: '外观' }).click()
      }
    }
  })
})
