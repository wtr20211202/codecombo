import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 关闭有 pending 审批会话的警示（P-20261003-275）：会话有等待裁决的审批时，
 * 各关闭确认弹层正文附加警示行「该会话有正在等待裁决的审批——关闭后 agent
 * 将一直等不到裁决」——关闭即裁决永不到来（agent 白等至 TTL 兜底）：
 *   1. 管理页悬浮 tab × 关闭 pending 会话：确认弹窗含警示，取消不关
 *   2. 管理页悬浮 tab × 关闭普通会话：无警示（普通确认回归面），确认即关
 *   3. 侧栏右键「结束会话」pending 会话：确认弹窗含警示
 *   4. 底部终端 tab × 关闭挂 pending 的项目会话：警示随 pending 清账实时消失
 *      （同一弹层先含警示，裁决后再开即无警示）
 * pending 审批经 POST /api/ops-confirm 携 sessionId 造（与终端会话 id 同域），
 * 清账纪律同 approval-seed/agent-terminal（.aprv-card 全局常驻防残留污染）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
/** 警示行文案锚（fixedLocale=zh；键 terminal.closeConfirmPendingApproval 子串） */
const WARNING = '等待裁决的审批'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部终端会话（agent + 项目会话都清，服务端全局共享保确定性） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 清账 pending 审批（跨用例共享服务端状态，.aprv-card 计数纪律） */
async function cleanupPendingApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** API 造挂在指定会话上的 pending 审批（sessionId 与终端会话 id 同域） */
async function createPendingFor(request: APIRequestContext, sessionId: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers, data: { sessionId, op: 'close-warn-e2e reset --hard', target: 'main', detail: 'e2e 关闭警示' },
  })
  expect(res.ok()).toBeTruthy()
  const body = ((await res.json()) as { data?: { id?: string } }).data
  expect(body?.id).toBeTruthy()
  return body!.id!
}

/** 进入项目页（活动栏宿主挂载前置） */
async function enterProject(page: Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
}

/** 进项目页并打开 docked 管理页（侧栏/悬浮窗操作前置） */
async function enterAgentManager(page: Page) {
  await enterProject(page)
  const railBtn = page.locator('.rail-btn[title="终端会话管理"]')
  await railBtn.click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupPendingApprovals(request)
})

test('管理页 tab × 关闭 pending 会话：确认弹窗附警示，取消不关', async ({ page, request }) => {
  test.setTimeout(90000)
  await fixedLocale(page)
  const view = await enterAgentManager(page)

  // 两个会话（单会话无 tab 条，悬浮 tab × 需 ≥2）；pending 挂在第二个上
  await createAgentSessionApi(request, { name: 'close-warn-a' })
  const second = await createAgentSessionApi(request, { name: 'close-warn-b' })
  await createPendingFor(request, second.id)
  await expect(view.locator('.ats-item')).toHaveCount(2, { timeout: 10000 })

  // 悬浮窗 tab × 关第二个（pending 会话）
  await view.locator('.atv-header-actions [title="在悬浮窗中打开"]').click()
  const floatBox = page.locator('.atv-root.is-float')
  await expect(floatBox.locator('.agt-tab')).toHaveCount(2, { timeout: 10000 })
  await floatBox.locator('.agt-tab').nth(1).locator('.agt-tab-close').click()

  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(dialog).toContainText('确认结束「close-warn-b」')
  await expect(dialog).toContainText(WARNING)

  // 取消：会话原样保留（警示只增知情不改语义）
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await expect(floatBox.locator('.agt-tab')).toHaveCount(2, { timeout: 5000 })
})

test('管理页 tab × 关闭普通会话：无警示行，确认即关', async ({ page, request }) => {
  test.setTimeout(90000)
  await fixedLocale(page)
  const view = await enterAgentManager(page)

  const first = await createAgentSessionApi(request, { name: 'close-plain-a' })
  const second = await createAgentSessionApi(request, { name: 'close-plain-b' })
  await expect(view.locator('.ats-item')).toHaveCount(2, { timeout: 10000 })

  await view.locator('.atv-header-actions [title="在悬浮窗中打开"]').click()
  const floatBox = page.locator('.atv-root.is-float')
  await expect(floatBox.locator('.agt-tab')).toHaveCount(2, { timeout: 10000 })
  await floatBox.locator('.agt-tab').nth(1).locator('.agt-tab-close').click()

  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(dialog).toContainText('确认结束「close-plain-b」')
  await expect(dialog).not.toContainText(WARNING)

  // 确认：普通会话关闭语义不变——被关会话从服务端消失、另一会话存活
  // （服务端列表为权威对账；关掉一个后剩单会话 tab 条隐藏，UI 形态断言
  // 归 agent-terminal.spec 基础链）
  await dialog.getByRole('button', { name: '确认' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await expect(floatBox.locator('.agt-tab')).toHaveCount(0, { timeout: 10000 })
  await expect.poll(async () => {
    const headers = await unlockHeaders(request)
    const res = await request.get(`${BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string }[] }).data || []
    return `${list.some(s => s.id === second.id)}:${list.some(s => s.id === first.id)}`
  }, { timeout: 10000 }).toBe('false:true')
})

test('侧栏右键「结束会话」pending 会话：确认弹窗附警示', async ({ page, request }) => {
  test.setTimeout(90000)
  await fixedLocale(page)
  const view = await enterAgentManager(page)

  const s = await createAgentSessionApi(request, { name: 'close-warn-ctx' })
  await createPendingFor(request, s.id)
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 10000 })

  // 侧栏会话行右键 → 结束会话（useAgentTerminalGroups.onSessionAction 面）
  await view.locator('.ats-item').filter({ hasText: 'close-warn-ctx' }).click({ button: 'right' })
  await page.locator('.n-dropdown-option-body').filter({ hasText: '结束会话' }).click()

  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(dialog).toContainText('确认结束「close-warn-ctx」')
  await expect(dialog).toContainText(WARNING)

  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 5000 })
})

test('底部终端 tab ×：警示随 pending 清账实时消失（先警示后普通）', async ({ page, request }) => {
  test.setTimeout(90000)
  await fixedLocale(page)

  // 建项目 shell 会话（底部 tab 形态）+ 挂 pending 审批
  const headers = await unlockHeaders(request)
  const pres = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await pres.json()) as { data?: { id: string; name: string }[] }).data || []
  const projectId = projects.find(x => x.name === 'simple-coding')?.id || ''
  expect(projectId).not.toBe('')
  const cres = await request.post(`${BASE}/api/terminals`, {
    headers, data: { projectId, name: 'close-warn-shell' },
  })
  expect(cres.ok()).toBeTruthy()
  const shellId = ((await cres.json()) as { data?: { id?: string } }).data?.id || ''
  expect(shellId).not.toBe('')
  // 挂 pending 审批（进页前落账，挂载 seedPending 回填卡堆与 pendingSessionIds）
  await createPendingFor(request, shellId)

  await enterProject(page)
  // 审批卡在场 = approvals store 已持有该 pending（警示判定的前置事实）
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  // 打开底部终端面板（Ctrl+` 循环归一，uiState 跑序幂等）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.keyboard.press('Control+`')
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.term-toolbar')).toBeVisible()
  // 创建广播 → 底部 tab 对账追加（kind=shell 进项目 tab 表）
  await expect(page.locator('.term-tab').filter({ hasText: 'close-warn-shell' })).toHaveCount(1, { timeout: 10000 })

  // × 关闭：确认弹窗含警示行（TerminalCloseConfirm 面）
  const tab = page.locator('.term-tab').filter({ hasText: 'close-warn-shell' })
  await tab.locator('.term-close-btn').click()
  const dialog = page.locator('.n-modal')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(dialog).toContainText(WARNING)
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })

  // 裁决清账（approval.resolved 广播 → store pending 清空）→ 再开确认弹窗：
  // 警示实时消失，普通确认语义。卡堆消失 = 广播清账落定的确定性同步点
  const pending = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await pending.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
  await expect(page.locator('.aprv-card')).toHaveCount(0, { timeout: 10000 })
  await tab.locator('.term-close-btn').click()
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(dialog).not.toContainText(WARNING)
  await dialog.getByRole('button', { name: '确认' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await expect(page.locator('.term-tab').filter({ hasText: 'close-warn-shell' })).toHaveCount(0, { timeout: 10000 })
})
