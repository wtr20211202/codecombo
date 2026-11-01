import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 本机体检趋势条 E2E（P-20261005-169）：网络层 mock /api/selfcheck，不依赖
 * 真实快照历史。
 *   1. 旧形态响应（无 hist 字段——存量服务端语义）→ 浮层正常渲染、无趋势条
 *      （升级兼容：新前端可读旧响应）；
 *   2. 「重新体检」拿到带 hist 的响应 → 头部「与上次」条出现：磁盘可用↓坏方向、
 *      内存用量↑坏方向、活跃会话/终端数计数差值，涨跌箭头 + 差值文本 +
 *      「近 N 次快照」（远程诊断对比条同款形态）。
 * 服务端快照入账/环形裁剪/差值计算由 Go 单测覆盖
 * （server/store/selfcheckhist_test.go、server/api/system/selfcheckhist_test.go）。
 */

const items = [
  { item: 'version', status: 'ok', detail: 'codecombo 0.0.0 (abc1234) built 2026-10-15, go1.23, linux/amd64' },
  { item: 'git', status: 'ok', detail: 'git version 2.51.0' },
  { item: 'disk', status: 'ok', detail: '18.0 GB free / 50.0 GB total (36.0% used) at /home/user/.codecombo' },
]

// prev 与 latest 构成 -512MB 磁盘 / +128MB 内存 / +1 会话 / +1 终端的确定差值
const prevSnap = {
  time: new Date(Date.now() - 86400_000).toISOString(),
  diskAvailMB: 19456,
  diskTotalMB: 51200,
  memUsedMB: 384,
  activeSessions: 1,
  terminals: 3,
  goroutines: 80,
}
const histWithPrev = {
  runs: 2,
  latest: {
    time: new Date().toISOString(),
    diskAvailMB: 18944,
    diskTotalMB: 51200,
    memUsedMB: 512,
    activeSessions: 2,
    terminals: 4,
    goroutines: 96,
  },
  prev: prevSnap,
  delta: { diskAvailMB: -512, memUsedMB: 128, activeSessions: 1, terminals: 1 },
}

/** 打开体检浮层（命令面板「环境体检」，与 self-check.spec.ts 同入口） */
async function openSelfCheck(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.header-search-trigger').click()
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>环境体检')
  await expect(page.locator('.palette-item').first()).toContainText('环境体检', { timeout: 5000 })
  await page.keyboard.press('Enter')
  const overlay = page.locator('[data-testid="self-check"]')
  await expect(overlay).toBeVisible({ timeout: 10000 })
  return overlay
}

test('旧形态响应（无 hist）无趋势条；重新体检后「与上次」条出现箭头与差值', async ({ page }) => {
  test.setTimeout(120000)
  let call = 0
  await page.route('**/api/selfcheck', async (route) => {
    call++
    // 第一次 = 存量服务端形态（仅 data）；第二次起带 hist（P-20261005-169 契约）
    const body = call === 1 ? { data: items } : { data: items, hist: histWithPrev }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  const overlay = await openSelfCheck(page)

  // 首次响应无 prev → 趋势条隐藏（首次体检/旧响应语义）
  await expect(overlay.locator('[data-testid="self-check-row-disk"]')).toBeVisible()
  await expect(overlay.locator('[data-testid="self-check-trend"]')).toHaveCount(0)

  // 「重新体检」→ 带 hist 的响应 → 趋势条可见
  await overlay.locator('[data-testid="self-check-refresh"]').click()
  const trend = overlay.locator('[data-testid="self-check-trend"]')
  await expect(trend).toBeVisible({ timeout: 10000 })
  await expect(trend).toContainText('与上次（')

  // 差值文本与涨跌方向：磁盘可用 -512 MB（↓坏）、内存用量 +128 MB（↑坏）、
  // 活跃会话/终端数 +1（计数口径），四 chip 全出
  const disk = trend.locator('[data-testid="self-check-trend-disk"]')
  await expect(disk).toContainText('磁盘可用')
  await expect(disk).toContainText('↓')
  await expect(disk).toContainText('-512 MB')
  const mem = trend.locator('[data-testid="self-check-trend-mem"]')
  await expect(mem).toContainText('内存用量')
  await expect(mem).toContainText('↑')
  await expect(mem).toContainText('+128 MB')
  const sessions = trend.locator('[data-testid="self-check-trend-sessions"]')
  await expect(sessions).toContainText('活跃会话')
  await expect(sessions).toContainText('+1')
  const terminals = trend.locator('[data-testid="self-check-trend-terminals"]')
  await expect(terminals).toContainText('终端数')
  await expect(terminals).toContainText('+1')

  // 环形窗计数注记（runs=2）
  await expect(trend).toContainText('近 2 次快照')
})
