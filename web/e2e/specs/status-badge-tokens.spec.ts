import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { API_BASE } from '../../tests/api-base'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 状态徽标语义色四档统一 E2E（P-20261003-285）：
 * 六主题 colors 暴露 status-running/success/failed/waiting 四档语义 token
 * （进行中/成功/失败/等待 → 主题变量映射表），各面状态徽标引用语义名渲染。
 * 本 spec 守「各面徽标同语义同色」的运行时不变量：
 *   1. 通知中心四类类别点 = 四档 token（success/error/warning/info →
 *      成功/失败/等待/进行中），且四档两两互异（四档设计前提）
 *   2. 审批卡 pending 脉冲点 = 等待档 = 通知警示点（跨面同语义同色）
 *   3. 值班大屏任务卡 running/failed 点 = 进行中/失败档
 * 断言不锚具体色值——探针元素现场解析 token 计算色，与徽标点计算色比对，
 * 任意主题下恒成立（主题无关断言）。
 */

/** 清理 pending 审批（.aprv-card 全局常驻，残留会污染后续用例） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter((x) => x.status === 'pending')) {
    await request.post(`${API_BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** 清空通知（通知中心为跨用例共享的服务端域） */
async function clearNotifications(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function seedNotification(headers: Record<string, string>, type: string, title: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type, category: 'system', title }),
  })
  expect(res.ok).toBeTruthy()
}

/** task.progress 上报（真实链路：ops-notify → WS 广播 → assistantTask store） */
async function reportProgress(
  request: APIRequestContext,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload },
  })
  expect(res.ok()).toBeTruthy()
}

/**
 * 语义档解析色探针：临时元素引用 `var(--<token>)` 现场求计算色——与徽标点
 * 同一文档/同一主题下解析，任意主题下比对恒成立
 */
async function tierColor(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('span')
    probe.style.background = `var(--${t})`
    document.body.appendChild(probe)
    const c = getComputedStyle(probe).backgroundColor
    probe.remove()
    return c
  }, token)
}

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
  await clearNotifications(request)
})

test.afterEach(async ({ request }) => {
  await cleanupApprovals(request)
  await clearNotifications(request)
})

test('通知中心四类类别点 = 状态语义色四档，且四档两两互异', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await seedNotification(headers, 'success', 'e2e-语义色-success')
  await seedNotification(headers, 'warning', 'e2e-语义色-warning')
  await seedNotification(headers, 'error', 'e2e-语义色-error')
  await seedNotification(headers, 'info', 'e2e-语义色-info')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

  // 四类点 = 四档 token（notif success→成功 / error→失败 / warning→等待 / info→进行中）
  const cases: Array<{ type: string; token: string }> = [
    { type: 'success', token: 'status-success' },
    { type: 'error', token: 'status-failed' },
    { type: 'warning', token: 'status-waiting' },
    { type: 'info', token: 'status-running' },
  ]
  for (const { type, token } of cases) {
    const dot = page.locator(`.nc-item.notif-type-${type} .nc-dot`).first()
    await expect(dot).toBeVisible()
    expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      await tierColor(page, token),
    )
  }

  // 四档互异（映射表把四个语义档映到四个不同色相——塌档即此翻红）
  const colors = await Promise.all(cases.map(({ token }) => tierColor(page, token)))
  expect(new Set(colors).size).toBe(cases.length)
})

test('审批 pending 点与通知警示点同色（等待档跨面一致）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  // 先造 pending 后进页：approval.pending 广播此刻无订阅者，卡片靠挂载补账出现
  const created = await request.post(`${API_BASE}/api/ops-confirm`, {
    headers, data: { op: 'git.push', target: 'main', detail: 'e2e-语义色-等待档' },
  })
  expect(created.ok()).toBeTruthy()
  await seedNotification(headers, 'warning', 'e2e-语义色-等待档')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await expect(page.locator('.aprv-card')).toBeVisible({ timeout: 10000 })

  const aprvDot = page.locator('.aprv-card .aprv-dot').first()
  const waiting = await tierColor(page, 'status-waiting')
  expect(await aprvDot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(waiting)

  // 跨面同语义同色：通知中心 warning 点同开时与审批点同色
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const warnDot = page.locator('.nc-item.notif-type-warning .nc-dot').first()
  await expect(warnDot).toBeVisible()
  expect(await warnDot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(waiting)
})

test('值班大屏任务卡 running/failed 点 = 进行中/失败档', async ({ page, request }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  await expect(page.locator('.mon-root')).toBeVisible()

  const session = await createAgentSessionApi(request, { name: 'e2e-status-token-agent' })
  try {
    await reportProgress(request, headers, {
      task: '语义色任务', step: '步骤', status: 'running', terminalId: session.id,
    })
    // 按任务名锚定本用例的卡（套件串行但共享服务端，防他例残留任务卡干扰计数）
    const taskCard = page.locator('.mon-card.is-task', { hasText: '语义色任务' })
    await expect(taskCard).toHaveCount(1, { timeout: 10000 })

    const runningDot = taskCard.locator('.mon-dot.is-running')
    await expect(runningDot).toHaveCount(1)
    expect(await runningDot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      await tierColor(page, 'status-running'),
    )

    // 终态覆盖：failed 点翻失败档（同卡点位换档，颜色随语义 token）
    await reportProgress(request, headers, {
      task: '语义色任务', status: 'failed', terminalId: session.id,
    })
    const failedDot = taskCard.locator('.mon-dot.is-failed')
    await expect(failedDot).toHaveCount(1, { timeout: 10000 })
    expect(await failedDot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      await tierColor(page, 'status-failed'),
    )
  } finally {
    const h = await unlockHeaders(request)
    await request.delete(`${API_BASE}/api/terminals/${session.id}`, { headers: h })
  }
})
