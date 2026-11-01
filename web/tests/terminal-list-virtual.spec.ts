import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 悬浮列表虚拟滚动 E2E（打磨轮3）：大量会话时 DOM 只渲染视口内行。
 *
 * 会话列表经路由拦截伪造（100 条假会话），不创建真实终端进程；
 * 断言：行 DOM 数远小于总数（虚拟化生效），滚动到底部能看到末尾会话。
 */

const TOTAL = 100

async function mockManySessions(page: Page) {
  const fake = Array.from({ length: TOTAL }, (_, i) => ({
    id: `fake-${i}`,
    name: `会话-${String(i).padStart(3, '0')}`,
    kind: 'agent',
    projectId: '',
    path: '',
    createdAt: '',
  }))
  await page.route('**/api/terminals', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: fake }),
    })
  })
}

/** 前置：项目页 → 管理页 → 收起为球 → 切悬浮列表（会话来自拦截的假数据） */
async function setupListShape(page: Page) {
  await mockManySessions(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.atv-header-actions [title="收起为悬浮球"]').click()
  const ball = page.locator('.agm-root')
  await expect(ball).toBeVisible()
  await ball.click({ button: 'right' })
  await page.getByText('悬浮列表', { exact: true }).click()
  const list = page.locator('.agm-root.is-list')
  await expect(list).toBeVisible()
  return list
}

test.describe('悬浮列表虚拟滚动（打磨轮3）', () => {
  test('100 会话只渲染视口行；滚动到底可见末尾会话', async ({ page }) => {
    const list = await setupListShape(page)
    const rows = list.locator('.agm-list-row')

    // 虚拟化生效：DOM 行数远小于总数（列表视口高度 ~数百 px，行高 28px）
    await expect(rows.first()).toBeVisible()
    const domCount = await rows.count()
    expect(domCount).toBeGreaterThan(0)
    expect(domCount).toBeLessThan(TOTAL / 2)

    // 首行可见
    await expect(rows.first()).toContainText('会话-000')

    // 滚动到列表底部：末尾会话进入视口（DOM 行数仍有界）
    const container = list.locator('.agm-list-body')
    await container.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(list.locator('.agm-list-row', { hasText: `会话-0${TOTAL - 1}` })).toBeVisible()
    expect(await rows.count()).toBeLessThan(TOTAL / 2)
  })
})
