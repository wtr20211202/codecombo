import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批拒绝理由回传（P-20261003-21）：拒绝改为可选理由流——
 *   1. 点拒绝展开行内输入行，填写理由 Enter 确认 → 轮询响应 denied + reason
 *   2. 展开后留空直接确认 = 原行为零变化（denied 且无 reason）
 *   3. 键盘 3 直选拒绝不经输入行（P-20261003-1 键盘链与理由入口共存）→ 无理由
 *   4. Esc 收起输入行 → 不裁决（卡片保留仍 pending）
 * 全局审批模式是服务端共享状态（approval-* 域用例都吃它）：beforeEach 归位
 * ask + afterEach 兜底还原，pending 残留统一清账防污染后续用例
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 全局审批模式置位（还原都走这一口） */
async function setApprovalMode(request: APIRequestContext, mode: 'ask' | 'allow'): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: mode },
  })
}

/** 清理 pending 审批（卡片全局常驻，残留污染后续用例的 .aprv-card 计数） */
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

/** API 造 pending 审批（满种方式对齐 approval-hotkey.spec 审批用例） */
async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-20261003-21 拒绝理由回传验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** 轮询裁决结果（状态 + 拒绝理由） */
async function pollApproval(request: APIRequestContext, id: string): Promise<{ status: string; reason?: string }> {
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data: { status: string; reason?: string } }).data
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test('拒绝附理由：展开输入行填写，Enter 确认后轮询响应 denied 且携带 reason', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-deny-reason', 'edit .env')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 点拒绝 → 行内理由输入行展开（占位文案可见），此时仍 pending
  await card.locator('[data-test="aprv-deny"]').click()
  const input = card.locator('[data-test="aprv-deny-input"]').locator('input')
  await expect(input).toBeVisible()
  expect((await pollApproval(request, id)).status).toBe('pending')

  // 填写理由 → Enter 确认：卡片清账，轮询响应 denied + reason 原文回传
  await input.fill('别动 .env，改用环境变量')
  await input.press('Enter')
  await expect(card).toHaveCount(0, { timeout: 10000 })
  const data = await pollApproval(request, id)
  expect(data.status).toBe('denied')
  expect(data.reason).toBe('别动 .env，改用环境变量')
})

test('拒绝留空确认：原行为零变化（denied 且无 reason 字段）', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-deny-empty', 'push --force')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 点拒绝展开输入行 → 不填直接点确认拒绝
  await card.locator('[data-test="aprv-deny"]').click()
  await expect(card.locator('[data-test="aprv-deny-input"]')).toBeVisible()
  await card.locator('[data-test="aprv-deny-confirm"]').click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  const data = await pollApproval(request, id)
  expect(data.status).toBe('denied')
  expect(data.reason || '').toBe('')
})

test('键盘 3 直选拒绝不经输入行：即时落账且无理由（键盘链与理由入口共存）', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-deny-hotkey', 'clean -fdx')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 按 3 → 直接拒绝（P-20261003-1 链路不变），不经理由输入行
  await page.keyboard.press('3')
  await expect(card).toHaveCount(0, { timeout: 10000 })
  const data = await pollApproval(request, id)
  expect(data.status).toBe('denied')
  expect(data.reason || '').toBe('')
})

test('Esc 收起理由输入行：不裁决，卡片保留仍 pending', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-deny-esc', 'rm -rf build')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 展开输入行 → Esc 收起（不清账）→ 卡片仍在且后端仍 pending
  await card.locator('[data-test="aprv-deny"]').click()
  const input = card.locator('[data-test="aprv-deny-input"]').locator('input')
  await expect(input).toBeVisible()
  await input.press('Escape')
  await expect(card.locator('[data-test="aprv-deny-input"]')).toHaveCount(0)
  await expect(card).toHaveCount(1)
  expect((await pollApproval(request, id)).status).toBe('pending')
})
