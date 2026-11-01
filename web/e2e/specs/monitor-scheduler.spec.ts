import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * Scheduler 后台任务清单 E2E（P-20261003-276）：GET /api/system/scheduler
 * 只读注册快照 + 值班大屏健康卡折叠清单联动。
 *   - 端点形状：data 非空数组（内核调度器启动即注册 disk-watch/log-cleanup 等），
 *     每行 name/intervalMs/lastRun 三字段齐备且名称升序；lastRun 允许空串
 *     （注册后尚未到点——快照语义，不等待真实触发）
 *   - 健康卡联动：折叠钮显任务数，展开后行渲染（任务名语言中立直出）+
 *     只读注记（提案边界：刻意不提供启停）
 * 前置：e2e-seed 金态（锁定关闭），取数走 /api 鉴权直通。
 */

interface SchedulerJobWire {
  name: string
  intervalMs: number
  lastRun: string
}

test.describe('Scheduler 后台任务清单', () => {
  test('端点形状：非空清单、三字段齐备、名称升序', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/system/scheduler`)
    expect(res.status()).toBe(200)
    const body = (await res.json()) as { data: SchedulerJobWire[] }
    const jobs = body.data
    expect(Array.isArray(jobs)).toBe(true)
    expect(jobs.length).toBeGreaterThan(0)
    for (const j of jobs) {
      expect(j.name).toBeTruthy()
      expect(j.intervalMs).toBeGreaterThan(0)
      expect(typeof j.lastRun).toBe('string')
    }
    // 名称升序（服务端注册表快照序，展示层不再排序）
    const names = jobs.map(j => j.name)
    expect([...names].sort()).toEqual(names)
    // 启动即注册的已知任务在场（system 模块 disk-watch / app 组合根 log-cleanup）
    expect(names).toContain('disk-watch')
    expect(names).toContain('log-cleanup')
  })

  test('健康卡联动：折叠钮计数 + 展开清单渲染 + 只读注记', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/monitor`)

    const card = page.locator('[data-testid="monitor-health-card"]')
    await expect(card).toBeVisible({ timeout: 5000 })

    const toggle = page.locator('[data-testid="monitor-health-scheduler-toggle"]')
    await expect(toggle).toContainText('后台任务', { timeout: 5000 })
    await expect(toggle).toContainText(/\d+/)

    // 默认折叠：清单不在 DOM（常开大屏墙格高度稳定）
    await expect(page.locator('[data-testid="monitor-health-scheduler"]')).toHaveCount(0)

    await toggle.click()
    const list = page.locator('[data-testid="monitor-health-scheduler"]')
    await expect(list).toBeVisible()
    const rows = page.locator('[data-testid="monitor-health-scheduler-item"]')
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeGreaterThan(0)
    // 已知任务行在场（任务名语言中立直出）
    await expect(rows.filter({ hasText: 'disk-watch' }).first()).toBeVisible()
    // 间隔列形态：人类可读档位（30s / 10m / 1h / 1d）
    await expect(rows.first().locator('.mhc-sched-mono').first()).toHaveText(/^\d+[smhd]$/)
    // 只读注记（提案边界可见化：刻意不提供启停）
    await expect(list).toContainText('只读清单')
  })
})
