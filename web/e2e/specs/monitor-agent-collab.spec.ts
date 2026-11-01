import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 值班大屏 agent 协作流卡（P-20261008-6）E2E：
 * 触发闸/摘要截断/限流由 Go 单测锁定（server/api/agentchain + server/api/opsmessage），
 * 本用例锁真实服务端全链路 + 前端聚合面（纯事件驱动零轮询）：
 *   1. 会话 A → B 投递定向消息 → 大屏协作卡零刷新出现「A → B 留言」行
 *   2. B 拉取收件箱（拉取即读）→ 「已读」行出现
 *   3. 接续链触发（task.progress 终态观察者直驱）→ 「接续」行出现（含棒数徽标）
 *      + 链健康侧栏棒数/次数更新（chain.triggered 触发重读，免刷新）
 *   4. 行点击直达目标会话（P-68 通知 Action 同款跳转链）
 * 时间线三事件源是广播瞬时值、无历史查询端点（收件箱 GET 是 drain 语义），
 * 时间线断言全部「先开大屏再触发动作」；链清单可回填，侧栏先建链后开大屏
 * 亦可见。会话/链经共享实例 API 清理，不残留。
 */

const PREFIX = 'e2e-mc'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，防残留污染会话卡类目与时间线跳转面） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 清理本 spec 的链（按模板前缀圈定，不误删同实例其他用例的数据，agent-chain.spec 同口径） */
async function cleanupChains(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/agent-chains`, { headers })
  const list = ((await res.json()) as { data?: { id: string; promptTemplate?: string }[] }).data || []
  for (const c of list) {
    if (c.id && c.promptTemplate?.includes(PREFIX)) {
      await request.delete(`${API_BASE}/api/agent-chains/${c.id}`, { headers })
    }
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupChains(request)
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupChains(request)
  await cleanupTerminals(request)
})

test('留言/已读行实时出现 → 行点击直达目标会话', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const stamp = String(Date.now()).slice(-6)
  const a = await createAgentSessionApi(request, { name: `${PREFIX}-a-${stamp}` })
  const b = await createAgentSessionApi(request, { name: `${PREFIX}-b-${stamp}` })

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const card = page.locator('[data-testid="monitor-agent-collab-card"]')
  await expect(card).toBeVisible()
  // 常显卡空态：无事件时「尚无协作」常驻（isEmpty 守卫外渲染）
  await expect(card.locator('[data-testid="collab-stream-empty"]')).toBeVisible()

  // A → B 投递（X-Session-ID = A）→ 留言行零刷新出现（事件直通分发）
  const sent = await request.post(`${API_BASE}/api/ops-message`, {
    headers: { ...headers, 'X-Session-ID': a.id },
    data: { to: b.id, body: `${PREFIX}-${stamp} 配置在 scripts/test.env` },
  })
  expect(sent.ok()).toBeTruthy()
  const msgRow = card.locator('[data-testid="collab-row-message"]')
  await expect(msgRow).toHaveCount(1, { timeout: 10000 })
  await expect(msgRow).toContainText(`${PREFIX}-a-${stamp}`)
  await expect(msgRow).toContainText(`${PREFIX}-b-${stamp}`)
  await expect(msgRow).toContainText(`${PREFIX}-${stamp} 配置在 scripts/test.env`)

  // B 拉取收件箱（拉取即读）→ 已读行出现（读事实广播驱动）
  const inbox = await request.get(`${API_BASE}/api/ops-message`, {
    headers: { ...headers, 'X-Session-ID': b.id },
  })
  expect(inbox.ok()).toBeTruthy()
  const readRow = card.locator('[data-testid="collab-row-read"]')
  await expect(readRow).toHaveCount(1, { timeout: 10000 })
  await expect(readRow).toContainText(`${PREFIX}-b-${stamp}`)
  await expect(readRow).toContainText('已读 1 条留言')

  // 行点击直达目标会话：留言行 → 会话 B（系统会话回首页交 OPS 激活意图，
  // MonitorView.jumpSession 既有链——home overlay 展开且 B 在场）
  await msgRow.click()
  await page.waitForURL(u => !u.pathname.includes('/monitor'))
  await expect(page.locator('.agt-home-overlay')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.agt-home-overlay')).toContainText(`${PREFIX}-b-${stamp}`)
})

test('接续链触发 → 接续行（棒数徽标）+ 链健康侧栏更新', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const stamp = String(Date.now()).slice(-6)
  const a = await createAgentSessionApi(request, { name: `${PREFIX}-chain-${stamp}` })

  // 先建链后开大屏：侧栏走挂载回填（GET /api/agent-chains），验证「进大屏拉一次」
  const created = await request.post(`${API_BASE}/api/agent-chains`, {
    headers,
    data: { sourceTerminalId: a.id, promptTemplate: `${PREFIX}-relay-${stamp} 请继续` },
  })
  expect(created.ok()).toBeTruthy()
  const chainId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const card = page.locator('[data-testid="monitor-agent-collab-card"]')
  const chainRow = card.locator(`[data-testid="collab-chain-${chainId}"]`)
  await expect(chainRow).toBeVisible()
  await expect(chainRow).toContainText(`${PREFIX}-chain-${stamp}`)
  await expect(chainRow).toContainText('尚未触发')

  // 链源终态上报（观察者直驱，事件返回时触发已发生）→ 接续行零刷新出现
  await request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: {
      type: 'task.progress',
      payload: { task: `${PREFIX}-task-${stamp}`, status: 'done', step: 'fin', terminalId: a.id },
    },
  })
  const relayRow = card.locator('[data-testid="collab-row-chain"]')
  await expect(relayRow).toHaveCount(1, { timeout: 10000 })
  await expect(relayRow).toContainText(`${PREFIX}-chain-${stamp}`)
  // 棒数徽标 = triggerCount + 1（首触拉起第 2 棒）；行渲染与链清单重读竞速，
  // 重读落地前可短暂无徽标，最终一致即可
  await expect(relayRow).toContainText('第 2 棒', { timeout: 10000 })
  // 链健康侧栏随 chain.triggered 触发的重读更新（免刷新）：棒数/次数/冷却注记
  await expect(chainRow).toContainText('走到第 2 棒', { timeout: 10000 })
  await expect(chainRow).toContainText('触发 1 次')
  await expect(chainRow).toContainText('冷却中')

  // 接续行点击 → 直达下一棒会话（新拉起的接力会话，摘要名含模板渲染文本）
  await relayRow.click()
  await page.waitForURL(u => !u.pathname.includes('/monitor'))
  await expect(page.locator('.agt-home-overlay')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.agt-home-overlay')).toContainText(`${PREFIX}-relay-${stamp}`)
})
