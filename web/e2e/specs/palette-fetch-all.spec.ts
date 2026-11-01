import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 命令面板「Fetch 全部项目」接线 E2E（P-20261003-309）：
 * 修正前面板 fetch 命令标题承诺全量（cmdFetchAll），实际接线单仓
 * /projects/:id/fetch——标签/行为错位（其他仓 ahead/behind 悄悄陈旧）。
 * 修正后面板 fetch 走批量链路 useFetchAll（与首页工具栏同源）：
 *   1. 执行命令 → 请求打到 POST /api/fetch-all（批量端点）
 *   2. 单仓端点 /api/projects/:id/fetch 零命中（旁路监听断言）
 *   3. 部分失败 toast 摘要 + 通知中心逐仓明细（✓/✗ 行含原因）
 * fetch-all 响应经 page.route 打桩（无需真实多仓播种，范式同 error-display；
 * 项目名用本 spec 专属前缀，断言不受共享实例其他通知干扰）。
 */

const OK_PROJECT = 'e2e-palette-fa-ok'
const BAD_PROJECT = 'e2e-palette-fa-bad'
const BAD_REASON = 'fatal: could not read Username'

async function openCommandMode(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test('面板 fetch 命令走批量 /fetch-all：单仓端点零命中 + 部分失败摘要 + 逐仓明细通知', async ({ page }) => {
  const fetchAllCalls: string[] = []
  const singleFetchCalls: string[] = []
  // 打桩注册先于导航（error-display 同款：route 生效时点不与首屏请求竞态）
  await page.route('**/api/fetch-all', (route) => {
    fetchAllCalls.push(route.request().url())
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [
        { projectId: 'a', name: OK_PROJECT, ok: true },
        { projectId: 'b', name: BAD_PROJECT, ok: false, error: BAD_REASON },
      ] }),
    })
  })
  // 单仓 fetch 端点旁路监听：面板命令不应再打到这里
  await page.route('**/api/projects/*/fetch', (route) => {
    singleFetchCalls.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: null }) })
  })

  const input = await openCommandMode(page)
  await input.fill('>Fetch 全部')
  const item = page.locator('.palette-item').filter({ hasText: 'Fetch 全部项目' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  // 批量端点被命中，且单仓端点零命中（本提案的核心行为断言）
  await expect.poll(() => fetchAllCalls.length, { timeout: 8000 }).toBeGreaterThanOrEqual(1)
  expect(singleFetchCalls).toHaveLength(0)

  // toast 摘要：打桩返回 1 成功 1 失败 → 部分失败文案
  await expect(
    page.locator('.n-message').filter({ hasText: '部分拉取失败' }).filter({ hasText: '失败 1' }),
  ).toBeVisible({ timeout: 8000 })

  // 通知中心逐仓明细：✓ 成功仓 / ✗ 失败仓含原因（命令面板入口经通知命令打开）
  await page.keyboard.press('Control+k')
  const input2 = page.locator('.palette-input input')
  await expect(input2).toBeVisible({ timeout: 5000 })
  await input2.fill('>通知')
  await page.keyboard.press('Enter')
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const body = page.locator('.nc-item-body', { hasText: OK_PROJECT }).first()
  await expect(body).toBeVisible({ timeout: 8000 })
  await expect(body).toContainText(`✓ ${OK_PROJECT}`)
  await expect(page.locator('.nc-item-body').filter({ hasText: `✗ ${BAD_PROJECT}：${BAD_REASON}` }).first())
    .toBeVisible({ timeout: 3000 })
})
