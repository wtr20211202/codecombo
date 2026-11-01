import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批卡同类历史弱行（P-20261005-173）：重复裁决的一致性锚——
 *   1. 裁两张同 op 卡（允许/拒绝各一）→ 第三张同 op 卡挂载即查
 *      （GET /api/ops-confirm?historyForOp=<完整 op 串>，服务端 resolved-only
 *      + 最新在前 + 钳 3），「同类历史」弱行在场，展开见前两条
 *      （状态色点 + 相对时间 + 会话名摘要，最新在前）
 *   2. 零历史 op 不渲染弱行（无锚不加行，卡面退化为既有形态）
 * 全局审批模式是服务端共享状态：beforeEach 归位 ask + afterEach 兜底还原，
 * pending 残留统一清账防污染后续用例；op 串带时间戳防跨运行/跨 spec 的
 * 30 天保留窗历史串扰（resolved 记录随保留窗自然过期，用例只新建不清）
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

/** 建一张待裁决审批卡（agent 发起形态同 POST /api/ops-confirm） */
async function createApproval(request: APIRequestContext, op: string, sessionId: string): Promise<void> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: 'main' },
  })
  expect(res.ok()).toBeTruthy()
}

/** 裁决该 op 的 pending 卡（经列表反查 id——按 op 定位不依赖创建响应序） */
async function resolveByOp(request: APIRequestContext, op: string, allow: boolean): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm?status=pending`, { headers })
  const list = ((await res.json()) as { data?: { id: string; op: string }[] }).data || []
  const target = list.find(x => x.op === op)
  expect(target, `pending approval for op=${op}`).toBeTruthy()
  const r = await request.post(`${BASE}/api/ops-confirm/${target!.id}/resolve`, {
    headers, data: { allow, always: false },
  })
  expect(r.ok()).toBeTruthy()
}

/** 等 pending 卡清账（裁决广播回流，防下一张卡计数串扰） */
async function waitCardsCleared(page: Page): Promise<void> {
  await expect(page.locator('.aprv-card')).toHaveCount(0, { timeout: 10000 })
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test('裁两张同 op 卡后第三张显同类历史：展开见前两条（拒绝在上、允许在下）', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const op = `p173-hist-${Date.now()}`

  // 第一张：允许一次（裁决终态留历史；无历史可考弱行不渲染——首次裁决从零
  // 判断是提案动机现状）
  await createApproval(request, op, 'sc-p173-s1')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card.locator('[data-test="aprv-history"]')).toHaveCount(0)
  await resolveByOp(request, op, true)
  await waitCardsCleared(page)

  // 第二张：拒绝
  await createApproval(request, op, 'sc-p173-s2')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await resolveByOp(request, op, false)
  await waitCardsCleared(page)

  // 服务端过滤面：只回该 op 已裁决、最新在前（pending 不可混入）
  const headers = await unlockHeaders(request)
  const hist = await request.get(`${BASE}/api/ops-confirm?historyForOp=${encodeURIComponent(op)}`, { headers })
  expect(hist.ok()).toBeTruthy()
  const histData = ((await hist.json()) as { data?: { status: string; op: string }[] }).data || []
  expect(histData).toHaveLength(2)
  expect(histData[0]!.status).toBe('denied')
  expect(histData[1]!.status).toBe('allowed')
  expect(histData.every(x => x.op === op)).toBe(true)

  // 第三张：同类历史弱行在场（挂载即查），默认收起，展开见前两条
  await createApproval(request, op, 'sc-p173-s3')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  const history = card.locator('[data-test="aprv-history"]')
  await expect(history).toBeVisible()
  const toggle = history.locator('[data-test="aprv-history-toggle"]')
  await expect(toggle).toContainText('同类历史（2）')
  await expect(history.locator('[data-test="aprv-history-list"]')).toHaveCount(0)
  await toggle.click()
  const items = history.locator('[data-test="aprv-history-list"] li')
  await expect(items).toHaveCount(2)
  // 最新在前：先拒绝（红点）后允许（绿点），结果词在点 title（非颜色通道）；
  // 会话名摘要=尾 8 位截断 id（会话不在 terminal-sessions 列表，P-161 降级形态）
  const tail = (sid: string): string => '…' + sid.slice(-8)
  await expect(items.nth(0)).toHaveAttribute('data-status', 'denied')
  await expect(items.nth(0).locator('.aprv-history-dot')).toHaveAttribute('data-status', 'denied')
  await expect(items.nth(0).locator('.aprv-history-dot')).toHaveAttribute('title', '已拒绝')
  await expect(items.nth(0).locator('.aprv-history-time')).toHaveText('刚刚')
  await expect(items.nth(0).locator('.aprv-history-session')).toHaveText(tail('sc-p173-s2'))
  await expect(items.nth(1)).toHaveAttribute('data-status', 'allowed')
  await expect(items.nth(1).locator('.aprv-history-dot')).toHaveAttribute('title', '已允许')
  await expect(items.nth(1).locator('.aprv-history-session')).toHaveText(tail('sc-p173-s1'))

  // 弱行只读不改裁决链：允许一次照常清账
  await card.locator('button:has-text("允许一次")').click()
  await waitCardsCleared(page)
})

test('零历史 op：同类历史弱行不渲染（无锚不加行）', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  await createApproval(request, `p173-fresh-${Date.now()}`, 'sc-p173-fresh')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card.locator('[data-test="aprv-history"]')).toHaveCount(0)
  await card.locator('button:has-text("允许一次")').click()
  await waitCardsCleared(page)
})
