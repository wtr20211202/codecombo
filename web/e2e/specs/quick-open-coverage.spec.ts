import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * Quick Open 大仓库覆盖（P-20261002-77）：
 *   - 前端拉取扁平文件列表传 max=20000（与服务端 ListFlatFiles 上限对齐）
 *   - 源列表达上限（截断）时列表尾部出现弱提示行，未达上限不出现
 * 真仓库文件数远达不到 20000，用 page.route mock /file-list 响应稳定构造
 * 「截断 / 未截断」两端场景；提示行在虚拟列表尾部，滚动到底后断言。
 */

type FileItem = { name: string; path: string }

async function openQuickOpen(page: import('@playwright/test').Page, items: FileItem[]) {
  let seenMax: string | null = null
  await page.route('**/file-list*', (route) => {
    seenMax = new URL(route.request().url()).searchParams.get('max')
    return route.fulfill({ json: { data: items } })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+p')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  // 等首次（也是唯一一次，面板有项目级缓存）file-list 请求完成
  await expect.poll(() => seenMax, { timeout: 5000 }).toBe('20000')
}

test('列表达索引上限时尾部显示弱提示行', async ({ page }) => {
  const items = Array.from({ length: 20000 }, (_, i) => ({ name: `file-${i}.ts`, path: `src/pkg${i % 97}/file-${i}.ts` }))
  await openQuickOpen(page, items)

  // 虚拟列表只渲染可见窗口——滚动到底部后提示行才进入 DOM
  const list = page.locator('.palette-list')
  await expect(list.locator('.palette-item').first()).toBeVisible()
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight })
  const hint = page.locator('.palette-cap-hint')
  await expect(hint).toBeVisible({ timeout: 5000 })
  await expect(hint).toHaveText('仅索引前 20000 个文件——更深路径请用文件树或全局搜索')
})

test('未达索引上限不显示提示行', async ({ page }) => {
  const items = [
    { name: 'main.go', path: 'main.go' },
    { name: 'router.go', path: 'server/api/router.go' },
    { name: 'tree.go', path: 'server/api/gitops/tree.go' },
  ]
  await openQuickOpen(page, items)

  await expect(page.locator('.palette-item')).toHaveCount(3)
  await page.locator('.palette-list').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect(page.locator('.palette-cap-hint')).toHaveCount(0)
})
