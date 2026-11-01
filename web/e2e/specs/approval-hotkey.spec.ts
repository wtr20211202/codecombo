import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批卡键盘裁决（P-20261003-1 + P-20261003-316 档位扩档）：待裁决卡在屏时
 * 全局 1/2/3 三选直达
 *   1. 按 1 → 允许一次生效（卡片清账 + 后端 allowed）
 *   2. 焦点在输入面按 1 → 不触发（可编辑面守卫），移除后同键生效
 *   3. 按 3 → 拒绝落账；多卡时只裁首张（pendingList 首卡）
 *   4. 按 2 → 放行时限三选一弹层（P-316 档位面）→ 焦点入首个选项行 → 弹层内
 *      数字直选（1=会话级 2=24h 3=永久；stopPropagation 防全局热键双触发）
 *      → 按 3 永久档落盘 allow + 徽标亮起
 * 全局审批档位是服务端共享状态（approval-* 域用例都吃它）：beforeEach 归位
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

/** 全局审批档位置位（还原都走这一口） */
async function setApprovalMode(request: APIRequestContext, mode: 'ask' | 'allow'): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: mode },
  })
}

/** 读回全局审批档位（键 2 落盘断言用） */
async function getApprovalMode(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: { agentApprovalMode?: string } }).data?.agentApprovalMode || 'ask'
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

/** API 造 pending 审批（满种方式对齐 approve-all-confirm.spec 审批用例） */
async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-20261003-1 键盘裁决验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function approvalStatus(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data: { status: string } }).data.status
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test('键盘裁决：按 1 允许一次生效（卡片清账 + 后端 allowed）', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-hotkey-once', 'clean -fdx')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 焦点在页面本体（非输入面）按 1 → 允许一次：toast + 卡片清账 + 后端落账
  await page.keyboard.press('1')
  await expect(page.locator('.n-message').filter({ hasText: '已允许，智能体可继续执行' })).toBeVisible({ timeout: 10000 })
  await expect(card).toHaveCount(0, { timeout: 10000 })
  expect(await approvalStatus(request, id)).toBe('allowed')
})

test('键盘裁决：输入面聚焦按 1 不触发（守卫），移除后同键生效', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-hotkey-guard', 'reset --hard')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 注入输入面并聚焦：裸数字是正文键入，热键守卫放行（卡片保留、后端仍 pending）
  await page.evaluate(() => {
    const el = document.createElement('input')
    el.id = 'hotkey-guard-probe'
    document.body.appendChild(el)
    el.focus()
  })
  await page.keyboard.press('1')
  await expect(card).toHaveCount(1)
  expect(await approvalStatus(request, id)).toBe('pending')

  // 移除输入面（焦点回页面本体）后同键生效——守卫精确，不是热键失灵
  await page.evaluate(() => document.getElementById('hotkey-guard-probe')?.remove())
  await page.keyboard.press('1')
  await expect(card).toHaveCount(0, { timeout: 10000 })
  expect(await approvalStatus(request, id)).toBe('allowed')
})

test('键盘裁决：按 3 拒绝落账；多卡只裁首张', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const firstId = await seedApproval(request, 'sc-hotkey-multi-1', 'clean -fdx')
  const secondId = await seedApproval(request, 'sc-hotkey-multi-2', 'push --force')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(2, { timeout: 10000 })
  await expect(card.first()).toContainText('clean -fdx')

  // 按 3 → 只裁首张：首卡清账（后端 denied），次卡保留（仍 pending）
  await page.keyboard.press('3')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  expect(await approvalStatus(request, firstId)).toBe('denied')
  expect(await approvalStatus(request, secondId)).toBe('pending')
  await expect(card).toContainText('push --force')

  // 再按 1 → 次卡成为首张，允许一次生效
  await page.keyboard.press('1')
  await expect(card).toHaveCount(0, { timeout: 10000 })
  expect(await approvalStatus(request, secondId)).toBe('allowed')
})

test('键盘裁决：按 2 弹放行时限三选一，弹层内按 3 永久档落盘（全局模式）', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-hotkey-tier', 'rm -rf')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 按 2 → 不直接落账：三选一档位弹层弹出（P-126 全局语义防护保留）
  await page.keyboard.press('2')
  const pop = page.locator('.aprv-tier-pop')
  await expect(pop).toBeVisible({ timeout: 10000 })
  await expect(pop).toContainText('选择放行时限')
  expect(await approvalStatus(request, id)).toBe('pending')

  // 焦点已入弹层首个选项行（after-enter 聚焦）→ 弹层内按 3 直选永久档
  //（行内 stopPropagation：数字归属弹层，全局热键不双触发）
  await page.keyboard.press('3')
  await expect(card).toHaveCount(0, { timeout: 10000 })
  expect(await approvalStatus(request, id)).toBe('allowed')
  expect(await getApprovalMode(request)).toBe('allow')

  // 放行徽标常驻亮起（afterEach 归位 ask）
  const badge = page.locator('[data-test="aprv-allow-badge"]')
  await expect(badge).toBeVisible({ timeout: 10000 })
})
