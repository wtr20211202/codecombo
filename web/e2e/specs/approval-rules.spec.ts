import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批分类规则（P-20261003-35 per-op 自动裁决）：
 *   1. allow 规则命中（git push）→ ops-confirm 直落库 allowed + ruleHit，不弹卡
 *   2. deny 规则命中（reset）→ 直落库 denied + ruleHit，不弹卡；未命中仍走卡流
 *   3. 全局优先：模式 = allow 时 deny 规则不评估（全局短路）
 *   4. 设置·安全分区规则表 CRUD（暂存→保存）+ 命中测试按钮
 * 全局审批模式与规则表都是服务端共享状态（approval-* 域用例都吃它们）：
 * beforeEach 归位 ask + 清空规则表，afterEach 兜底还原，防污染后续用例
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

/** 规则表整体替换（还原/播种都走这一口） */
async function setRules(
  request: APIRequestContext,
  rules: Array<{ opPattern: string; effect: string }>,
): Promise<void> {
  const res = await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalRules: rules },
  })
  expect(res.ok()).toBeTruthy()
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

async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-20261003-35 审批分类规则验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function pollApproval(
  request: APIRequestContext,
  id: string,
): Promise<{ status: string; ruleHit?: string }> {
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data: { status: string; ruleHit?: string } }).data
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await setRules(request, [])
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await setRules(request, [])
  await cleanupApprovals(request)
})

test('allow 规则命中：ops-confirm 直落库 allowed + ruleHit，不弹卡；未命中仍走卡流', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await setRules(request, [{ opPattern: 'git push', effect: 'allow' }])

  // 命中：创建即 allowed，轮询带 ruleHit，页面无审批卡
  const id = await seedApproval(request, 'sc-rules-allow', 'git push origin main')
  const data = await pollApproval(request, id)
  expect(data.status).toBe('allowed')
  expect(data.ruleHit).toBe('git push')
  await expect(page.locator('.aprv-card')).toHaveCount(0, { timeout: 10000 })

  // 未命中：默认 ask = 现行为（pending + 弹卡）
  const idMiss = await seedApproval(request, 'sc-rules-miss', 'clean -fdx')
  const miss = await pollApproval(request, idMiss)
  expect(miss.status).toBe('pending')
  expect(miss.ruleHit || '').toBe('')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
})

test('deny 规则命中：直落库 denied + ruleHit，不弹卡', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await setRules(request, [{ opPattern: 'reset', effect: 'deny' }])

  const id = await seedApproval(request, 'sc-rules-deny', 'reset --hard HEAD~1')
  const data = await pollApproval(request, id)
  expect(data.status).toBe('denied')
  expect(data.ruleHit).toBe('reset')
  await expect(page.locator('.aprv-card')).toHaveCount(0, { timeout: 10000 })
})

test('全局优先：模式 = allow 时 deny 规则不评估（全局短路）', async ({ request }) => {
  await setRules(request, [{ opPattern: 'reset', effect: 'deny' }])
  await setApprovalMode(request, 'allow')

  const id = await seedApproval(request, 'sc-rules-shortcircuit', 'reset --hard')
  const data = await pollApproval(request, id)
  expect(data.status).toBe('allowed')
  expect(data.ruleHit || '').toBe('')
})

test('设置·安全分区：规则表 CRUD（暂存→保存→回读）+ 命中测试按钮', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // 设置 → 安全 → 审批规则页签（audit-log.spec 同款导航链）
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审批规则' }).click()
  const manager = page.getByTestId('approval-rules-manager')
  await expect(manager).toBeVisible({ timeout: 5000 })
  await expect(manager).toContainText('尚无规则')

  // 新增规则：git push → 允许（弹窗表单；NSelect 点 .n-base-selection 开菜单，
  // agent-terminal.spec / approve-all-confirm.spec 同款交互）
  await page.getByTestId('approval-rules-add').click()
  await page.getByTestId('approval-rules-form-pattern').locator('input').fill('git push')
  await page.getByTestId('approval-rules-form-effect').locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '允许（直接放行，不弹卡）' }).click()
  await page.getByTestId('approval-rules-form-save').click()

  // 暂存态可见 → 保存 → 服务端回读一致
  await expect(page.getByTestId('approval-rules-dirty')).toBeVisible()
  await expect(page.getByTestId('approval-rules-list')).toContainText('git push')
  await page.getByTestId('approval-rules-save').click()
  await expect(page.getByTestId('approval-rules-dirty')).toHaveCount(0, { timeout: 5000 })
  const res = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  const saved = ((await res.json()) as { data?: { agentApprovalRules?: Array<{ opPattern: string; effect: string }> } }).data
  expect(saved?.agentApprovalRules).toEqual([{ opPattern: 'git push', effect: 'allow' }])

  // 命中测试：命中已保存规则 → 结果带规则原文与动作
  await page.getByTestId('approval-rules-test-input').locator('input').fill('git push origin main')
  await page.getByTestId('approval-rules-test-btn').click()
  await expect(page.getByTestId('approval-rules-test-result')).toContainText('命中规则「git push」', { timeout: 5000 })
  await expect(page.getByTestId('approval-rules-test-result')).toContainText('允许')

  // 删除规则 → 保存 → 服务端清空
  await page.getByTestId('approval-rules-delete').click()
  await expect(page.getByTestId('approval-rules-dirty')).toBeVisible()
  await page.getByTestId('approval-rules-save').click()
  await expect(page.getByTestId('approval-rules-dirty')).toHaveCount(0, { timeout: 5000 })
  await expect(manager).toContainText('尚无规则', { timeout: 5000 })
  const res2 = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  const saved2 = ((await res2.json()) as { data?: { agentApprovalRules?: unknown[] } }).data
  expect(saved2?.agentApprovalRules).toEqual([])
})
