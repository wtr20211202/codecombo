import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 「最近裁决」就近回看（P-20261003-226）：卡堆尾部下拉只读展示最近 resolved
 * 审批（op/target/结果/时间）——误裁决（手滑允许）后的快速对账出口。
 *   1. 未裁决空态：干净数据面（无终态记录）造 pending → 触发条在场 → 下拉
 *      显「暂无裁决记录」
 *   2. 裁决一条（允许一次）→ 卡清账后触发条仍在场（回看入口不随卡消失，
 *      正是动机场景）→ 下拉出现该条（op 可辨 + 「已允许」结果徽标 + 条目
 *      只读无按钮）
 * 审批记录无删除端点（30 天保留档），resolved 记录跨用例累积：断言一律按
 * 本用例唯一 op 标记过滤，不做全局面计数；空态用例在脏数据面前跳过（存在
 * 终态记录时「暂无」不可断言，不造假红）
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

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test('未裁决空态：干净数据面下拉显「暂无裁决记录」', async ({ page, request }) => {
  test.setTimeout(60000)
  // 前序 approval-* 用例（同实例跑批）会留下 resolved 记录——脏数据面前
  // 「暂无」不可断言，跳过而非假红（干净实例/定向单跑必真实执行）
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers: await unlockHeaders(request) })
  const list = ((await res.json()) as { data?: { status: string }[] }).data || []
  test.skip(list.some(a => a.status !== 'pending'), '实例已有终态审批记录，空态须干净数据面')

  await fixedLocale(page)
  await createPending(request, 'recent-e2e 空态占位 op', 'e2e 最近裁决空态')
  await gotoAndUnlock(page, '/')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // pending 在场触发条即可达（回看入口与卡同锚点）；此刻无终态记录 → 空态
  await page.locator('[data-test="aprv-recent-trigger"]').click()
  const empty = page.locator('[data-test="aprv-recent-empty"]')
  await expect(empty).toBeVisible()
  await expect(empty).toHaveText('暂无裁决记录')
})

test('裁决一条→下拉出现该条（卡清账后回看入口仍在场，条目只读）', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)

  const marker = `recent-e2e-${Date.now()} reset --hard`
  const id = await createPending(request, marker, 'e2e 最近裁决回看')
  await gotoAndUnlock(page, '/')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 允许一次 → 卡清账；堆内已无 pending 卡，触发条必须仍在场（误裁决后
  // 回查的可达性正是本提案动机）
  await card.getByRole('button', { name: '允许一次' }).click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  const trigger = page.locator('[data-test="aprv-recent-trigger"]')
  await expect(trigger).toBeVisible({ timeout: 10000 })

  // 下拉出现该条：op 可辨 + 「已允许」结果徽标；条目只读（无任何按钮）
  await trigger.click()
  const item = page.locator('[data-test="aprv-recent-item"]').filter({ hasText: marker })
  await expect(item).toHaveCount(1, { timeout: 10000 })
  await expect(item).toContainText('已允许')
  await expect(item.locator('button')).toHaveCount(0)
  await expect(page.locator('[data-test="aprv-recent-note"]')).toBeVisible()

  // 服务端状态流转 allowed（裁决链未被回看面扰动）
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
  expect(((await res.json()) as { data?: { status?: string } }).data?.status).toBe('allowed')
})
