import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { CMD_USAGE_STORAGE_KEY } from '../../src/utils/paletteUsage'

/**
 * 命令面板频率加权排序 E2E（P-20261002-107 记录，P-20261005-200 frecency 排序）：
 *   - 执行命令累计 usage（safeStorage 持久，跨打开保留）
 *   - 命令模式空查询置顶组 = frecency 前 5（最近窗口档优先、次数权重、lastAt 破平）
 *   - 有查询时模糊分为主序、frecency 只做同分破平（动态命令族标题同构打平时
 *     高频目标浮到第一位）
 *
 * 用例命令选「切换主题」（cycleTheme 纯本地状态）与「快捷键备忘单」
 * （临时弹窗），不落服务端 uiState，不污染共享实例；浏览器上下文每用例
 * 全新（无 storageState），usage 从零起步保证置顶序确定
 */

const FREQ_GROUP_LABEL = '常用命令'

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

/** 预置 usage 记录（addInitScript 在页面脚本前写 localStorage，面板打开时
 *  loadCmdUsage 读入）——构造跨窗口档位的场景无需真实等待 24h/7 天 */
async function seedUsage(page: Page, usage: Record<string, { count: number; lastAt: number }>) {
  await page.addInitScript(([key, u]) => {
    localStorage.setItem(key, JSON.stringify(u))
  }, [CMD_USAGE_STORAGE_KEY, usage])
}

async function runCommand(page: Page, title: string) {
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(`>${title}`)
  const item = page.locator('.palette-item').filter({ hasText: title }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  await expect(page.locator('.palette-mask')).toBeHidden({ timeout: 5000 })
}

async function enterCommandModeEmptyQuery(page: Page) {
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>')
  await expect(page.locator('.palette-group-label').first()).toBeVisible({ timeout: 5000 })
}

test('同热档内 count 优先于执行先后（用例内执行均落在 24h 热档）', async ({ page }) => {
  await enterProject(page)

  // 目标命令执行 3 次；随后再执行一次别的命令（更新但 count=1）——
  // 两次执行都在热档窗口内（档位打平），置顶组第一名仍必须是目标命令，
  // 验证同档内 count 优先、lastAt 仅破平
  await runCommand(page, '切换主题')
  await runCommand(page, '切换主题')
  await runCommand(page, '切换主题')
  await runCommand(page, '快捷键备忘单')
  // 备忘单是临时弹窗，关掉再回到面板
  const helpModal = page.locator('.n-modal', { hasText: '快捷键' })
  await expect(helpModal).toBeVisible({ timeout: 5000 })
  await page.locator('.sc-help-close').click()
  await expect(helpModal).toBeHidden({ timeout: 5000 })

  await enterCommandModeEmptyQuery(page)
  await expect(page.locator('.palette-group-label').first()).toHaveText(FREQ_GROUP_LABEL)
  const firstItem = page.locator('.palette-item').first()
  await expect(firstItem).toContainText('切换主题')

  // 有查询时置顶组消失，模糊分为主序（同分破平由下方专用用例覆盖）
  await page.locator('.palette-input input').fill('>主题')
  await expect(page.locator('.palette-group-label', { hasText: FREQ_GROUP_LABEL })).toHaveCount(0)
})

test('usage 持久化：离开项目再回来置顶组保留', async ({ page }) => {
  await enterProject(page)
  await runCommand(page, '切换主题')

  // 回首页再进项目（同浏览器上下文，localStorage 保留，面板重开重读 usage）
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  await enterCommandModeEmptyQuery(page)
  await expect(page.locator('.palette-group-label').first()).toHaveText(FREQ_GROUP_LABEL)
  await expect(page.locator('.palette-item').first()).toContainText('切换主题')
})

test('无 usage 时不渲染置顶组', async ({ page }) => {
  await enterProject(page)
  await enterCommandModeEmptyQuery(page)
  await expect(page.locator('.palette-group-label', { hasText: FREQ_GROUP_LABEL })).toHaveCount(0)
})

test('最近窗口档优先：热档执行一次压过温档高频旧记录', async ({ page }) => {
  // 预置 3 天前（温档）count=5 的旧习惯，再热档执行一次目标命令——
  // frecency「最近窗口优先」生效：置顶组第一名必须是刚用过的低频命令
  // （count 优先的旧排序语义下此处会输出温档旧记录，红绿翻转即验证档位生效）
  await seedUsage(page, { 'shortcuts-help': { count: 5, lastAt: Date.now() - 3 * 24 * 60 * 60 * 1000 } })
  await enterProject(page)
  await runCommand(page, '切换主题')

  await enterCommandModeEmptyQuery(page)
  await expect(page.locator('.palette-group-label').first()).toHaveText(FREQ_GROUP_LABEL)
  await expect(page.locator('.palette-item').first()).toContainText('切换主题')
})

test('查询路径模糊同分以 frecency 破平：高频设置分区命令排到同分族首位', async ({ page }) => {
  // 查询「设置：」恰好只命中 settings 分区族（标题「打开设置：<分区>」同构 →
  // 模糊分完全打平；裸「打开设置」命令因无冒号被排除——它对「设置」的完全
  // 匹配分高于族内同构标题，若掺入会以 1 分差压过 frecency 破平）；预置
  // 「外观」分区的 usage 后，它在同分族内浮到第一位（旧静态序下是 general，
  // 断言红绿翻转即验证破平生效）；分数与 frecency 双平的其余命令保持静态注册序
  await seedUsage(page, { 'settings:appearance': { count: 1, lastAt: Date.now() } })
  await enterProject(page)

  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>设置：')
  await expect(page.locator('.palette-item').first()).toContainText('打开设置：外观', { timeout: 5000 })
})
