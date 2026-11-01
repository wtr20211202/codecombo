import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 实例健康卡 E2E（P-20261003-28）：/api/system/health 摘要端点 + 值班大屏健康卡。
 *   - 端点形状：四项齐备（uptime/heapAlloc/goroutines/wsClients）且正值语义；
 *     uptime 单调递增（间隔 ≥1s 两次采样严格变大）
 *   - 健康卡：值班大屏四格渲染（非 — 占位）；手动刷新后 uptime 走字（递增）
 *   - 空态共存：机群空闲空态与健康卡同屏（健康卡在 isEmpty 守卫之外常显，
 *     实例自身健康不随机群活动消失）
 * 前置：e2e-seed 金态（锁定关闭），健康卡拉取走 /api 鉴权直通。
 */

test.describe('实例健康卡', () => {
  test('端点形状：四项齐备正值语义，uptime 单调递增', async ({ request }) => {
    const read = async () => {
      const res = await request.get(`${API_BASE}/api/system/health`)
      expect(res.status()).toBe(200)
      return (await res.json()) as {
        uptime: number
        heapAlloc: number
        goroutines: number
        wsClients: number
      }
    }

    const first = await read()
    expect(first.uptime).toBeGreaterThanOrEqual(0)
    expect(first.heapAlloc).toBeGreaterThan(0)
    expect(first.goroutines).toBeGreaterThanOrEqual(1)
    expect(first.wsClients).toBeGreaterThanOrEqual(0)

    // 间隔 ≥1s 再采一次：uptime 秒级分辨率，必须严格递增
    await new Promise(r => setTimeout(r, 1100))
    const second = await read()
    expect(second.uptime).toBeGreaterThan(first.uptime)
  })

  test('健康卡：四格显示 + 刷新后 uptime 递增', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/monitor`)

    const card = page.locator('[data-testid="monitor-health-card"]')
    await expect(card).toBeVisible({ timeout: 5000 })
    await expect(card).toContainText('实例健康')

    // 四格齐备且非 — 占位（挂载即拉完成后填充真实值）
    for (const key of ['uptime', 'heap', 'goroutines', 'ws']) {
      const cell = page.locator(`[data-testid="monitor-health-${key}"] .mhc-value`)
      await expect(cell).toBeVisible({ timeout: 5000 })
      await expect(cell).not.toHaveText('—')
    }
    // 数值形态：uptime 恒含秒位（m/SSs 尾），计数为非负整数
    await expect(page.locator('[data-testid="monitor-health-uptime"] .mhc-value'))
      .toHaveText(/m \d{2}s$/)
    for (const key of ['goroutines', 'ws']) {
      await expect(page.locator(`[data-testid="monitor-health-${key}"] .mhc-value`))
        .toHaveText(/^\d+$/)
    }

    // 采样健康（挂载即拉成功）：打点非失败红态
    await expect(card.locator('.mhc-dot.is-stale')).toHaveCount(0)

    // 手动刷新 → uptime 走字（递增）；点击重试兜底同秒采样（秒级分辨率下
    // 相隔 ≥1s 的两次渲染文本必不同）
    const uptime = page.locator('[data-testid="monitor-health-uptime"] .mhc-value')
    const first = await uptime.textContent()
    await expect(async () => {
      await page.locator('.mon-btn[title="刷新（R）"]').click()
      await expect(uptime).not.toHaveText(first!)
    }).toPass({ timeout: 15000 })
  })

  test('空态共存：机群空闲空态与健康卡同屏常显', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/monitor`)

    // 空态（机群空闲）与实例健康卡同时可见——健康卡在 isEmpty 守卫之外
    await expect(page.locator('.mon-empty')).toContainText('机群空闲', { timeout: 5000 })
    await expect(page.locator('[data-testid="monitor-health-card"]')).toBeVisible()
  })
})
