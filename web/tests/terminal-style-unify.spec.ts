import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 终端风格全量统一 E2E（P0：风格统一 + 改名 + 图标）
 *
 * 前置：simple-coding 已在 :9999 运行（嵌入构建产物），可用
 * PLAYWRIGHT_BASE_URL 覆盖目标实例。
 *
 * 覆盖点：
 *   1. 主题 document 副作用全局生效——useTerminalTheme 上移 App.vue 后，
 *      未打开任何终端时切主题 body 属性也应立即变化（原实现只在
 *      TerminalView/RemoteConsoleView 挂载时应用，全局终端场景风格漂移）
 *   2. 「终端字体」设置真正接入 xterm 实例（原实现 fontFamily 硬编码、
 *      设置从未生效）——切字体后打开的终端，计算样式 fontFamily 跟随
 *   3. 「全局终端」更名为「终端会话管理」——项目页活动栏与首页 header 双入口
 */

/** 项目页进入：从首页点 simple-coding 项目卡 */
async function enterProject(page: Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
}

/** 打开设置 → 外观 tab */
async function openAppearance(page: Page) {
  await page.locator('.rail-btn[aria-label="设置"]').click()
  await page.locator('.settings-nav .nav-item', { hasText: '外观' }).click()
  await expect(page.locator('.appearance-settings .terminal-theme-grid')).toBeVisible()
}

/** 保存设置并等弹窗关闭 */
async function saveSettings(page: Page) {
  await page.locator('.settings-footer button', { hasText: '保存' }).click()
  await expect(page.locator('.settings-modal')).toHaveCount(0, { timeout: 5000 })
}

/** 打开底部终端面板，清掉遗留 tab（跨 run 状态归一），新建一个终端 tab */
async function openBottomTerminal(page: Page) {
  // 面板可见性持久化：上轮遗留打开态时 rail 点击是「关」——click-until-visible（同 regression-probe）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
  await closeAllTerminalTabs(page)
  // 工具栏与空态都有「新建终端」按钮：first() 兼容两种形态
  await page.getByRole('button', { name: '新建终端' }).first().click()
  // 恢复的旧 tab 处于隐藏态（v-show），新建 tab 激活后须以「可见」xterm 为准
  await page.locator('.term-container .xterm').locator('visible=true').first()
    .waitFor({ state: 'visible', timeout: 10000 })
}

/** 关闭全部终端 tab（容忍确认弹窗）：清除跨 run 遗留，保证确定性 */
async function closeAllTerminalTabs(page: Page) {
  for (let i = 0; i < 20; i++) {
    const lastTab = page.locator('.term-tab').last()
    if ((await lastTab.count()) === 0) return
    await lastTab.locator('.term-close-btn').click()
    const modal = page.locator('.n-modal')
    if (await modal.isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '确认' }).click()
    }
    await page.waitForTimeout(400)
  }
}

test.describe('终端风格统一（P0）', () => {
  test.beforeEach(async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
  })

  test('未打开任何终端时切换主题，body 属性立即生效', async ({ page }) => {
    // 归一化：classic-dark（localStorage 持久化可能残留其他主题）
    await openAppearance(page)
    await page.locator('.terminal-theme-card', { hasText: 'Classic Dark' }).click()
    await saveSettings(page)
    await expect(page.locator('body')).toHaveAttribute('data-terminal-theme', 'classic-dark', { timeout: 10000 })

    // 核心：不打开任何终端，直接切主题 → App 层全局 watch 立即应用
    await openAppearance(page)
    await page.locator('.terminal-theme-card', { hasText: 'One Dark' }).click()
    await saveSettings(page)
    await expect(page.locator('body')).toHaveAttribute('data-terminal-theme', 'one-dark', { timeout: 10000 })

    // 复位，避免污染其他 spec
    await openAppearance(page)
    await page.locator('.terminal-theme-card', { hasText: 'Classic Dark' }).click()
    await saveSettings(page)
    await expect(page.locator('body')).toHaveAttribute('data-terminal-theme', 'classic-dark', { timeout: 10000 })
  })

  test('字体设置写入 xterm 实例：终端计算字体跟随设置', async ({ page }) => {
    // 归一化 + 切换字体为 JetBrains Mono（store 默认即 jetbrains，设置落盘后必须生效）
    await openAppearance(page)
    await page.locator('.terminal-font-card', { hasText: 'JetBrains Mono' }).click()
    await saveSettings(page)
    await expect(page.locator('html')).toHaveClass(/terminal-font-jetbrains/, { timeout: 10000 })

    // 打开终端，断言 xterm 实例的计算字体是设置选中的字体栈
    await openBottomTerminal(page)
    const fontFamily = await page.evaluate(() => {
      // xterm 各渲染层与根容器：跳过隐藏 tab 里的实例（offsetParent 为 null 即 display:none）
      const els = Array.from(document.querySelectorAll('.xterm-rows, .xterm-text-layer, .xterm-screen, .xterm'))
      for (const el of els) {
        if ((el as HTMLElement).offsetParent === null) continue
        return getComputedStyle(el).fontFamily
      }
      return ''
    })
    expect(fontFamily).toContain('JetBrains Mono')

    // 复位字体为 Cascadia（历史默认视觉）并清理全部终端 tab
    await closeAllTerminalTabs(page)
    await openAppearance(page)
    await page.locator('.terminal-font-card', { hasText: 'Cascadia Code' }).click()
    await saveSettings(page)
    await expect(page.locator('html')).toHaveClass(/terminal-font-cascadia/, { timeout: 10000 })
  })

  test('「终端会话管理」双入口更名（项目页活动栏 + 首页 header）', async ({ page }) => {
    // 项目页活动栏入口
    await expect(page.locator('.ide-rail .rail-btn[title="终端会话管理"]')).toBeVisible()

    // 首页 header 入口
    await gotoAndUnlock(page, '/')
    await expect(page.locator('.home-action-btn[title="终端会话管理"]')).toBeVisible()
  })
})
