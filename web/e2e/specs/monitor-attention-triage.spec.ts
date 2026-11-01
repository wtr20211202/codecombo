import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 值班大屏「需注意」分诊条（P-20261005-164）E2E：
 *   - 全零整行隐藏（无事不扰）：清账后 /monitor 不渲染分诊条
 *   - 失败任务 + 待审批 → chips 出现；点击 chip 滚动定位到对应类目区
 *   - 今日告警：error 级计入、info/warning 不计入；点击 chip 开通知中心
 *   - 处理完毕行消失：审批裁决后 chip 消失整行隐藏；失败任务经「服务端清
 *     通知 + 页面重载」双清账后整行隐藏
 * 播种方式对齐 monitor-dashboard.spec（API 造 pending/会话/task.progress）与
 * notification-center.spec（POST /api/notifications 播种 + 前后清空防残留）。
 * 产品事实对账：task.progress failed 终态经 P-20261002-15 通知链入账 error
 * 级通知（utils/agentTaskNotify.ts，POST /api/notifications 持久化）——播种
 * 失败任务必然同帧抬升「今日告警」计数，断言按此耦合口径写；审批创建只走
 * 广播/webhook 总线不入通知中心（server/app/app.go ApprovalNotifier），计数
 * 不受审批播种影响。服务端 /notifications/clear 无删除广播（server/api/notify/
 * notification.go ClearNotifications 只清存储），已开页面的内存 store 不随之
 * 变化——涉及「行消失」的场景须重载页面让 loadHistory 对账清空后的服务端态
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，保证确定性 + 防残留 tmux 进程） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 清理 pending 审批（审批全局广播，残留会污染后续用例的 chip 计数） */
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

/** 清空通知（分诊条告警计数读通知中心全量，残留 error 条目会污染计数） */
async function cleanupNotifications(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  await request.post(`${BASE}/api/notifications/clear`, { headers })
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
  await cleanupNotifications(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
  await cleanupNotifications(request)
})

/** API 造一条失败任务进度（bySession 终态 failed，内存态不落服务端） */
async function seedFailedTask(request: APIRequestContext, headers: Record<string, string>, terminalId: string, task: string): Promise<void> {
  const res = await request.post(`${BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload: { task, step: '', status: 'failed', terminalId } },
  })
  expect(res.ok()).toBeTruthy()
}

test('全零整行隐藏：清账后不渲染分诊条（无事不扰）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)

  await expect(page.locator('.mon-root')).toBeVisible()
  await expect(page.locator('[data-testid="monitor-attention-bar"]')).toHaveCount(0)
})

test('失败任务+待审批 → chips 出现，点击滚动定位到对应类目区', async ({ page, request }) => {
  // 重型用例：12 条播种 + 两轮点击滚动断言，全套件串行负载下 30s 默认预算
  // 余量不足（retry 实测在滚动断言前段超时），提额到 60s（agent-chain 同款先例）
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)

  // 待审批（真实会话归属）+ 12 条失败任务（无需真实会话——bySession 由
  // WS 广播直接入账；12 张失败卡同时把任务类目区撑到视口之外，滚动断言才
  // 有分辨力）
  const session = await createAgentSessionApi(request, { name: 'mon-attn-agent' })
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: session.id, op: 'reset --hard', target: 'main', detail: 'e2e 分诊条审批' },
  })
  expect(appr.ok()).toBeTruthy()
  for (let i = 0; i < 12; i++) {
    await seedFailedTask(request, headers, `attn-fake-${i}`, `e2e 失败任务 ${i}`)
  }

  const bar = page.locator('[data-testid="monitor-attention-bar"]')
  await expect(bar).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[data-testid="monitor-attention-chip-failed"]')).toHaveText('12 任务失败', { timeout: 10000 })
  await expect(page.locator('[data-testid="monitor-attention-chip-approvals"]')).toHaveText('1 待审批')
  // 无停滞（无 running 超 10min 条目）→ 不渲染停滞 chip；告警 chip 按通知链
  // 耦合口径断言（12 条 failed 终态 → 12 条 error 通知，见文件头注）
  await expect(page.locator('[data-testid="monitor-attention-chip-stalled"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="monitor-attention-chip-alerts"]')).toHaveText('今日 12 告警', { timeout: 10000 })

  // 点击「待审批」chip → 滚动定位审批类目区（目标区顶缘落到 sticky 条下方）
  await page.locator('[data-testid="monitor-attention-chip-approvals"]').click()
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(() => {
    const el = document.querySelector('[data-testid="monitor-cat-approvals"]')
    return el ? el.getBoundingClientRect().top : -1
  }), { timeout: 5000 }).toBeLessThan(120)

  // 回顶后点击「任务失败」chip → 页面向任务类目区滚动（内容超出视口，滚动
  // 到目标即止；钳制场景下以「发生了滚动」为断言口径）
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await page.waitForTimeout(200)
  await page.locator('[data-testid="monitor-attention-chip-failed"]').click()
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBeGreaterThan(100)
})

test('今日告警：error 级计入（info/warning 不计），点击 chip 开通知中心', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)

  // 2 error + 1 warning + 1 info → 告警 chip 只计 error 级两条
  for (const n of [
    { type: 'error', category: 'task', title: 'e2e 告警甲' },
    { type: 'error', category: 'git', title: 'e2e 告警乙' },
    { type: 'warning', category: 'system', title: 'e2e 非告警-warning' },
    { type: 'info', category: 'system', title: 'e2e 非告警-info' },
  ]) {
    const res = await request.post(`${BASE}/api/notifications`, { headers, data: n })
    expect(res.ok()).toBeTruthy()
  }

  await gotoAndUnlock(page, `${BASE}/monitor`)

  const alertsChip = page.locator('[data-testid="monitor-attention-chip-alerts"]')
  await expect(alertsChip).toHaveText('今日 2 告警', { timeout: 10000 })

  // 点击告警 chip → 通知中心面板打开（App 层单实例，跨路由可用）
  await alertsChip.click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.nc-card')).toBeHidden()
})

test('处理完毕行消失：审批裁决后 chip 消失；失败任务随重载清空整行隐藏', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)

  const bar = page.locator('[data-testid="monitor-attention-bar"]')
  const approvalsChip = page.locator('[data-testid="monitor-attention-chip-approvals"]')

  // 播种 pending → chip 出现；API 裁决（approval.resolved 广播回流清账）→
  // 全零整行隐藏
  const session = await createAgentSessionApi(request, { name: 'mon-attn-clear' })
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: session.id, op: 'rm -rf build', target: 'tmp', detail: 'e2e 分诊条清账' },
  })
  expect(appr.ok()).toBeTruthy()
  const apprId = ((await appr.json()) as { data?: { id?: string } }).data?.id || ''
  await expect(approvalsChip).toHaveText('1 待审批', { timeout: 10000 })

  const resolve = await request.post(`${BASE}/api/ops-confirm/${apprId}/resolve`, {
    headers, data: { allow: true, always: false },
  })
  expect(resolve.ok()).toBeTruthy()
  await expect(bar).toHaveCount(0, { timeout: 5000 })

  // 失败任务 chip：bySession 内存态。failed 终态同帧入账 error 通知（通知链
  // 耦合见文件头注），「行消失」须双清账——服务端清通知 + 页面重载（重载把
  // bySession 内存态清空，loadHistory 对账清空后的服务端通知列表）
  await seedFailedTask(request, headers, session.id, 'e2e 待清失败任务')
  await expect(page.locator('[data-testid="monitor-attention-chip-failed"]')).toHaveText('1 任务失败', { timeout: 10000 })
  const clear = await request.post(`${BASE}/api/notifications/clear`, { headers })
  expect(clear.ok()).toBeTruthy()
  await page.reload()
  await expect(page.locator('.mon-root')).toBeVisible()
  await expect(bar).toHaveCount(0, { timeout: 10000 })
})
