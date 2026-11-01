import { test, expect, type Page } from '@playwright/test'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 多主机巡检对比 E2E (P-20261004-58)：网络层 mock，不依赖真实 SSH。
 *   1. 双主机夹具 → 批量诊断响应 mock → 对比表（每行一主机 × 指标列）；
 *   2. 离群高亮：磁盘将满/负载异常主机 4 格命中（data-outlier），
 *      正常主机 0 格（绝对阈值线 + 中位数相对偏离的判定本体由
 *      utils/diagCompare 单测收口，此处只验表格接线）；
 *   3. 巡检报告一键复制 markdown（表格 + 失败主机节）。
 * 服务端扇出/限流/结构化降级由 Go 单测覆盖
 * （server/api/remote/remotehost_diagbatch_test.go）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const SUFFIX = Math.random().toString(36).slice(2, 8)
const NAME_OK = `e2e-dcmp-ok-${SUFFIX}`
const NAME_BAD = `e2e-dcmp-bad-${SUFFIX}`
const NAME_DEAD = `e2e-dcmp-dead-${SUFFIX}`

let hostOk = ''
let hostBad = ''
let hostDead = ''

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function createHost(headers: Record<string, string>, name: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/remotehosts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name, host: '127.0.0.1', port: 22, user: 'e2e',
      authType: 'password', protocol: 'ssh', password: 'e2e-dcmp-pass',
    }),
  })
  if (!res.ok) throw new Error(`host create failed: HTTP ${res.status}`)
  const id = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(id, `${name} 应创建成功`).toBeTruthy()
  return id
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  hostOk = await createHost(headers, NAME_OK)
  hostBad = await createHost(headers, NAME_BAD)
  hostDead = await createHost(headers, NAME_DEAD)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  for (const id of [hostOk, hostBad, hostDead]) {
    if (id) await fetch(`${API_BASE}/api/remotehosts/${id}`, { method: 'DELETE', headers })
  }
})

/** 批量诊断响应 mock：ok 主机各项正常；bad 主机磁盘将满（可用 3G/25G=88%）+
 *  负载 3.0 + 2 个失败服务；dead 主机拨号失败（结构化降级行） */
function mockBatchRoute(page: Page) {
  return page.route('**/api/remotehosts/diagnose-batch', async (route) => {
    await route.fulfill({
      json: {
        data: {
          durationMs: 42,
          results: [
            {
              hostId: hostOk, name: NAME_OK, ok: true, durationMs: 30,
              snapshot: {
                diskAvailMB: 20000, diskTotalMB: 25000, memUsedMB: 2000,
                load1: 0.4, cpuPercent: 10, failedServices: 0,
              },
            },
            {
              hostId: hostBad, name: NAME_BAD, ok: true, durationMs: 55,
              snapshot: {
                diskAvailMB: 3000, diskTotalMB: 25000, memUsedMB: 2100,
                load1: 3.0, cpuPercent: 12, failedServices: 2,
              },
            },
            { hostId: hostDead, name: NAME_DEAD, ok: false, durationMs: 0, error: 'dial tcp 127.0.0.1:22 connect refused' },
          ],
        },
      },
    })
  })
}

/** 打开首页「远程管理」overlay */
async function openOverlay(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.home-action-btn[title="远程管理"]').click()
  const overlay = page.locator('.remote-console-overlay')
  await expect(overlay).toBeVisible({ timeout: 10000 })
}

test('对比表：每行一主机 × 指标列，失败主机沉底呈降级行', async ({ page }) => {
  await mockBatchRoute(page)
  await openOverlay(page)
  await page.locator('[data-testid="remote-diag-compare-btn"]').click()

  const table = page.locator('[data-testid="diagcmp-table"]')
  await expect(table).toBeVisible({ timeout: 10000 })
  // 表头：主机 + 六指标列
  await expect(table.locator('th')).toHaveText([
    '主机', '磁盘可用', '磁盘使用率', '内存用量', '负载 1m', 'CPU 占用', '失败服务',
  ])
  // 行数 = 3（含失败主机）
  await expect(table.locator('tbody tr')).toHaveCount(3)
  // 数值格式化：MB→GB、使用率百分比、失败服务计数（0 为真实读数）
  const okRow = table.locator('tbody tr').filter({ hasText: NAME_OK })
  await expect(okRow).toContainText('19.5 GB')
  await expect(okRow).toContainText('20%')
  await expect(okRow).toContainText('2.0 GB')
  await expect(okRow).toContainText('0.40')
  await expect(okRow).toContainText('0')
  // 失败主机行：跨列「采集失败」，title 承载底层错误原文
  const deadRow = table.locator('tbody tr').filter({ hasText: NAME_DEAD })
  await expect(deadRow.locator('.diagcmp-cell-failed')).toContainText('采集失败')
  // 整批耗时 + 图例
  await expect(page.locator('.diagcmp-meta')).toContainText('42ms')
  await expect(page.locator('.diagcmp-legend')).toBeVisible()
})

test('离群高亮：磁盘将满/负载异常主机 4 格命中，正常主机 0 格', async ({ page }) => {
  await mockBatchRoute(page)
  await openOverlay(page)
  await page.locator('[data-testid="remote-diag-compare-btn"]').click()

  const table = page.locator('[data-testid="diagcmp-table"]')
  await expect(table).toBeVisible({ timeout: 10000 })

  // bad 主机：磁盘可用（3G ≪ 中位 11.5G）、使用率 88%（vs 中位 20%）、
  // 负载 3.0（4.5× 中位）、失败服务 2（≥1 绝对线）→ 4 格离群
  const badRow = table.locator('tbody tr').filter({ hasText: NAME_BAD })
  await expect(badRow.locator('[data-outlier="1"]')).toHaveCount(4)
  await expect(badRow.locator('[data-outlier="1"]').first()).toHaveAttribute(
    'title', /离群/,
  )

  // 正常主机：无离群位
  const okRow = table.locator('tbody tr').filter({ hasText: NAME_OK })
  await expect(okRow.locator('[data-outlier="1"]')).toHaveCount(0)
})

test('巡检报告一键复制：markdown 表 + 失败主机节进剪贴板', async ({ page }) => {
  await mockBatchRoute(page)
  await openOverlay(page)
  await page.locator('[data-testid="remote-diag-compare-btn"]').click()

  const table = page.locator('[data-testid="diagcmp-table"]')
  await expect(table).toBeVisible({ timeout: 10000 })
  await page.locator('[data-testid="diagcmp-copy"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '巡检报告已复制' })).toBeVisible({ timeout: 5000 })

  // Windows 下 Chromium 剪贴板往返把 LF 规范成 CRLF，断言前归一
  const raw = await page.evaluate(() => navigator.clipboard.readText())
  const md = raw.replace(/\r\n/g, '\n')
  expect(md).toContain('## 多主机巡检对比')
  expect(md).toContain(`| ${NAME_OK} | 19.5 GB | 20% | 2.0 GB | 0.40 | 10% | 0 |`)
  expect(md).toContain(`| ${NAME_BAD} | 2.9 GB | 88% | 2.1 GB | 3.00 | 12% | 2 |`)
  expect(md).toContain('### 采集失败的主机')
  expect(md).toContain(`- ${NAME_DEAD}：dial tcp 127.0.0.1:22 connect refused`)
})
