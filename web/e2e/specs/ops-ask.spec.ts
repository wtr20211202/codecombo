import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 智能体结构化提问全链路（P-20261001-27）：
 *   POST /api/ops-ask（播种提问，等同 agent 发起）→ 全局提问卡片（.ask-card）
 *   → 用户作答（自由文本/选项按钮双形态）→ 卡片消失 →
 *   GET /api/ops-ask/:id 轮询到 answered + answer（agent 侧取答案闭环）。
 *   值班大屏（/monitor）同步呈现提问卡并可作答（冷启动补账路径）。
 * 播种用 API（curl 同款），作答后轮询断言走 API——与 agent 轮询语义一致；
 * afterEach 清账防残留（卡片全局常驻，pending 会污染后续用例）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 播种一条提问，返回记录 id */
async function seedAsk(
  request: APIRequestContext,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-ask`, { headers, data: body })
  expect(res.ok()).toBeTruthy()
  const created = (await res.json()) as { data?: { id?: string } }
  expect(created?.data?.id).toBeTruthy()
  return created.data!.id
}

/** 清理 pending 提问（作答清账，卡片即消失；答案以先到者为准） */
async function cleanupAsks(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-ask`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-ask/${a.id}/answer`, {
      headers, data: { answer: 'cleanup' },
    })
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupAsks(request)
})

test('自由文本提问：播种 → 卡片出现 → 输入作答 → 卡片消失 → 轮询取到答案', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedAsk(request, headers, {
    question: '缺 STAGING_DATABASE_URL 的值，请提供（e2e 自由文本）',
  })

  // WS 广播 → 全局提问卡片出现（问题全文 + 提交入口）
  const card = page.locator('.ask-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('STAGING_DATABASE_URL')

  // 作答：输入 + 提交
  await card.locator('.ask-input input').fill('postgres://localhost/e2e')
  await card.getByRole('button', { name: '提交' }).click()

  // 卡片消失 + 轮询侧（agent 语义）取到答案
  await expect(card).toHaveCount(0, { timeout: 5000 })
  const poll = await (await request.get(`${BASE}/api/ops-ask/${id}`, { headers })).json()
  expect(poll?.data?.status).toBe('answered')
  expect(poll?.data?.answer).toBe('postgres://localhost/e2e')
})

test('选项提问：播种带 options → 点选按钮作答 → 答案为选项原文', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedAsk(request, headers, {
    question: '检测到未推送提交，直接推送还是先变基？（e2e 选项）',
    options: ['直接推送', '先变基'],
  })

  const card = page.locator('.ask-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('先变基')

  // 选项形态无输入框，按钮即答案
  await expect(card.locator('.ask-input')).toHaveCount(0)
  await card.locator('.ask-option', { hasText: '先变基' }).click()

  await expect(card).toHaveCount(0, { timeout: 5000 })
  const poll = await (await request.get(`${BASE}/api/ops-ask/${id}`, { headers })).json()
  expect(poll?.data?.status).toBe('answered')
  expect(poll?.data?.answer).toBe('先变基')
})

test('值班大屏：提问卡呈现并作答（冷启动补账路径）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)

  // 大屏常在提问产生之后才打开：先播种再进入，走挂载期 GET /ops-ask 补账
  const id = await seedAsk(request, headers, {
    question: '值班大屏联动验证：请确认发布窗口',
    options: ['窗口 A', '窗口 B'],
  })
  await gotoAndUnlock(page, '/monitor')

  const card = page.locator('.mon-card.is-ask')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('发布窗口')

  await card.locator('button', { hasText: '窗口 B' }).click()
  await expect(card).toHaveCount(0, { timeout: 5000 })
  const poll = await (await request.get(`${BASE}/api/ops-ask/${id}`, { headers })).json()
  expect(poll?.data?.status).toBe('answered')
  expect(poll?.data?.answer).toBe('窗口 B')
})
