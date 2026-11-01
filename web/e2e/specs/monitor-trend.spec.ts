import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 系统监控内存水位趋势 E2E：
 *   - 趋势卡常驻（标题 + 图例）；样本 <2 时显示「采集中」占位
 *   - 每次刷新（手动/10s 定时）追加一个采样点，≥2 点后折线出现且点数随刷新增长
 * 采样仅存内存态，不污染共享实例。
 */

async function openMonitor(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="设置"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  // 分区语义锚点（P-20261002-151）：不再依赖导航序下标
  await page.locator('[data-testid="settings-nav-monitor"]').click()
  await expect(page.locator('.sysmon')).toBeVisible({ timeout: 3000 })
}

test('内存水位趋势：采集中占位 → 刷新出折线 → 采样增长', async ({ page }) => {
  await openMonitor(page)

  const trend = page.locator('.sysmon-trend')
  await expect(trend).toBeVisible()
  await expect(trend.locator('.sysmon-trend-title')).toContainText('内存水位趋势')

  // 挂载首拉仅 1 个样本 → 占位态
  const lines = page.locator('.sysmon-trend .trend-line')
  if (await lines.count() === 0) {
    await expect(trend.locator('.sysmon-trend-empty')).toBeVisible()
  }

  // 手动刷新补样本 → 折线出现（双系列）；「刷新」全页多处命中，收敛到监控面板内。
  // 挂载首拉与点击的完成顺序不定，poll 点击直至样本 >=2
  const refreshBtn = page.locator('.sysmon').getByRole('button', { name: '刷新' })
  await expect.poll(async () => {
    if (await lines.count() < 2) await refreshBtn.click()
    return lines.count()
  }, { timeout: 10000 }).toBe(2)
  const heapPoints = await page.locator('.sysmon-trend .trend-line-heap').getAttribute('points')
  expect(heapPoints, 'heap 折线应有采样点').toBeTruthy()

  // 再刷新 → 采样点增长（points 字符串中的坐标对变多）
  await refreshBtn.click()
  await expect.poll(async () => {
    const pts = await page.locator('.sysmon-trend .trend-line-heap').getAttribute('points')
    return pts ? pts.split(' ').length : 0
  }).toBeGreaterThan((heapPoints || '').split(' ').length)

  await page.screenshot({ path: 'test-results/monitor-trend.png', clip: { x: 300, y: 100, width: 860, height: 720 } })
})
