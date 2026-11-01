import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 值班大屏卡片类目布局（P-20261004-18）E2E：
 *   - 编辑模式拖拽类目换序 → 服务端 uiState monitorBoard 落盘 → 刷新持久
 *   - 隐藏类目（眼睛开关）→ 无待处理项整块不渲染；播种 pending 审批 →
 *     自动临时置顶出现（橙高亮 + 注记徽标）→ 裁决清账后退场（防漏看护栏）
 * 配方同 monitor-dashboard（API 播种审批/会话）与 activity-bar-drag
 * （合成 DragEvent 序列打真实 handler；uiState 服务端状态经 expect.poll 判定）。
 * afterEach 清账防残留：uiState monitorBoard 键经 PATCH null 清除（键级补丁
 * null 清键语义），审批/会话照 monitor-dashboard 惯例清理
 */

async function unlockHeaders(request: import('@playwright/test').APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，防残留污染会话卡类目） */
async function cleanupTerminals(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 清理 pending 审批（审批全局广播，残留会污染类目 pending 判定） */
async function cleanupApprovals(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${API_BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** 清除大屏布局持久键（PATCH null 清键语义），用例间互不继承顺序/显隐 */
async function clearBoardLayout(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  await request.patch(`${API_BASE}/api/ui-state`, { headers, data: { local: { monitorBoard: null } } })
}

test.beforeEach(async ({ request }) => {
  await clearBoardLayout(request)
  await cleanupTerminals(request)
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await clearBoardLayout(request)
  await cleanupTerminals(request)
  await cleanupApprovals(request)
})

/** 卡墙类目块视觉序（DOM 序；instance 固定区恒在首位） */
function catOrder(page: Page): Promise<string[]> {
  return page.locator('main.mon-wall > section.mon-cat').evaluateAll(els =>
    els.map(e => (e.getAttribute('data-testid') || '').replace('monitor-cat-', '')))
}

/** 服务端 uiState monitorBoard 命名空间（即时写链路，落定即判） */
async function serverBoard(): Promise<{ cardOrder?: string[]; hiddenCards?: string[] } | undefined> {
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers: await unlockHeadersFn() })
  const body = (await res.json()) as { data?: { local?: { monitorBoard?: { cardOrder?: string[]; hiddenCards?: string[] } } } }
  return body.data?.local?.monitorBoard
}

/** 独立 fetch 版解锁头（expect.poll 闭包里没有 request fixture） */
async function unlockHeadersFn(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 派发完整行拖放序列（activity-bar-drag 同款：dragstart 打在源类目头真实
 *  handler 上，dragover/drop 打在目标类目块，dragend 收尾） */
async function dragCatTo(page: Page, srcId: string, dstId: string): Promise<void> {
  const src = await page.locator(`[data-testid="monitor-cat-head-${srcId}"]`).elementHandle()
  const dst = await page.locator(`[data-testid="monitor-cat-${dstId}"]`).elementHandle()
  await page.evaluate(([s, d]) => {
    const dt = new DataTransfer()
    s!.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    s!.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, [src, dst])
}

/** 「建议修改默认密码」提醒遮罩会拦点击（时序不定）——出现则点「稍后提醒」收起 */
async function dismissPwdTip(page: Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

test('编辑模式拖拽类目换序 → 服务端落盘 → 刷新持久', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  await dismissPwdTip(page)

  // 播种 pending 审批 + 会话：卡墙非空（查看态类目块可见）
  const headers = await unlockHeaders(request)
  const session = await createAgentSessionApi(request, { name: 'mon-layout-agent' })
  const appr = await request.post(`${API_BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: session.id, op: 'reset --hard', target: 'main', detail: 'layout e2e' },
  })
  expect(appr.ok()).toBeTruthy()

  // 内置序：instance 固定区恒首，五类目按注册表序（播种经广播对账，给足对账窗）
  await expect.poll(() => catOrder(page), { timeout: 10000 }).toEqual(['instance', 'fleet', 'approvals', 'asks', 'tasks', 'sessions'])

  // 进入编辑模式（提示条在场 = 编辑态可发现性），拖 approvals 到 sessions = 移到其前
  // （insert-before，活动栏拖拽同语义：approvals 落在 sessions 之前一位）
  await page.locator('[data-testid="monitor-edit-toggle"]').click()
  await expect(page.locator('[data-testid="monitor-edit-hint"]')).toBeVisible()
  await dragCatTo(page, 'approvals', 'sessions')
  await expect.poll(() => catOrder(page)).toEqual(['instance', 'fleet', 'asks', 'tasks', 'approvals', 'sessions'])

  // 拖拽反馈清理：源半透明与落点高亮随 dragend 退场
  await expect(page.locator('.mon-cat-head.is-dragging')).toHaveCount(0)
  await expect(page.locator('.mon-cat.is-drop-target')).toHaveCount(0)

  // 即时写落盘（不等防抖/关页）
  await expect.poll(serverBoard, { timeout: 10000 }).toHaveProperty('cardOrder', ['fleet', 'asks', 'tasks', 'approvals', 'sessions'])

  // 刷新持久：查看态按恢复的新序渲染（编辑态是会话态，刷新回到查看态）
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  await dismissPwdTip(page)
  await expect.poll(() => catOrder(page), { timeout: 10000 }).toEqual(['instance', 'fleet', 'asks', 'tasks', 'approvals', 'sessions'])
  await expect(page.locator('[data-testid="monitor-edit-hint"]')).toHaveCount(0)
})

test('隐藏类目防漏看护栏：无待处理不渲染，有新审批自动临时置顶，裁决后退场', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  await dismissPwdTip(page)

  // 编辑模式隐藏审批类目（此刻无审批）；隐藏注记在场（编辑态占位可恢复）
  await page.locator('[data-testid="monitor-edit-toggle"]').click()
  await page.locator('[data-testid="monitor-cat-eye-approvals"]').click()
  await expect(page.locator('[data-testid="monitor-cat-approvals"] .mon-cat-flag.is-hidden')).toBeVisible()
  await expect.poll(serverBoard, { timeout: 10000 }).toHaveProperty('hiddenCards', ['approvals'])

  // 退出编辑模式：隐藏类目无待处理 → 整块不渲染
  await page.locator('[data-testid="monitor-edit-toggle"]').click()
  await expect(page.locator('[data-testid="monitor-cat-approvals"]')).toHaveCount(0)

  // 播种 pending 审批 → 隐藏类目自动临时置顶出现（橙高亮 + 注记徽标，
  // 且位于活动类目区首位——先看到急事再看日常布局）
  const headers = await unlockHeaders(request)
  const session = await createAgentSessionApi(request, { name: 'mon-temp-agent' })
  const appr = await request.post(`${API_BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: session.id, op: 'deploy prod', target: 'main', detail: 'guardrail e2e' },
  })
  expect(appr.ok()).toBeTruthy()
  const apprId = ((await appr.json()) as { data?: { id?: string } }).data?.id || ''

  const tempSec = page.locator('[data-testid="monitor-cat-approvals"].is-temp')
  await expect(tempSec).toBeVisible({ timeout: 10000 })
  await expect(tempSec.locator('.mon-cat-flag.is-temp')).toContainText('临时置顶')
  await expect(tempSec.locator('.mon-card.is-approval')).toContainText('deploy prod')
  const order = await catOrder(page)
  expect(order[1]).toBe('approvals') // instance 固定区之后的第一个活动类目块

  // 允许一次 → 审批清账 → 护栏退场（隐藏类目重新隐没）
  await tempSec.getByRole('button', { name: '允许一次' }).click()
  await expect(page.locator('[data-testid="monitor-cat-approvals"]')).toHaveCount(0, { timeout: 5000 })
  const list = await (await request.get(`${API_BASE}/api/ops-confirm`, { headers })).json()
  const rec = ((list?.data || []) as { id: string; status: string }[]).find(x => x.id === apprId)
  expect(rec?.status).toBe('allowed')
})
