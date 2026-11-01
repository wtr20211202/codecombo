import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 审计写失败可见性（P-20261003-205）E2E：
 *   - 端点形状（真实服务端）：/api/system/health 与 /api/audit 响应顶面附
 *     auditWriteFails/auditLastWriteFail 两字段；健康实例恒 0/空串
 *   - 健康卡警示：page.route 注入失败计数（本仓库失败注入惯例，error-display
 *     同款手法）→ 值班大屏健康卡出现「审计写失败 N 条」警示行
 *   - 审计面板警示：注入失败计数 → 设置·安全·审计日志顶部出现警示条
 *     （条数 + 最近失败时刻）
 * 写失败计数是服务端进程内存态（磁盘满/权限类故障），e2e 无法安全注真故障，
 * 服务端计数逻辑由 go test（store/api/system 两包）覆盖；本 spec 守前端展示面。
 * 前置：e2e-seed 金态（锁定关闭），health 面走 /api 鉴权直通（instance-health 同前置）。
 */

// 健康摘要 mock 响应（四项原值 + 注入的审计写失败计数）
function healthBody(fails: number): string {
  return JSON.stringify({
    uptime: 120,
    heapAlloc: 50_000_000,
    goroutines: 42,
    wsClients: 0,
    auditWriteFails: fails,
    auditLastWriteFail: fails > 0 ? '2026-10-07T02:00:00Z' : '',
  })
}

test.describe('审计写失败可见性', () => {
  // 端点形状：真实服务端（无注入故障）——两字段齐备且为「无失败」基线
  test('端点形状：health 响应含写失败两字段，健康实例恒 0/空串', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/system/health`)
    expect(res.status()).toBe(200)
    const body = (await res.json()) as {
      auditWriteFails: number
      auditLastWriteFail: string
      uptime: number
    }
    expect(typeof body.uptime).toBe('number')
    expect(body.auditWriteFails).toBe(0)
    expect(body.auditLastWriteFail).toBe('')
  })

  // 健康卡警示：注入 fails=3 → 卡片内警示行出现且条数如实；基线（真实服务端
  // 无失败）不渲染。注入与基线分两页跑，避免同页 route 残留互相污染
  test('健康卡警示：注入失败计数后「审计写失败 3 条」出现，无失败不渲染', async ({ browser }) => {
    // 基线页（真实服务端，auditWriteFails=0）：警示行不存在
    const baseCtx = await browser.newContext()
    const basePage = await baseCtx.newPage()
    await fixedLocale(basePage)
    await gotoAndUnlock(basePage, `${API_BASE}/monitor`)
    await expect(basePage.getByTestId('monitor-health-card')).toBeVisible({ timeout: 5000 })
    await expect(basePage.getByTestId('monitor-health-audit-fails')).toHaveCount(0)
    await baseCtx.close()

    // 注入页：fails=3 → 警示行出现，条数如实
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.route('**/api/system/health*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: healthBody(3),
    }))
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/monitor`)
    const warn = page.getByTestId('monitor-health-audit-fails')
    await expect(warn).toBeVisible({ timeout: 5000 })
    await expect(warn).toHaveText('审计写失败 3 条')
    // 恢复指引在 hover title（最近失败时刻 + 修复建议），不占卡片版面
    await expect(warn).toHaveAttribute('title', /最近失败/)
    await ctx.close()
  })

  // 审计面板警示：注入 fails=2 → 打开设置·安全·审计日志，表格上方警示条
  // 出现（条数 + 最近失败时刻 + 恢复指引正文）
  test('审计面板警示：注入失败计数后警示条出现于列表上方', async ({ page }) => {
    await page.route('**/api/audit?*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{
          id: 'e2e-fails-1',
          time: '2026-10-07T02:00:00Z',
          action: 'lock.unlock',
          result: 'success',
          ip: '127.0.0.1',
          detail: '',
        }],
        total: 1,
        auditWriteFails: 2,
        auditLastWriteFail: '2026-10-07T02:00:00Z',
      }),
    }))
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.getByRole('button', { name: '设置' }).click()
    await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
    await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
    await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
    await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })

    const warn = page.getByTestId('audit-write-fails')
    await expect(warn).toBeVisible({ timeout: 5000 })
    // 标题行：条数 + 最近失败时刻（formatDateTime 本地时区文本，锚定条数段与
    // 时刻前缀，不锚死时区偏移）；正文：恢复指引
    await expect(warn).toContainText('审计写失败 2 条（最近 ')
    await expect(warn).toContainText('写失败的审计事件已静默丢失')
  })
})
