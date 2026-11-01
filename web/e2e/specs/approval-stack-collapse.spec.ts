import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批卡堆溢出折叠（P-20261003-25）：待裁决超 3 张自动折叠为摘要条——
 *   1. 造 5 卡 → 摘要条出现（N 项待裁决 + 键盘目标角标）且仅最新一张完整展开
 *   2. 摘要条点击展开全堆 / 再点收起；展开态会话内记忆（新卡入堆不回折），
 *      堆清空后重置（下次爆发从折叠态起步）
 *   3. 折叠态键盘 3 恒裁最旧卡（目标与呈现解耦，角标防误裁决），裁决至 3 张
 *      以下摘要条退场恢复全显
 *   4. 折叠态按 2 → 先展开全堆再弹 Popconfirm 二次确认（确认面锚在真实首卡），
 *      Enter 落账裁的是首卡
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
    data: { sessionId, op, target: '', detail: 'P-20261003-25 卡片堆折叠验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function approvalStatus(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: { status?: string } }).data?.status || ''
}

/** 读回全局审批模式（键 2 落盘断言用） */
async function getApprovalMode(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: { agentApprovalMode?: string } }).data?.agentApprovalMode || 'ask'
}

/** 按序造 n 张 pending 审批（op 逐张可辨——断言折叠态可见的是最新一张） */
const STACK_OPS = ['reset --hard', 'push --force', 'clean -fdx', 'rm -rf build', 'drop table tmp', 'chmod 777 /']
async function seedStack(request: APIRequestContext, n: number, tag: string): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    ids.push(await seedApproval(request, `sc-stack-${tag}-${i + 1}`, STACK_OPS[i] || `op ${i + 1}`))
  }
  return ids
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test('超阈值自动折叠：摘要条出现且仅最新一张完整展开（角标提示键盘目标序号）', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  await seedStack(request, 5, 'fold')

  // 摘要条在场：计数 5 + 键盘目标角标（恒最旧卡 #1/5，防把可见最新卡当目标）
  const summary = page.locator('[data-test="aprv-summary"]')
  await expect(summary).toBeVisible({ timeout: 10000 })
  await expect(summary.locator('[data-test="aprv-summary-count"]')).toHaveText('5 项待裁决')
  const target = summary.locator('[data-test="aprv-summary-target"]')
  await expect(target).toHaveText('键盘目标 #1/5')
  await expect(target).toHaveAttribute('title', 'reset --hard')

  // 折叠态只完整展示最新一张（第 5 张），其余收进计数
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('drop table tmp')
  await expect(summary).toContainText('展开全部')
})

test('摘要条点击展开全堆/再点收起；展开态会话内记忆，堆清空后重置', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  await seedStack(request, 5, 'toggle')
  const summary = page.locator('[data-test="aprv-summary"]')
  const card = page.locator('.aprv-card')
  await expect(summary).toBeVisible({ timeout: 10000 })
  await expect(card).toHaveCount(1)

  // 点击展开全堆：5 张齐显，摘要条保持在场（切换为「收起」）
  await summary.click()
  await expect(card).toHaveCount(5)
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('收起')
  await expect(card.first()).toContainText('reset --hard')

  // 展开态会话内记忆：第 6 张入堆不回折（仍全量呈现）
  await seedApproval(request, 'sc-stack-toggle-6', 'chmod 777 /')
  await expect(card).toHaveCount(6)

  // 再点收起：回到折叠态，计数跟到 6
  await summary.click()
  await expect(card).toHaveCount(1)
  await expect(summary.locator('[data-test="aprv-summary-count"]')).toHaveText('6 项待裁决')
  await expect(card).toContainText('chmod 777 /')

  // 堆清空后重置：清账 → 摘要条退场；重造 4 张回折叠态起步（不持久化）
  await cleanupApprovals(request)
  await expect(card).toHaveCount(0, { timeout: 10000 })
  await expect(summary).toHaveCount(0, { timeout: 10000 })
  await seedStack(request, 4, 'toggle-reset')
  await expect(summary).toBeVisible({ timeout: 10000 })
  await expect(card).toHaveCount(1)
  await expect(summary.locator('[data-test="aprv-summary-count"]')).toHaveText('4 项待裁决')
})

test('折叠态键盘 3 恒裁最旧卡；裁决至 3 张以下摘要条退场恢复全显', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const ids = await seedStack(request, 5, 'hotkey')
  const summary = page.locator('[data-test="aprv-summary"]')
  const card = page.locator('.aprv-card')
  await expect(summary).toBeVisible({ timeout: 10000 })
  await expect(card).toHaveCount(1)

  // 折叠态按 3 → 裁的是最旧卡（第 1 张），不是可见的最新卡；仍 >3 张保持折叠
  await page.keyboard.press('3')
  expect(await approvalStatus(request, ids[0])).toBe('denied')
  expect(await approvalStatus(request, ids[1])).toBe('pending')
  await expect(summary.locator('[data-test="aprv-summary-count"]')).toHaveText('4 项待裁决')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('drop table tmp')

  // 再按 3 → 剩 3 张达阈值内：摘要条退场，恢复全显（第 1、2 张被裁，
  // 首张可见卡变为原第 3 张）
  await page.keyboard.press('3')
  await expect(summary).toHaveCount(0, { timeout: 10000 })
  await expect(card).toHaveCount(3)
  await expect(card.first()).toContainText('clean -fdx')
  expect(await approvalStatus(request, ids[1])).toBe('denied')
  expect(await approvalStatus(request, ids[2])).toBe('pending')
  expect(await approvalStatus(request, ids[4])).toBe('pending')
})

test('折叠态按 2：先展开全堆再弹 Popconfirm 二次确认，Enter 落账裁的是首卡', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const ids = await seedStack(request, 5, 'always')
  const summary = page.locator('[data-test="aprv-summary"]')
  const card = page.locator('.aprv-card')
  await expect(summary).toBeVisible({ timeout: 10000 })
  await expect(card).toHaveCount(1)

  // 折叠态按 2 → 目标卡（最旧）不在屏：先自动展开全堆，三选一放行时限弹层
  //（P-20261003-316，P-126 升级面）锚在真实卡上
  await page.keyboard.press('2')
  await expect(card).toHaveCount(5, { timeout: 10000 })
  const confirm = page.locator('.aprv-tier-pop')
  await expect(confirm).toBeVisible({ timeout: 10000 })
  await expect(confirm).toContainText('选择放行时限')
  expect(await approvalStatus(request, ids[0])).toBe('pending')

  // 焦点已入弹层选项行 → 弹层内按 3（永久档）落账：裁的是首卡（永久放行落盘），余卡不动
  await page.keyboard.press('3')
  await expect(card).toHaveCount(4, { timeout: 10000 })
  expect(await approvalStatus(request, ids[0])).toBe('allowed')
  expect(await approvalStatus(request, ids[1])).toBe('pending')
  expect(await approvalStatus(request, ids[4])).toBe('pending')
  expect(await getApprovalMode(request)).toBe('allow')

  // 放行徽标常驻亮起（afterEach 归位 ask；余 4 张仍超阈值，摘要条保持展开态在场）
  await expect(page.locator('[data-test="aprv-allow-badge"]')).toBeVisible({ timeout: 10000 })
  await expect(summary).toBeVisible()
})
