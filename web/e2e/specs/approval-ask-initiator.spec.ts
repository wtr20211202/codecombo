import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批卡「先问发起者」（P-20261006-50）：pending 态裁决前对话入口——
 *   1. 「先问发起者」展开单行输入（预置「关于 <op>（审批 <id>）：」模板）→
 *      发送经 broadcast-write 写入发起会话（含 approvalId 的输入行，scrollback
 *      为证）→ 自动走 P-2 跳转链切至该会话（管理页激活）；审批保持 pending
 *      （提问不裁决）
 *   2. 发起会话已关闭/未知 → 按钮禁用降级（P-161 存活性数据源）
 *   3. Esc 收起输入行不发送（审批仍 pending）
 * 满种方式对齐 approval-jump.spec（API 造会话 + pending 审批，afterEach 清账
 * 防残留污染其他用例的 .aprv-card 计数）；会话创建走 API（纯终端 runtime，
 * 不拉起 claude TUI）。
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

/** 清理 pending 审批（卡片全局常驻，残留会污染后续用例的 .aprv-card 计数） */
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

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
})

test('先问发起者：发送含 approvalId 的问题到发起会话并自动跳转过去', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // API 造系统会话（纯终端 runtime，不拉起 claude TUI）+ 以其 id 造 pending 审批
  const created = await request.post(`${BASE}/api/terminals`, {
    headers, data: { kind: 'agent', name: 'appr-ask-agent', runtime: 'shell' },
  })
  expect(created.ok()).toBeTruthy()
  const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
  const session = ((tlist?.data || []) as { id: string; name: string }[])
    .find(s => s.name === 'appr-ask-agent')
  expect(session).toBeTruthy()

  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: session!.id, op: 'reset --hard', target: 'main', detail: 'e2e 先问发起者' },
  })
  expect(appr.ok()).toBeTruthy()
  const approvalId = ((await appr.json()) as { data: { id: string } }).data.id

  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('reset --hard')

  // 「先问发起者」可用（会话在列）→ 展开输入行，预置模板含 op 与 approvalId
  const askBtn = card.locator('[data-test="aprv-ask"]')
  await expect(askBtn).toBeEnabled({ timeout: 10000 })
  await askBtn.click()
  const askInput = card.locator('[data-test="aprv-ask-input"] input')
  await expect(askInput).toBeVisible()
  await expect(askInput).toHaveValue(new RegExp(`^关于 reset --hard（审批 ${approvalId}）：`))

  // 补问题后发送：会话收到含 approvalId 的输入行（scrollback 为证）+ 视图切至该会话
  await askInput.fill(`关于 reset --hard（审批 ${approvalId}）：为什么要回退 main？`)
  await card.locator('[data-test="aprv-ask-send"]').click()

  // P-2 跳转链：docked 管理页打开 + 对应会话激活（approval-jump.spec 同款断言）
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  const activeItem = view.locator('.ats-item.active')
  await expect(activeItem).toHaveCount(1, { timeout: 10000 })
  await expect(activeItem.locator('.ats-item-title')).toContainText('appr-ask-agent')
  await expect(view.locator('.xterm').first()).toBeVisible({ timeout: 15000 })

  // 目标会话 scrollback 收到含 approvalId 的输入行（PTY 回显为证）
  let echoed = false
  for (let i = 0; i < 10 && !echoed; i++) {
    await page.waitForTimeout(500)
    const sb = await request.get(`${BASE}/api/terminals/${session!.id}/scrollback`, { headers })
    echoed = (await sb.body()).toString('utf8').includes(approvalId)
  }
  expect(echoed, 'scrollback should echo the ask line containing the approvalId').toBeTruthy()

  // 提问不裁决：审批仍 pending（对话是裁决前动作）
  const polled = await request.get(`${BASE}/api/ops-confirm/${approvalId}`, { headers })
  expect(((await polled.json()) as { data: { status: string } }).data.status).toBe('pending')
})

test('发起会话已关闭：先问按钮禁用降级（P-161 存活性）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // 从未存在的会话 id（等价已关闭对账结果：列表对账后无此 id）
  const goneId = 'sc_e2e_gone_ask_session'
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: goneId, op: 'clean -fdx', target: '', detail: 'e2e 先问禁用' },
  })
  expect(appr.ok()).toBeTruthy()

  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  const askBtn = card.locator('[data-test="aprv-ask"]')
  await expect(askBtn).toBeVisible()
  await expect(askBtn).toBeDisabled({ timeout: 10000 })
})

test('Esc 收起提问输入行：不发送不裁决，审批保持 pending', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const created = await request.post(`${BASE}/api/terminals`, {
    headers, data: { kind: 'agent', name: 'appr-ask-esc', runtime: 'shell' },
  })
  expect(created.ok()).toBeTruthy()
  const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
  const session = ((tlist?.data || []) as { id: string; name: string }[])
    .find(s => s.name === 'appr-ask-esc')
  expect(session).toBeTruthy()

  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: session!.id, op: 'push --force', target: 'main', detail: 'e2e Esc 收起' },
  })
  expect(appr.ok()).toBeTruthy()
  const approvalId = ((await appr.json()) as { data: { id: string } }).data.id

  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  const askBtn = card.locator('[data-test="aprv-ask"]')
  await expect(askBtn).toBeEnabled({ timeout: 10000 })
  await askBtn.click()
  const askInput = card.locator('[data-test="aprv-ask-input"] input')
  await expect(askInput).toBeVisible()
  await askInput.press('Escape')
  await expect(card.locator('[data-test="aprv-ask-input"]')).toHaveCount(0)

  // 未发送未裁决：scrollback 无输入行 + 审批仍 pending
  const sb = await request.get(`${BASE}/api/terminals/${session!.id}/scrollback`, { headers })
  expect((await sb.body()).toString('utf8')).not.toContain(approvalId)
  const polled = await request.get(`${BASE}/api/ops-confirm/${approvalId}`, { headers })
  expect(((await polled.json()) as { data: { status: string } }).data.status).toBe('pending')
})
