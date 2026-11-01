import { test, expect, type Page } from '@playwright/test'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 诊断历史与趋势对比 E2E (P-20261002-18)：网络层 mock，不依赖真实 SSH。
 *   1. 弹窗对比条：首次诊断（响应无 compare）→ 报告头部无对比条；
 *      重新采集（响应带 compare）→ 三指标涨跌箭头 + 差值（磁盘可用↓、
 *      内存用量↑、负载↑）。
 *   2. 主机卡行内诊断时间已随 P-20261030-3 密度重塑移出卡片（详情归诊断弹窗），
 *      原行内摘要用例随之撤销。
 * 服务端环形保留/差值计算/输出提取由 Go 单测覆盖
 * （server/store/diaghist_test.go、server/api/remote/remotehost_diaghist_test.go）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const HOST_NAME = `e2e-diaghist-${Math.random().toString(36).slice(2, 8)}`

let hostId = ''

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/remotehosts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: HOST_NAME,
      host: '127.0.0.1',
      port: 22,
      user: 'e2e',
      authType: 'password',
      protocol: 'ssh',
      password: 'e2e-diaghist-pass',
    }),
  })
  // node fetch 的 Response.ok 是布尔属性（非 Playwright APIResponse 的方法）
  if (!res.ok) throw new Error(`host create failed: HTTP ${res.status}`)
  hostId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(hostId, '诊断历史用例主机应创建成功').toBeTruthy()
})

test.afterAll(async () => {
  if (!hostId) return
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/remotehosts/${hostId}`, { method: 'DELETE', headers })
})

/** 打开首页「远程管理」overlay 并定位本用例主机卡片 */
async function openOverlayHostCard(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.home-action-btn[title="远程管理"]').click()
  const overlay = page.locator('.remote-console-overlay')
  await expect(overlay).toBeVisible({ timeout: 10000 })
  const card = overlay.locator('.host-card').filter({ hasText: HOST_NAME }).first()
  await expect(card).toBeVisible({ timeout: 10000 })
  return card
}

test('诊断弹窗：首次无对比条，重新采集后显示三指标涨跌箭头与差值', async ({ page }) => {
  let call = 0
  const items = [
    { key: 'uptime', label: 'Uptime / Load', output: 'load average: 0.52, 0.58, 0.59', exitCode: 0 },
    { key: 'memory', label: 'Memory', output: 'Mem: 7636 3112 1204 123 3319 4123', exitCode: 0 },
    { key: 'disk', label: 'Disk', output: '/dev/root 29G 6.6G 23G 23% /', exitCode: 0 },
  ]
  await page.route('**/api/remotehosts/*/diagnose', async (route) => {
    call++
    const body: Record<string, unknown> = { ok: true, durationMs: 12, items }
    if (call >= 2) {
      // 第二次起服务端会取上一次快照内联对比（此处按真实响应形态 mock）
      body.compare = {
        prev: { time: new Date(Date.now() - 3600_000).toISOString(), diskAvailMB: 22528, memUsedMB: 3112, load1: 0.52 },
        delta: { diskAvailMB: -1024, memUsedMB: 256, load1: 0.5 },
      }
    }
    await route.fulfill({ json: body })
  })

  const card = await openOverlayHostCard(page)
  await card.hover()
  await card.locator('.host-card-more').click()
  await page.locator('.n-dropdown-option').filter({ hasText: '诊断主机' }).first().click()

  const dialog = page.locator('.diag-card')
  await expect(dialog).toBeVisible({ timeout: 10000 })

  // 第一次诊断：无历史 → 对比条隐藏
  await expect(dialog.locator('.diag-compare')).toHaveCount(0)

  // 重新采集：mock 第二次响应带 compare → 对比条出现
  await dialog.locator('.diag-meta button', { hasText: '重新采集' }).click()
  const compare = dialog.locator('.diag-compare')
  await expect(compare).toBeVisible({ timeout: 10000 })
  await expect(compare).toContainText('与上次（')
  // 磁盘可用 -1.0 GB（↓）；内存用量 +256 MB（↑）；负载 +0.50（↑）
  await expect(compare).toContainText('-1.0 GB')
  await expect(compare).toContainText('+256 MB')
  await expect(compare).toContainText('+0.50')
  await expect(compare.locator('.diag-compare-arrow')).toHaveText(['↓', '↑', '↑'])
})

