import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 多实例会话总览自动刷新 E2E（P-20261002-29）：
 *   1. 总览打开期间远程块轮询：mock 数据变化 → 下一个轮询周期列表更新
 *   2. document.hidden 暂停轮询；回前台立即补刷并恢复周期
 *
 * 手法：
 * - 远程块登记一个真实实例（URL 指向不存在的 :9998，服务端自引用守卫不允许
 *   指回本服务），浏览器侧 page.route 拦截 /proxy/<id>/api/terminals 返回
 *   可变载荷——实例是否真的可达与本用例无关
 * - 轮询周期 30s 不真等：addInitScript 把 20~40s 区间的 setInterval 收缩为
 *   1s（只命中总览轮询这一档），hidden 暂停后用请求数计数断言
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const INSTANCE_NAME = 'e2e-autorefresh'

let unlockToken = ''
let instanceId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  const created = await (await api('POST', '/api/instances', {
    name: INSTANCE_NAME,
    url: 'http://localhost:9998',
    parentId: 'local',
  })).json()
  instanceId = created?.data?.id || ''
  expect(instanceId, '远程实例应登记成功').toBeTruthy()
})

test.afterAll(async () => {
  if (instanceId) await api('DELETE', `/api/instances/${instanceId}`)
})

/** 收缩长周期 setInterval（20~40s 档）为 1s：轮询周期在测试里秒级可观察 */
async function shortenPollInterval(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const orig = window.setInterval.bind(window)
    window.setInterval = ((fn: TimerHandler, delay?: number, ...args: unknown[]) =>
      orig(fn, typeof delay === 'number' && delay >= 20_000 && delay <= 40_000 ? 1_000 : delay, ...(args as []))) as typeof window.setInterval
  })
}

interface RouteHarness {
  payload: { id: string; name: string; kind: string; projectId: string }[]
  calls: number
}

/** 拦截远程块的 terminals 拉取：返回可变载荷并计数 */
async function mockProxyTerminals(page: import('@playwright/test').Page): Promise<RouteHarness> {
  const harness: RouteHarness = {
    payload: [{ id: 'e2e-poll-a', name: 'e2e-poll-a', kind: 'shell', projectId: '' }],
    calls: 0,
  }
  await page.route(`**/proxy/${instanceId}/api/terminals`, async route => {
    harness.calls++
    await route.fulfill({ json: { data: harness.payload } })
  })
  return harness
}

/** 命令面板打开总览（与 instance-sessions-overview.spec.ts 同入口） */
async function openOverview(page: import('@playwright/test').Page) {
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette input, [class*="palette"] input').first().waitFor({ state: 'visible', timeout: 5000 })
  // 「会话总览」而非「总览」：实例族总览（P-20261003-56）入列后单词「总览」
  // 模糊分不再唯一命中多实例会话总览
  await page.keyboard.type('会话总览')
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  const modal = page.locator('.n-modal').filter({ hasText: '多实例会话总览' }).first()
  await expect(modal).toBeVisible({ timeout: 8000 })
  return modal
}

function remoteBlock(modal: import('@playwright/test').Locator) {
  return modal.locator('.iso-block').filter({ hasText: INSTANCE_NAME })
}

test('总览打开期间远程块自动轮询：mock 数据变化 → 列表更新', async ({ page }) => {
  await shortenPollInterval(page)
  const harness = await mockProxyTerminals(page)

  await page.goto(BASE + '/project')
  await page.waitForTimeout(1200)
  const modal = await openOverview(page)

  const block = remoteBlock(modal)
  await expect(block.locator('.iso-row').filter({ hasText: 'e2e-poll-a' })).toBeVisible({ timeout: 8000 })
  const callsAfterLoad = harness.calls
  expect(callsAfterLoad).toBeGreaterThanOrEqual(1)

  // 数据面变化（远程新会话上线）：不重开总览，等待轮询周期自行回灌
  harness.payload.push({ id: 'e2e-poll-b', name: 'e2e-poll-b', kind: 'shell', projectId: '' })
  await expect(block.locator('.iso-row').filter({ hasText: 'e2e-poll-b' })).toBeVisible({ timeout: 10_000 })
  expect(harness.calls).toBeGreaterThan(callsAfterLoad)
  // 本地块不经轮询通道（真实 /api/terminals，未被 mock）——远程块计数即轮询证据
})

test('document.hidden 暂停轮询；回前台立即补刷并恢复周期', async ({ page }) => {
  await shortenPollInterval(page)
  const harness = await mockProxyTerminals(page)

  await page.goto(BASE + '/project')
  await page.waitForTimeout(1200)
  const modal = await openOverview(page)

  const block = remoteBlock(modal)
  await expect(block.locator('.iso-row').filter({ hasText: 'e2e-poll-a' })).toBeVisible({ timeout: 8000 })

  // 页签置为不可见（evaluate 内同步停轮询），暂停生效后再取基线——
  // 基线取在暂停后，之后零请求的断言才不含竞态
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const before = harness.calls
  await page.waitForTimeout(2500)
  expect(harness.calls).toBe(before)

  // 回前台：立即补刷（次数前进），且周期恢复（再等 1.5s 还会继续涨）
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => harness.calls, { timeout: 5000 }).toBeGreaterThan(before)
  const afterResume = harness.calls
  await page.waitForTimeout(1500)
  expect(harness.calls).toBeGreaterThan(afterResume)
})
