import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 值班大屏（P-20261001-5）E2E：
 *   - 首页头部入口 → /monitor 全屏卡片墙；机群空闲时显示空态
 *   - 审批卡：API 播种 pending（POST /ops-confirm）→ 卡片墙渲染 → 允许一次
 *     裁决 → 卡片消失 + 服务端留痕 allowed；全局固定审批堆在大屏路由让位
 *   - 任务进度卡：/api/ops-notify 播种 task.progress（带 terminalId 会话归属）
 *     → WS 实时渲染 → done 上报后状态徽标翻转为已完成
 *   - 终端会话卡：页面打开后 API 建会话 → terminals.changed 广播 → 卡片实时出现
 * 满种方式对齐 approval-jump.spec（API 造 pending / 会话）；afterEach 清账防残留
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

/** 清理 pending 审批（审批全局广播，残留会污染后续用例的卡片计数） */
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

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
})

// API 造纯终端系统会话统一走共享层 createAgentSessionApi（e2e-api，P-20261004-48）：
// runtime=shell 不拉起 claude TUI，dir 缺省自动建临时目录

test('首页入口 → /monitor 卡片墙 + 机群空闲空态', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)

  // 首页头部「值班大屏」入口按钮
  const entry = page.locator('.home-action-btn[title="值班大屏"]')
  await expect(entry).toBeVisible()
  await entry.click()
  await page.waitForURL('**/monitor')

  // 全屏卡片墙渲染（无侧栏/顶栏的独立路由）+ 空态（beforeEach 已清账）
  await expect(page.locator('.mon-root')).toBeVisible()
  await expect(page.locator('.mon-head-text')).toContainText('值班大屏')
  await expect(page.locator('.mon-empty')).toContainText('机群空闲')
  // 全局固定审批堆在大屏路由让位（大屏审批卡在墙内渲染）
  await expect(page.locator('.aprv-stack')).toHaveCount(0)
})

test('审批卡：播种 pending → 卡片墙渲染 → 允许一次裁决', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)

  const session = await createAgentSessionApi(request, { name: 'mon-appr-agent' })
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: session.id, op: 'reset --hard', target: 'main', detail: 'e2e 大屏审批验证' },
  })
  expect(appr.ok()).toBeTruthy()
  const apprId = ((await appr.json()) as { data?: { id?: string } }).data?.id || ''

  // 卡片墙渲染审批卡（op + 发起会话徽标）
  const card = page.locator('.mon-card.is-approval')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('reset --hard')
  await expect(card).toContainText('mon-appr-agent')

  // 允许一次 → 卡片消失（本地清账 + resolved 广播回流）+ 服务端留痕
  await card.getByRole('button', { name: '允许一次' }).click()
  await expect(card).toHaveCount(0, { timeout: 5000 })
  const list = await (await request.get(`${BASE}/api/ops-confirm`, { headers })).json()
  const rec = ((list?.data || []) as { id: string; status: string }[]).find(x => x.id === apprId)
  expect(rec?.status).toBe('allowed')
})

test('任务进度卡：task.progress 播种 → WS 实时渲染 → done 翻转', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)

  const session = await createAgentSessionApi(request, { name: 'mon-progress-agent' })

  // 带会话归属的运行中进度上报（ops-notify → ops-channel → bySession）
  await request.post(`${BASE}/api/ops-notify`, {
    headers,
    data: {
      type: 'task.progress',
      payload: { task: '重构监控大屏', step: '编辑 MonitorView.vue', status: 'running', terminalId: session.id },
    },
  })

  const taskCard = page.locator('.mon-card.is-task')
  await expect(taskCard).toHaveCount(1, { timeout: 10000 })
  await expect(taskCard).toContainText('重构监控大屏')
  await expect(taskCard).toContainText('编辑 MonitorView.vue')
  await expect(taskCard).toContainText('运行中')
  await expect(taskCard).toContainText('mon-progress-agent')

  // done 上报 → 状态徽标翻转（卡片保留，展示最近一次结果）
  await request.post(`${BASE}/api/ops-notify`, {
    headers,
    data: {
      type: 'task.progress',
      payload: { task: '重构监控大屏', step: '', status: 'done', terminalId: session.id },
    },
  })
  await expect(taskCard).toContainText('已完成', { timeout: 10000 })
})

test('终端会话卡：页面打开后建会话 → 广播实时出现', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)

  // 大屏已打开 → API 建会话（terminals.changed 广播对账，无需刷新）
  await createAgentSessionApi(request, { name: 'mon-sess-agent' })

  const card = page.locator('.mon-card.is-session').filter({ hasText: 'mon-sess-agent' })
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('系统会话')
})
