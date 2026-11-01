import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批规则的定时自动恢复（P-20261003-243 临时放行窗口）：规则可带可选
 * tempUntil（临时启用至）——窗口内规则照常生效；到点规则动作自动回「询问」
 *   1. 窗口内 allow：ops-confirm 直落库 allowed + ruleHit，不弹卡
 *   2. 到点恢复：创建审批触发「入队先清场」物化——新审批走 ask 卡流（带
 *      ruleHit）、设置回读规则已回 ask 且窗口字段清除、通知中心入账到期通知
 *      （幂等：物化后二次创建不重复入账）
 *   3. 设置·安全分区 UI：过期窗口徽标（窗口已结束）、编辑弹窗勾选/取消临时
 *      启用、新建带窗口规则保存往返（服务端回读 tempUntil）
 * 恢复的确定性触发沿 P-45 先例：CreateAgentApproval 创建前同步清扫（10min
 * 周期巡检只作生产兜底，e2e 不等表）。
 * 全局审批模式与规则表都是服务端共享状态：beforeEach 归位 ask + 清空规则表 +
 * 清空通知，afterEach 兜底还原，防污染后续用例
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const NOTIFY_TITLE_KEY = 'approval.rules.notify.title'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function setSettings(request: APIRequestContext, patch: Record<string, unknown>): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: patch,
  })
}

/** 规则表整体替换（还原/播种都走这一口） */
async function setRules(
  request: APIRequestContext,
  rules: Array<{ opPattern: string; effect: string; tempUntil?: string }>,
): Promise<void> {
  const res = await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalRules: rules },
  })
  expect(res.ok()).toBeTruthy()
}

async function readRules(request: APIRequestContext): Promise<Array<{ opPattern: string; effect: string; tempUntil?: string }>> {
  const res = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: { agentApprovalRules?: Array<{ opPattern: string; effect: string; tempUntil?: string }> } }).data?.agentApprovalRules || []
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
    data: { sessionId, op, target: '', detail: 'P-20261003-243 临时放行窗口验证' },
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

async function windowNotifyCount(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${BASE}/api/notifications`, { headers: await unlockHeaders(request) })
  const list = ((await res.json()) as { data?: { titleKey?: string }[] }).data || []
  return list.filter(n => n.titleKey === NOTIFY_TITLE_KEY).length
}

test.beforeEach(async ({ request }) => {
  await setSettings(request, { agentApprovalMode: 'ask' })
  await setRules(request, [])
  await request.post(`${BASE}/api/notifications/clear`, { headers: await unlockHeaders(request) })
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await setSettings(request, { agentApprovalMode: 'ask' })
  await setRules(request, [])
  await cleanupApprovals(request)
})

test('窗口内临时 allow：直落库 allowed + ruleHit，不弹卡', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await setRules(request, [{
    opPattern: 'git push',
    effect: 'allow',
    tempUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
  }])

  const id = await seedApproval(request, 'sc-twin-allow', 'git push origin main')
  const data = await pollApproval(request, id)
  expect(data.status).toBe('allowed')
  expect(data.ruleHit).toBe('git push')
  await expect(page.locator('.aprv-card')).toHaveCount(0, { timeout: 10000 })
  // 窗口内放行不入账到期通知
  expect(await windowNotifyCount(request)).toBe(0)
})

test('到点恢复：创建触发物化——新审批走 ask 卡流 + 规则回 ask + 通知入账（幂等）', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await setRules(request, [{
    opPattern: 'git push',
    effect: 'allow',
    tempUntil: new Date(Date.now() - 60_000).toISOString(),
  }])

  // 创建即触发「入队先清场」：到点规则物化回 ask，新审批按恢复后的规则裁决
  //（ask 卡流，命中记录仍带 ruleHit 留审计）
  const id = await seedApproval(request, 'sc-twin-expired', 'git push origin main')
  const data = await pollApproval(request, id)
  expect(data.status).toBe('pending')
  expect(data.ruleHit).toBe('git push')
  await expect(page.locator('.aprv-card', { hasText: 'git push' })).toHaveCount(1, { timeout: 10000 })

  // 设置回读：规则动作已回 ask，窗口字段清除（物化落盘，非只读投影）
  const rules = await readRules(request)
  expect(rules).toEqual([{ opPattern: 'git push', effect: 'ask' }])

  // 通知中心入账：titleKey/bodyKey 模板 + pattern 参数
  const res = await request.get(`${BASE}/api/notifications`, { headers: await unlockHeaders(request) })
  const notifs = ((await res.json()) as { data?: { titleKey?: string; bodyKey?: string; msgParams?: Record<string, unknown> }[] }).data || []
  const hit = notifs.find(n => n.titleKey === NOTIFY_TITLE_KEY)
  expect(hit, 'rule window expiry notification recorded').toBeTruthy()
  expect(hit!.bodyKey).toBe('approval.rules.notify.body')
  expect(hit!.msgParams?.pattern).toBe('git push')

  // 幂等：物化后二次创建不重复入账
  const id2 = await seedApproval(request, 'sc-twin-again', 'git push origin main')
  expect((await pollApproval(request, id2)).status).toBe('pending')
  expect(await windowNotifyCount(request)).toBe(1)
})

test('设置 UI：过期窗口徽标 + 编辑取消临时启用 + 新建带窗口规则保存往返', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await setRules(request, [{
    opPattern: 'git push',
    effect: 'allow',
    tempUntil: new Date(Date.now() - 60_000).toISOString(),
  }])

  // 设置 → 安全 → 审批规则页签（audit-log.spec 同款导航链）
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审批规则' }).click()
  const manager = page.getByTestId('approval-rules-manager')
  await expect(manager).toBeVisible({ timeout: 5000 })

  // 过期窗口（物化未跑时存量形态）：行内「窗口已结束」弱化徽标
  await expect(manager.getByTestId('approval-rules-temp-expired')).toBeVisible({ timeout: 5000 })

  // 编辑：勾选态回显 → 取消临时启用 → 保存 → 服务端窗口字段清除
  await manager.locator('.arls-row').first().getByRole('button', { name: '编辑' }).click()
  // naive-ui NCheckbox 的 testid 落在根 div（role=checkbox，aria-checked 反映勾选态）
  const toggle = page.getByTestId('approval-rules-form-temp-toggle')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await page.getByTestId('approval-rules-form-save').click()
  await expect(page.getByTestId('approval-rules-dirty')).toBeVisible()
  await page.getByTestId('approval-rules-save').click()
  await expect(page.getByTestId('approval-rules-dirty')).toHaveCount(0, { timeout: 5000 })
  expect(await readRules(request)).toEqual([{ opPattern: 'git push', effect: 'allow' }])

  // 新建带窗口规则：勾选临时启用 → 时刻选择器出现 → 保存往返。
  // 键入须带秒（zh-CN locale dateTimeFormat=yyyy-MM-dd HH:mm:ss，缺秒
  // strictParse 失败值不生效——实测踩坑），面板「确认」提交（Enter 不生效）
  await page.getByTestId('approval-rules-add').click()
  await page.getByTestId('approval-rules-form-pattern').locator('input').fill('deploy')
  await page.getByTestId('approval-rules-form-effect').locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '允许（直接放行，不弹卡）' }).click()
  await page.getByTestId('approval-rules-form-temp-toggle').click()
  const atInput = page.getByTestId('approval-rules-form-temp-at').locator('input')
  await expect(atInput).toBeVisible()
  await atInput.click()
  await atInput.pressSequentially('2099-01-01 10:00:30', { delay: 15 })
  await page.locator('.n-date-panel .n-button').filter({ hasText: '确认' }).click()
  await page.getByTestId('approval-rules-form-save').click()
  await expect(page.getByTestId('approval-rules-dirty')).toBeVisible()
  await page.getByTestId('approval-rules-save').click()
  await expect(page.getByTestId('approval-rules-dirty')).toHaveCount(0, { timeout: 5000 })

  const saved = await readRules(request)
  expect(saved).toHaveLength(2)
  const winRule = saved.find(r => r.opPattern === 'deploy')
  expect(winRule?.effect).toBe('allow')
  expect(winRule?.tempUntil, 'tempUntil round-trips to the server').toBeTruthy()
  expect(new Date(winRule!.tempUntil!).getUTCFullYear()).toBe(2099)
  // 窗口内规则行显「临时至 …」徽标（非过期态）
  await expect(manager.getByTestId('approval-rules-temp-tag')).toContainText('2099')
})
