import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * Quick Open 隐藏文件可达（P-20261002-127）：
 *   - 服务端 ListFlatFiles 隐藏文件（. 开头）纳入索引，目录跳过收窄为仅
 *     skipDirNames 清单（.git/node_modules/dist/.cache 等）——.gitignore/
 *     .golangci.yml/.zcode/** 等从「仅文件树可达」变 Quick Open 直达
 *   - 走真后端（不 mock /file-list）：simple-coding 项目即本仓库检出目录，
 *     探针取仓库自带的 git 跟踪隐藏文件（原提案示例 .eslintrc 本仓库没有，
 *     按当前检出内容选等价探针；跟踪文件跨环境稳定）
 */

async function openQuickOpen(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+p')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test('根隐藏文件 .gitignore 可达并可打开', async ({ page }) => {
  const input = await openQuickOpen(page)
  await input.fill('.gitignore')

  // 根 .gitignore（path 恰为 .gitignore，以此区别于 web/.gitignore）出现在结果里
  const item = page.locator('.palette-item').filter({
    has: page.locator('.palette-item-path', { hasText: /^\.gitignore$/ }),
  })
  await expect(item).toHaveCount(1, { timeout: 5000 })
  await item.click()

  // 选中即在编辑器打开并激活 tab
  const tab = page.locator('.editor-tab', { hasText: '.gitignore' })
  await expect(tab).toBeVisible({ timeout: 30000 })
  await expect(tab).toHaveClass(/active/)
})

test('隐藏目录不再一网打尽：.golangci.yml 与 .zcode 下文件可检索', async ({ page }) => {
  const input = await openQuickOpen(page)

  // 根隐藏文件按名可检索（全仓唯一命中）
  await input.fill('golangci')
  await expect(
    page.locator('.palette-item').filter({ hasText: '.golangci.yml' }),
  ).toHaveCount(1, { timeout: 5000 })

  // 隐藏目录 .zcode 不在跳过清单内：其下跟踪文件可被检索命中
  await input.fill('enhance-executor')
  await expect(
    page.locator('.palette-item').filter({
      has: page.locator('.palette-item-path', { hasText: '.zcode/workflows/enhance-executor.dwf.ts' }),
    }).first(),
  ).toBeVisible({ timeout: 5000 })
})
