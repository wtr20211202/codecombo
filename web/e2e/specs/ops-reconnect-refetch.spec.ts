import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, waitForAppReady } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * ops 通道断线重连后集中补拉注册表遍历 E2E（P-20261003-236）
 *
 * 动机：ops 通道断线窗口期的 approval.pending 广播不可回放；重连成功后
 * OpsChannelBridge watch connected false→true 触发 runReconnectRefetches()
 * （P-20261003-236 集中注册表全表遍历），approvals 域 seedPending 补账入卡堆。
 * 迁移前该触发点只手写审批+提问两域——本用例同时守护「迁移后触发链完好」。
 *
 * 断连模拟沿用 ws-reconnect-refetch 既有范式：routeWebSocket 截胡
 * /ws/ops-channel（连接即 close），恢复时放行直通 + window 'online' 事件触发
 * useOpsChannel.handleRecovery 立即重连。只截 ops WS，项目/通知 WS 与全部
 * HTTP API 不受影响。断言聚焦最小面：断连期造的 pending 审批在重连后自动
 * 出现在全局卡片堆（期间零交互——重连后新数据的唯一来源是注册表补拉）。
 *
 * 页面停在首页（/）：Layout 未加载 → project 域未注册，注册表恰含 App 级
 * 常驻域（approvals/asks/notification/terminals），断言面与 ops 通道触发直接对齐。
 */

const OPS_WS_PATTERN = /\/ws\/ops-channel$/

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// afterAll 不能用 test 级 request fixture（ws-reconnect-refetch 同款收尾）：
// 用裸 fetch 复刻解锁头
async function unlockHeadersFetch(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理 pending 审批（卡片全局常驻，残留会污染后续用例的 .aprv-card 计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${API_BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** API 造 pending 审批（op 文本会出现在卡片上，作断言锚点） */
async function createPending(request: APIRequestContext, op: string): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/ops-confirm`, {
    headers, data: { op, target: 'main', detail: 'ops-reconnect e2e' },
  })
  expect(res.ok()).toBeTruthy()
}

/** 进入首页并装好 ops WS 截胡（offline 期）。返回恢复函数：放行新连接直通 */
async function enterOffline(page: Page): Promise<() => void> {
  let offline = true
  await page.routeWebSocket(OPS_WS_PATTERN, ws => {
    if (offline) {
      void ws.close()
      return
    }
    void ws.connectToServer()
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await waitForAppReady(page)
  return () => { offline = false }
}

/** 恢复路由 + 'online' 事件触发立即重连（handleRecovery 恢复触发器） */
async function reconnect(page: Page, goOnline: () => void) {
  goOnline()
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
}

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test.afterAll(async () => {
  const headers = await unlockHeadersFetch()
  const res = await fetch(`${API_BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await fetch(`${API_BASE}/api/ops-confirm/${a.id}/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ allow: true, always: false }),
    })
  }
})

test('断连窗口期的 pending 审批在 ops 通道重连后自动入卡堆（无任何交互）', async ({ page, request }) => {
  test.setTimeout(60000)
  const goOnline = await enterOffline(page)
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(0)

  // 断连窗口期造 pending：approval.pending 广播落空（WS 已断，不可回放），
  // 且此时无任何重连发生——卡片出现的唯一路径是重连后的注册表补拉
  const op = `ops-reconnect-e2e df -h ${Date.now()}`
  await createPending(request, op)
  await page.waitForTimeout(1500)
  await expect(card).toHaveCount(0)

  // 恢复路由 → 立即重连 → connected false→true → 注册表全表遍历 → 审批域
  // seedPending 补账 → 卡片自动入堆（期间零交互、零事件）
  await reconnect(page, goOnline)
  await expect(card.filter({ hasText: op })).toHaveCount(1, { timeout: 15000 })
})
