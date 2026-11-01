import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, waitForAppReady } from '../../tests/helpers'

/**
 * pending 审批冷启动补账（P-20261003-130）：OpsChannelBridge 挂载时
 * approvals.seedPending() 拉 GET /api/ops-confirm 回填 pending 卡堆。
 * 卡堆平时只靠 approval.pending 广播入账——先造 pending 后开页面（广播无
 * 订阅者落地），卡片仍须出现，能出现的唯一路径就是挂载补账：
 *   1. 造 pending → 首次进页即见卡（补账）→ 刷新页面卡片恢复（幂等单张）
 *      → 「允许一次」裁决仍可用（API 状态流转 allowed）
 *   2. 页面在场时经 API 裁决（广播清账）→ 刷新后 resolved 项不恢复
 * afterEach 清账防残留（.aprv-card 全局常驻，残留污染后续用例计数）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理 pending 审批（卡片全局常驻，残留会污染后续用例的 .aprv-card 计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** API 造 pending 审批，返回 id（轮询/裁决断言用） */
async function createPending(
  request: APIRequestContext,
  op: string,
  detail: string,
): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers, data: { op, target: 'main', detail },
  })
  expect(res.ok()).toBeTruthy()
  const body = ((await res.json()) as { data?: { id?: string; status?: string } }).data
  expect(body?.id).toBeTruthy()
  expect(body?.status).toBe('pending')
  return body!.id!
}

/** 轮询审批终态（裁决回流断言用） */
async function pollStatus(request: APIRequestContext, id: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers })
  return ((await res.json()) as { data?: { status?: string } }).data?.status || ''
}

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test('冷启动补账：先造 pending 后进页即见卡，刷新恢复且裁决仍可用', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)

  // 页面未加载时先造 pending：approval.pending 广播此刻无任何订阅者落地，
  // 卡片仍须出现——唯一路径是 OpsChannelBridge 挂载补账（seedPending）
  const id = await createPending(request, 'seed-e2e reset --hard', 'e2e 补账进页即见')

  await gotoAndUnlock(page, '/')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('seed-e2e reset --hard')

  // 刷新页面：卡片经再次挂载补账恢复，且同 id 单张（多标签页/重复 seed 幂等）
  await page.reload()
  await waitForAppReady(page)
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('seed-e2e reset --hard')

  // 补账恢复的卡裁决链完好：允许一次 → 卡片清账 + API 状态流转 allowed
  await card.getByRole('button', { name: '允许一次' }).click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  await expect.poll(() => pollStatus(request, id), { timeout: 10000 }).toBe('allowed')
})

test('冷启动补账：resolved 项刷新后不恢复', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)

  const id = await createPending(request, 'seed-e2e clean -fdx', 'e2e 补账 resolved 不恢复')
  await gotoAndUnlock(page, '/')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 页面在场时经 API 裁决：approval.resolved 广播回流清账（卡片即时消失）
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/ops-confirm/${id}/resolve`, {
    headers, data: { allow: true, always: false },
  })
  expect(res.ok()).toBeTruthy()
  await expect(card).toHaveCount(0, { timeout: 10000 })

  // 刷新后补账重拉列表：记录已 allowed，卡片不得复活
  await page.reload()
  await waitForAppReady(page)
  await expect(card).toHaveCount(0, { timeout: 10000 })
})
