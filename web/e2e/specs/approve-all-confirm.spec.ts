import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 「完全允许」三选一放行时限 + 常驻放行徽标（P-20261003-316，P-20261002-126 升级）：
 *   1. 完全允许按钮点击 → 三选一档位弹层（会话级/24h/永久，永久标「建议」在 24h）；
 *      取消不落账
 *   2. 永久档：后端 allowed + 全局审批档位落盘 allow + 徽标常驻亮起（永久档不回归）
 *   3. 放行态：新审批服务端直接 allowed 落账，不再弹卡（静默放行语义）
 *   4. API 切回 ask → settings.changed 广播回流，徽标即时熄灭
 *   5. 点击徽标 → 设置弹窗直达「通用」分区恢复入口；改回每次询问保存后
 *      徽标消失、新审批恢复弹卡（审批闭环回到逐次询问）
 * 全局审批档位是服务端共享状态（approval-* 域用例都吃它）：beforeEach 归位
 * ask + afterEach 兜底还原，且用例内放行窗口尽量短，防污染后续用例
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
async function setApprovalMode(request: APIRequestContext, mode: 'ask' | 'allow' | 'allow-session' | 'allow-24h'): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: mode },
  })
}

/** 读回全局审批档位（落盘断言用） */
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

/** API 造 pending 审批（满种方式对齐 agent-terminal.spec 审批三态用例） */
async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-316 放行时限/放行徽标验证' },
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

test('三选一弹层：打开见三档（24h 标建议）→ 取消不落账 → 永久档放行落盘 + 徽标常驻', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-p316-tier', 'clean -fdx')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 点击完全允许 → 三选一档位弹层：三档齐备，24h 带建议标记
  await card.getByRole('button', { name: '完全允许' }).click()
  const pop = page.locator('.aprv-tier-pop')
  await expect(pop).toBeVisible()
  await expect(pop).toContainText('选择放行时限')
  await expect(pop.locator('[data-test="aprv-tier-session"]')).toContainText('本会话放行')
  await expect(pop.locator('[data-test="aprv-tier-24h"]')).toContainText('放行 24 小时')
  await expect(pop.locator('[data-test="aprv-tier-24h"]')).toContainText('建议')
  await expect(pop.locator('[data-test="aprv-tier-always"]')).toContainText('永久放行')

  // 取消 → 不落账：卡片保留 + 后端仍 pending + 档位未翻转
  await pop.locator('[data-test="aprv-tier-cancel"]').click()
  await expect(pop).toBeHidden()
  await expect(card).toHaveCount(1)
  await expect(page.locator('[data-test="aprv-allow-badge"]')).toHaveCount(0)
  expect(await approvalStatus(request, id)).toBe('pending')
  expect(await getApprovalMode(request)).toBe('ask')

  // 再点完全允许 → 永久档 → 卡片清账 + 后端 allowed + 档位落盘 allow（永久档不回归）
  await card.getByRole('button', { name: '完全允许' }).click()
  await page.locator('.aprv-tier-pop [data-test="aprv-tier-always"]').click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  expect(await approvalStatus(request, id)).toBe('allowed')
  expect(await getApprovalMode(request)).toBe('allow')

  // 放行徽标常驻亮起（本页 resolve 同帧镜像 + settings.changed 广播回流双保险）
  const badge = page.locator('[data-test="aprv-allow-badge"]')
  await expect(badge).toBeVisible({ timeout: 10000 })
  await expect(badge).toHaveAttribute('title', /全局放行中/)
  await expect(badge).toContainText('全局放行中')

  // 放行态：新审批服务端直接 allowed 落账（不广播 pending），卡片永不出现
  const silentId = await seedApproval(request, 'sc-p316-silent', 'rm -rf')
  expect(await approvalStatus(request, silentId)).toBe('allowed')
  await expect(card).toHaveCount(0)

  // API 切回 ask → settings.changed 广播回流，徽标即时熄灭（无需刷新页面）
  await setApprovalMode(request, 'ask')
  await expect(badge).toBeHidden({ timeout: 10000 })

  // 恢复询问：新审批重新弹卡（切回即时生效，非下页才生效）
  const askId = await seedApproval(request, 'sc-p316-restore', 'push --force')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('push --force')

  // 清账放行（afterEach 兜底之外再收一次，卡片消失不留悬浮物）
  await request.post(`${BASE}/api/ops-confirm/${askId}/resolve`, {
    headers: await unlockHeaders(request), data: { allow: true, always: false },
  })
  await expect(card).toHaveCount(0, { timeout: 10000 })
})

test('24h 档：弹层选 24 小时 → 档位落盘 allow-24h + 徽标带剩余时限；过期（时间注入）回 ask', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-p316-24h', 'reset --hard')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  await card.getByRole('button', { name: '完全允许' }).click()
  await page.locator('.aprv-tier-pop [data-test="aprv-tier-24h"]').click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  expect(await approvalStatus(request, id)).toBe('allowed')
  expect(await getApprovalMode(request)).toBe('allow-24h')

  // 徽标带剩余时限（24h 放行中 · 剩余 X）
  const badge = page.locator('[data-test="aprv-allow-badge"]')
  await expect(badge).toBeVisible({ timeout: 10000 })
  await expect(badge).toContainText(/24h 放行中 · 剩余/)

  // 时间注入（到期时刻经设置 API 写入过去值）：判定惰性回 ask——新审批恢复弹卡
  const past = new Date(Date.now() - 60_000).toISOString()
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: 'allow-24h', agentApprovalExpiresAt: past },
  })
  expect(await getApprovalMode(request)).toBe('ask')
  const askId = await seedApproval(request, 'sc-p316-24h-2', 'clean -fdx')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  expect(await approvalStatus(request, askId)).toBe('pending')

  // 徽标随广播回流熄灭（到期归一 ask 的档位镜像刷新）
  await expect(badge).toBeHidden({ timeout: 10000 })

  await request.post(`${BASE}/api/ops-confirm/${askId}/resolve`, {
    headers: await unlockHeaders(request), data: { allow: true, always: false },
  })
  await expect(card).toHaveCount(0, { timeout: 10000 })
})

test('会话级档：本会话放行异会话仍问 + 徽标会话数 + 会话外 API 档位不外溢', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-p316-sess-1', 'clean -fdx')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  await card.getByRole('button', { name: '完全允许' }).click()
  await page.locator('.aprv-tier-pop [data-test="aprv-tier-session"]').click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  expect(await approvalStatus(request, id)).toBe('allowed')
  expect(await getApprovalMode(request)).toBe('allow-session')

  // 徽标会话级分语（含放行会话数）
  const badge = page.locator('[data-test="aprv-allow-badge"]')
  await expect(badge).toBeVisible({ timeout: 10000 })
  await expect(badge).toContainText('会话级放行中 · 1 个会话')

  // 同会话新审批：服务端直接 allowed（会话级放行生效）
  const sameId = await seedApproval(request, 'sc-p316-sess-1', 'rm -rf')
  expect(await approvalStatus(request, sameId)).toBe('allowed')
  await expect(card).toHaveCount(0)

  // 异会话新审批：仍弹卡（会话级不外溢）
  const otherId = await seedApproval(request, 'sc-p316-sess-2', 'push --force')
  expect(await approvalStatus(request, otherId)).toBe('pending')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('push --force')

  await request.post(`${BASE}/api/ops-confirm/${otherId}/resolve`, {
    headers: await unlockHeaders(request), data: { allow: true, always: false },
  })
  await expect(card).toHaveCount(0, { timeout: 10000 })
})

test('放行徽标：点击直达设置恢复入口，改回每次询问后徽标消失且审批恢复弹卡', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // 先走完整三选一链进入永久放行态（兼作档位链路回归）
  const id = await seedApproval(request, 'sc-p316-recovery', 'reset --hard')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await card.getByRole('button', { name: '完全允许' }).click()
  await page.locator('.aprv-tier-pop [data-test="aprv-tier-always"]').click()
  await expect(card).toHaveCount(0, { timeout: 10000 })

  const badge = page.locator('[data-test="aprv-allow-badge"]')
  await expect(badge).toBeVisible({ timeout: 10000 })

  // 点击徽标 → 设置弹窗直达「通用」分区（恢复入口），审批模式下拉即当前放行态
  await badge.click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 10000 })
  const modeRow = modal.locator('.setting-row').filter({ hasText: '高危操作审批模式' })
  await expect(modeRow.locator('.n-base-selection')).toContainText('永久放行（不再询问）', { timeout: 10000 })

  // 改回每次询问 + 保存（PUT 成功即关弹窗 + settings.changed 广播）
  await modeRow.locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '每次询问' }).click()
  await modal.locator('.settings-footer').getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '设置已保存' })).toBeVisible({ timeout: 10000 })

  // 徽标消失（广播回流刷新镜像）+ 新审批恢复弹卡（逐次询问回到位）
  await expect(badge).toBeHidden({ timeout: 10000 })
  expect(await getApprovalMode(request)).toBe('ask')
  const askId = await seedApproval(request, 'sc-p316-recovery-2', 'clean -fdx')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  expect(await approvalStatus(request, askId)).toBe('pending')
})
