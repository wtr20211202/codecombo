import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 系统监控磁盘水位卡 E2E（P-20261002-12）：
 *   - 磁盘水位卡常驻（标题 + 数据盘行 + 水位条），与 /api/health 的
 *     disk.volumes 同源（同卷去重后通常仅数据盘一条）
 *   - 行内标签/百分比/填充宽度与端点数值一致（服务端 level 判档，前端只渲染）
 * 阈值通知（>80% warn / >90% crit）在 e2e 无法造真实水位，走 Go 单测造数据
 *（server/api/system/disk_test.go）。
 */

interface DiskVolume {
  role: string
  usedMB: number
  totalMB: number
  usedPercent: number
  level: string
}

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

test('磁盘水位卡：与 /api/health disk.volumes 同源渲染', async ({ page, request }) => {
  await openMonitor(page)

  const diskCard = page.locator('.sysmon-disk')
  await expect(diskCard).toBeVisible()
  await expect(diskCard.locator('.sysmon-disk-title')).toContainText('磁盘水位')

  // 服务端数据源：同卷去重后的卷清单
  const res = await request.get(`${API_BASE}/api/health`)
  expect(res.ok()).toBeTruthy()
  const volumes: DiskVolume[] = ((await res.json())?.disk?.volumes ?? [])
  expect(volumes.length, '端点应至少回报数据盘一条').toBeGreaterThan(0)

  // 卡片行数与端点一致（数据盘 + 异卷系统盘；默认同盘去重为一条）
  const rows = diskCard.locator('.sysmon-disk-row')
  await expect(rows).toHaveCount(volumes.length)

  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i]
    const row = rows.nth(i)
    // 角色标签：data→数据盘（sys 异卷时→系统盘）
    await expect(row.locator('.sysmon-disk-label')).toContainText(
      v.role === 'sys' ? '系统盘' : '数据盘',
    )
    // 百分比文案与端点数值一致（面板 toFixed(1)）
    await expect(row.locator('.sysmon-disk-pct')).toHaveText(
      `${v.usedPercent.toFixed(1)}%`,
    )
    // 填充宽度即水位（style 内联百分比，允许 1% 取整误差）
    const width = await row.locator('.sysmon-disk-fill').evaluate(el =>
      parseFloat((el as HTMLElement).style.width),
    )
    expect(Math.abs(width - Math.min(100, Math.max(0, v.usedPercent)))).toBeLessThanOrEqual(1)
    // 档位由服务端判好，行上透传（前端不自带阈值）
    await expect(row).toHaveAttribute('data-level', v.level)
  }

  await page.screenshot({ path: 'test-results/monitor-disk.png', clip: { x: 300, y: 100, width: 860, height: 720 } })
})
