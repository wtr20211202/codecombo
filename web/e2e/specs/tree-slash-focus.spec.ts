import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

// 文件树 `/` 键聚焦搜索框（P-20261003-2）：
//   - 树容器（.tree-list）聚焦时按 `/`：搜索栏开启且输入框获焦（树键盘流闭环）
//   - 搜索输入框已聚焦时按 `/`：保持默认——字符照常输入，不触发其他树行为
//   - Esc 关闭后再按 `/`：可重新开栏获焦（闭环可重复）
// 无需播种探针：`/` 不依赖具体文件，树渲染完成（README.md 可见）即达标
// （选择器 .tree-search input 与 editor-git-tools/file-tree-refresh/remote-view-link 同款）

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

async function focusTree(page: Page) {
  await page.locator('.tree-list').focus()
}

const searchInput = (page: Page) => page.locator('.tree-search input')

test.describe('文件树 / 键聚焦搜索框', () => {
  test('树聚焦按 /：搜索栏开启且输入框获焦', async ({ page }) => {
    await enterProject(page)
    await expect(searchInput(page)).toHaveCount(0) // 初始无搜索栏
    await focusTree(page)
    await page.keyboard.press('/')

    const input = searchInput(page)
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()
  })

  test('输入框已聚焦按 /：保持默认字符输入', async ({ page }) => {
    await enterProject(page)
    await focusTree(page)
    await page.keyboard.press('/')
    const input = searchInput(page)
    await expect(input).toBeFocused()

    // 搜索态下再按 `/`：普通字符进输入框，搜索栏不被关闭/重开
    await page.keyboard.press('/')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('/')
  })

  test('Esc 关闭后再按 /：重新开栏获焦（闭环可重复）', async ({ page }) => {
    await enterProject(page)
    await focusTree(page)
    await page.keyboard.press('/')
    await expect(searchInput(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(searchInput(page)).toHaveCount(0)

    await focusTree(page)
    await page.keyboard.press('/')
    await expect(searchInput(page)).toBeVisible()
    await expect(searchInput(page)).toBeFocused()
  })
})
