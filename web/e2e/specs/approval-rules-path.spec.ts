import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批规则路径维度（P-20261004-67 op×path 双条件策略）：
 *   1. 「files.write + docs/** → allow」：docs 下写自动放行（ruleHit 注记带
 *      路径条件）、src 下写不命中路径条件 → 仍走审批卡流
 *   2. 「.env* → ask」路径规则优先序：窄路径规则在前压过宽 op 规则的 allow
 *   3. 设置 UI：规则表单路径条件输入 → 行内路径徽标 → 双输入（op+路径）命中测试
 * 规则表/全局模式是服务端共享状态：beforeEach/afterEach 归位，防污染（同
 * approval-rules.spec 惯例）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

interface SeedRule {
  opPattern: string
  pathPattern?: string
  effect: string
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function setApprovalMode(request: APIRequestContext, mode: 'ask' | 'allow'): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: mode },
  })
}

/** 规则表整体替换（还原/播种都走这一口） */
async function setRules(request: APIRequestContext, rules: SeedRule[]): Promise<void> {
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

async function seedApproval(
  request: APIRequestContext,
  sessionId: string,
  op: string,
  target: string,
): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target, detail: 'P-20261004-67 路径条件验证' },
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

test('files.write + docs/** → allow：docs 下写自动放行（ruleHit 带路径注记），src 下写仍走审批卡', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await setRules(request, [{ opPattern: 'files.write', pathPattern: 'docs/**', effect: 'allow' }])

  // docs 下：双条件命中 → 创建即 allowed，ruleHit 注记带路径条件，页面无审批卡
  const id = await seedApproval(request, 'sc-rule-path-allow', 'files.write', 'docs/notes.md')
  const data = await pollApproval(request, id)
  expect(data.status).toBe('allowed')
  expect(data.ruleHit).toBe('files.write (path: docs/**)')
  await expect(page.locator('.aprv-card')).toHaveCount(0, { timeout: 10000 })

  // 跨目录段同命中（** 语义）
  const idDeep = await seedApproval(request, 'sc-rule-path-deep', 'files.write', 'docs/sub/guide.md')
  expect((await pollApproval(request, idDeep)).status).toBe('allowed')

  // src 下：op 命中但路径不命中 → 按未命中回落审批卡流（pending + 弹卡）
  const idMiss = await seedApproval(request, 'sc-rule-path-miss', 'files.write', 'src/main.go')
  const miss = await pollApproval(request, idMiss)
  expect(miss.status).toBe('pending')
  expect(miss.ruleHit || '').toBe('')
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
})

test('.env* → ask 路径规则优先序：窄路径规则在前压过宽 op 规则的 allow', async ({ request }) => {
  await setRules(request, [
    { opPattern: 'files.write', pathPattern: '.env*', effect: 'ask' },
    { opPattern: 'files.write', effect: 'allow' },
  ])

  // .env.local：路径规则在前先命中 → ask（pending 弹卡，ruleHit 注记路径条件）
  const idEnv = await seedApproval(request, 'sc-rule-path-env', 'files.write', '.env.local')
  const env = await pollApproval(request, idEnv)
  expect(env.status).toBe('pending')
  expect(env.ruleHit).toBe('files.write (path: .env*)')

  // 其余路径：窄规则路径不命中 → 透传后面的宽 allow 规则
  const idOther = await seedApproval(request, 'sc-rule-path-other', 'files.write', 'src/app.ts')
  const other = await pollApproval(request, idOther)
  expect(other.status).toBe('allowed')
  expect(other.ruleHit).toBe('files.write')
})

test('设置 UI：路径条件表单输入 → 行内徽标 → op+路径双输入命中测试', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // 设置 → 安全 → 审批规则页签（approval-rules.spec 同款导航链）
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审批规则' }).click()
  const manager = page.getByTestId('approval-rules-manager')
  await expect(manager).toBeVisible({ timeout: 5000 })

  // 新增规则：op + 路径条件 + 允许（弹窗表单）
  await page.getByTestId('approval-rules-add').click()
  await page.getByTestId('approval-rules-form-pattern').locator('input').fill('files.write')
  await page.getByTestId('approval-rules-form-path').locator('input').fill('docs/**')
  await page.getByTestId('approval-rules-form-effect').locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '允许（直接放行，不弹卡）' }).click()
  await page.getByTestId('approval-rules-form-save').click()

  // 暂存态行内路径徽标 → 保存 → 服务端回读带 pathPattern
  await expect(page.getByTestId('approval-rules-dirty')).toBeVisible()
  await expect(page.getByTestId('approval-rules-item-path')).toHaveText('docs/**')
  await page.getByTestId('approval-rules-save').click()
  await expect(page.getByTestId('approval-rules-dirty')).toHaveCount(0, { timeout: 5000 })
  const res = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  const saved = ((await res.json()) as { data?: { agentApprovalRules?: SeedRule[] } }).data
  expect(saved?.agentApprovalRules).toEqual([{ opPattern: 'files.write', pathPattern: 'docs/**', effect: 'allow' }])

  // 双输入命中测试：路径命中 → 结果带路径注记；路径不命中 → 未命中任何规则
  await page.getByTestId('approval-rules-test-input').locator('input').fill('files.write')
  await page.getByTestId('approval-rules-test-path-input').locator('input').fill('docs/notes.md')
  await page.getByTestId('approval-rules-test-btn').click()
  await expect(page.getByTestId('approval-rules-test-result')).toContainText('命中规则「files.write (path: docs/**)」', { timeout: 5000 })
  await page.getByTestId('approval-rules-test-path-input').locator('input').fill('src/main.go')
  await page.getByTestId('approval-rules-test-btn').click()
  await expect(page.getByTestId('approval-rules-test-result')).toContainText('未命中任何规则', { timeout: 5000 })

  // 清理：删除规则 → 保存 → 服务端清空
  await page.getByTestId('approval-rules-delete').click()
  await expect(page.getByTestId('approval-rules-dirty')).toBeVisible()
  await page.getByTestId('approval-rules-save').click()
  await expect(page.getByTestId('approval-rules-dirty')).toHaveCount(0, { timeout: 5000 })
  const res2 = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  const saved2 = ((await res2.json()) as { data?: { agentApprovalRules?: unknown[] } }).data
  expect(saved2?.agentApprovalRules).toEqual([])
})
